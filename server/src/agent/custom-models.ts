/**
 * Custom model servers: Pi's `models.json` in Kady's agent dir.
 *
 * `ModelRuntime.create` reads `<agentDir>/models.json` and `refresh()`
 * re-reads it, so a provider added here becomes a first-class Pi provider
 * (its models get `Model.provider === "<id>"`) without a restart. This lets a
 * lab point Kady at an institutional vLLM/HPC gateway with real pricing,
 * context window and thinking metadata — unlike the $0 Ollama/LM Studio paths.
 *
 * Kady tracks the providers it wrote in a sidecar manifest so a models.json
 * the user shares with a standalone Pi keeps its hand-written providers: a
 * PUT replaces only Kady-managed entries. Provider ids must not collide with
 * providers Kady already knows (catalogue, OAuth, OpenRouter, local servers).
 *
 * Billing: custom providers are `payg` at their declared cost (`billing.ts`
 * default), so a $0-priced local server ledgers $0 and a priced gateway counts
 * toward the project cap.
 */
import fs from "node:fs";
import path from "node:path";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { isDirectProvider } from "./provider-catalog.ts";
import { isSubscriptionProvider, tierFor, type ClientDirectModel } from "./provider-auth.ts";

export const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const CUSTOM_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomModelApi = (typeof CUSTOM_MODEL_APIS)[number];
const RESERVED_PROVIDER_IDS = new Set(["openrouter", "ollama", "openai-compatible", "fusion", "nvidia", "modal", "kady"]);
const MAX_PROVIDERS = 20;
const MAX_MODELS_PER_PROVIDER = 100;

/**
 * Every key Pi's `ThinkingLevelMap` may carry, in Pi's own order.
 *
 * `off` is a map key but not a `ThinkingLevel`: Pi reads `map.off !== null` to
 * decide whether thinking may be turned off at all, so a model that cannot
 * disable thinking says so here.
 */
const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Pi's per-model `compat.forceAdaptiveThinking`, narrowed to the one field
 * custom servers need.
 *
 * Pi's Anthropic adapter has two thinking paths: a token budget derived from
 * the level (`thinking.budget_tokens`), or adaptive thinking with
 * `output_config.effort`. The budget path runs every level through
 * `clampReasoning()`, which folds `xhigh` and `max` down to `high` — so a
 * custom gateway that does understand a top effort can never receive one.
 * Setting this sends the effort path instead, where `thinkingLevelMap` is
 * consulted verbatim.
 *
 * Deliberately not the whole `AnthropicMessagesCompat` surface: the other
 * fields describe wire quirks (cache control, strict tools) that Kady cannot
 * verify for an arbitrary gateway, and a wrong one fails the request rather
 * than degrading.
 */
export interface CustomModelCompat {
  forceAdaptiveThinking?: boolean;
}

export interface CustomModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  /**
   * USD per million tokens, Pi's convention.
   */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * Level → provider-specific effort string, passed straight to Pi.
   *
   * Two things depend on this. `getSupportedThinkingLevels()` reports
   * `xhigh`/`max` as unavailable unless the model maps them to something, so
   * without an entry Pi clamps the requested level before the request is
   * built; and on the effort path `mapThinkingLevelToEffort()` consults this
   * map before its built-in switch. `null` marks a level unsupported.
   */
  thinkingLevelMap?: ThinkingLevelMap;
  /** Wire-format overrides; see `CustomModelCompat`. */
  compat?: CustomModelCompat;
}

/** Levels a map may name, for callers that render or validate one. */
export const CUSTOM_THINKING_LEVEL_KEYS = THINKING_LEVEL_KEYS;

export interface CustomProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomModelApi;
  /** Literal key, `$ENV_VAR`, or empty for keyless servers (Pi needs *something*; we write "none"). */
  apiKey?: string;
  models: CustomModelDefinition[];
}

export interface CustomProviderListing extends CustomProvider {
  /** Written by Kady (editable) vs hand-written in models.json (read-only here). */
  managed: boolean;
}

/**
 * What GET /custom-models returns: a literal key is never echoed (like
 * GET /credentials), only whether one is saved and a recognizable mask. An
 * `$ENV_VAR` reference is not a secret and is returned as written.
 */
export interface PublicCustomProvider extends Omit<CustomProviderListing, "apiKey"> {
  apiKey?: string;
  apiKeySaved?: boolean;
  apiKeyMasked?: string;
}

/** Submitted provider: `keepApiKey` re-uses the saved key the UI never saw. */
export interface CustomProviderInput extends CustomProvider {
  keepApiKey?: boolean;
}

const ENV_REF_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/** Pi reads `apiKey` as a template (`$VAR`, `${VAR}`) or, with a leading `!`, a shell command. */
export function isEnvReference(value: string): boolean {
  return ENV_REF_RE.test(value);
}

/**
 * Store a value typed into the UI the way Pi will read it back verbatim: a
 * whole-value `$VAR` stays a reference; anything else is a literal, so `$`
 * becomes `$$` and a leading `!` becomes `$!`. Otherwise a pasted key with a
 * `$` in it would be mangled, and `!curl …` would run as a shell command
 * whenever the model's auth resolves. Command-backed keys (`!op read …`) are
 * still supported in a hand-written models.json.
 */
export function encodeApiKeyForPi(value: string): string {
  if (isEnvReference(value)) return value;
  const escaped = value.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Listing safe to send to the browser. */
export function publicCustomProviders(agentDir = KADY_PI_AGENT_DIR): PublicCustomProvider[] {
  return listCustomProviders(agentDir).map(({ apiKey, ...rest }) => {
    if (!apiKey || apiKey === "none") return rest;
    if (isEnvReference(apiKey)) return { ...rest, apiKey };
    if (apiKey.startsWith("!")) return { ...rest, apiKeySaved: true, apiKeyMasked: "(shell command)" };
    return { ...rest, apiKeySaved: true, apiKeyMasked: maskKey(apiKey.replace(/\$([$!])/g, "$1")) };
  });
}

export function modelsJsonPath(agentDir = KADY_PI_AGENT_DIR): string {
  return path.join(agentDir, "models.json");
}

function manifestPath(agentDir = KADY_PI_AGENT_DIR): string {
  return path.join(agentDir, "kady-custom-models.json");
}

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

/**
 * Read a `thinkingLevelMap` off disk or off the wire.
 *
 * Lenient on purpose: this runs on values the user typed into models.json by
 * hand, and dropping the whole map over one stray key would take the working
 * levels with it. Unknown keys are ignored, a non-string non-null value for a
 * known key is ignored, and a map that ends up empty disappears entirely so
 * the model reads exactly like a model that never had one.
 */
function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  const raw = asRecord(value);
  const out: ThinkingLevelMap = {};
  for (const level of THINKING_LEVEL_KEYS) {
    const entry = raw[level];
    if (typeof entry === "string") out[level] = entry;
    else if (entry === null) out[level] = null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read `compat` off disk or off the wire.
 *
 * Only the one field Kady models is carried; see `CustomModelCompat` for why
 * the rest of Pi's compat surface stays out of reach here.
 */
function parseCompat(value: unknown): CustomModelCompat | undefined {
  const raw = asRecord(value);
  return typeof raw.forceAdaptiveThinking === "boolean"
    ? { forceAdaptiveThinking: raw.forceAdaptiveThinking }
    : undefined;
}

/** Validate one model's `thinkingLevelMap` from a submitted payload. */
function validateThinkingLevelMap(
  value: unknown,
  where: string,
): ThinkingLevelMap | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return `${where}: thinkingLevelMap must be an object`;
  const raw = value as Rec;
  const out: ThinkingLevelMap = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!(THINKING_LEVEL_KEYS as readonly string[]).includes(key)) {
      return `${where}: unknown thinking level "${key}" (expected ${THINKING_LEVEL_KEYS.join(", ")})`;
    }
    if (entry !== null && typeof entry !== "string") {
      return `${where}: thinkingLevelMap.${key} must be a string or null`;
    }
    if (typeof entry === "string" && entry.length > 64) return `${where}: thinkingLevelMap.${key} is too long`;
    out[key as (typeof THINKING_LEVEL_KEYS)[number]] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate one model's `compat` from a submitted payload. */
function validateCompat(value: unknown, where: string): CustomModelCompat | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return `${where}: compat must be an object`;
  const raw = value as Rec;
  const unknown = Object.keys(raw).filter((key) => key !== "forceAdaptiveThinking");
  if (unknown.length > 0) return `${where}: unsupported compat field(s) ${unknown.join(", ")}`;
  if (raw.forceAdaptiveThinking !== undefined && typeof raw.forceAdaptiveThinking !== "boolean") {
    return `${where}: compat.forceAdaptiveThinking must be a boolean`;
  }
  return typeof raw.forceAdaptiveThinking === "boolean" ? { forceAdaptiveThinking: raw.forceAdaptiveThinking } : undefined;
}

function readJson(file: string): Rec | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

function managedIds(agentDir = KADY_PI_AGENT_DIR): Set<string> {
  const manifest = readJson(manifestPath(agentDir)) ?? {};
  return new Set(Array.isArray(manifest.managed) ? manifest.managed.filter((x): x is string => typeof x === "string") : []);
}

function providerFromJson(id: string, raw: Rec): CustomProvider {
  const models = Array.isArray(raw.models) ? raw.models : [];
  return {
    id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    api: (CUSTOM_MODEL_APIS as readonly string[]).includes(String(raw.api)) ? (raw.api as CustomModelApi) : "openai-completions",
    ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}),
    models: models
      .map((m) => asRecord(m))
      .filter((m) => typeof m.id === "string")
      .map((m) => {
        const thinkingLevelMap = parseThinkingLevelMap(m.thinkingLevelMap);
        const compat = parseCompat(m.compat);
        return {
          id: m.id as string,
          ...(typeof m.name === "string" ? { name: m.name } : {}),
          ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
          ...(Array.isArray(m.input) ? { input: m.input.filter((x): x is "text" | "image" => x === "text" || x === "image") } : {}),
          ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
          ...(m.cost && typeof m.cost === "object"
            ? {
                cost: {
                  input: Number(asRecord(m.cost).input ?? 0),
                  output: Number(asRecord(m.cost).output ?? 0),
                  cacheRead: Number(asRecord(m.cost).cacheRead ?? 0),
                  cacheWrite: Number(asRecord(m.cost).cacheWrite ?? 0),
                },
              }
            : {}),
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          ...(compat ? { compat } : {}),
        };
      }),
  };
}

/** Every provider in models.json, flagged managed/foreign. Malformed file → []. */
export function listCustomProviders(agentDir = KADY_PI_AGENT_DIR): CustomProviderListing[] {
  const file = readJson(modelsJsonPath(agentDir));
  if (!file) return [];
  const managed = managedIds(agentDir);
  return Object.entries(asRecord(file.providers)).map(([id, raw]) => ({
    ...providerFromJson(id, asRecord(raw)),
    managed: managed.has(id),
  }));
}

let idCache: { mtimeMs: number; ids: Set<string> } | null = null;

/** Provider ids defined in models.json, cached by file mtime (hot path: ref parsing). */
export function customProviderIds(agentDir = KADY_PI_AGENT_DIR): Set<string> {
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(modelsJsonPath(agentDir)).mtimeMs;
  } catch {
    idCache = { mtimeMs: -1, ids: new Set() };
    return idCache.ids;
  }
  if (idCache && idCache.mtimeMs === mtimeMs) return idCache.ids;
  const ids = new Set(Object.keys(asRecord((readJson(modelsJsonPath(agentDir)) ?? {}).providers)));
  idCache = { mtimeMs, ids };
  return ids;
}

export function isCustomProvider(providerId: string, agentDir = KADY_PI_AGENT_DIR): boolean {
  return customProviderIds(agentDir).has(providerId);
}

export function customProviderName(providerId: string, agentDir = KADY_PI_AGENT_DIR): string {
  const raw = asRecord(asRecord((readJson(modelsJsonPath(agentDir)) ?? {}).providers)[providerId]);
  return typeof raw.name === "string" && raw.name.trim() ? raw.name : providerId;
}

/** Validate a submitted provider list; returns normalized providers or an error string. */
export function validateCustomProviders(input: unknown): CustomProviderInput[] | string {
  if (!Array.isArray(input)) return "providers must be an array";
  if (input.length > MAX_PROVIDERS) return `at most ${MAX_PROVIDERS} custom providers`;
  const out: CustomProviderInput[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const p = asRecord(raw);
    const id = String(p.id ?? "").trim();
    if (!CUSTOM_PROVIDER_ID_RE.test(id)) return `invalid provider id "${id}" (lowercase letters, digits, dashes; 2–41 chars)`;
    if (RESERVED_PROVIDER_IDS.has(id) || isDirectProvider(id) || isSubscriptionProvider(id)) {
      return `provider id "${id}" is already a built-in Kady provider`;
    }
    if (seen.has(id)) return `duplicate provider id "${id}"`;
    seen.add(id);
    const baseUrl = String(p.baseUrl ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return `provider "${id}": baseUrl must be an http(s) URL`;
    const api = String(p.api ?? "openai-completions");
    if (!(CUSTOM_MODEL_APIS as readonly string[]).includes(api)) {
      return `provider "${id}": api must be one of ${CUSTOM_MODEL_APIS.join(", ")}`;
    }
    const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    if (apiKey.length > 512) return `provider "${id}": apiKey is too long`;
    if (/[\x00-\x1f\x7f]/.test(apiKey)) return `provider "${id}": apiKey contains control characters`;
    // The access token is inherited by child processes, not a provider key.
    if (isEnvReference(apiKey) && /^\$\{?KADY_/.test(apiKey)) {
      return `provider "${id}": apiKey may not reference Kady's own variables`;
    }
    const keepApiKey = !apiKey && p.keepApiKey === true;
    if (!Array.isArray(p.models) || p.models.length === 0) return `provider "${id}": at least one model is required`;
    if (p.models.length > MAX_MODELS_PER_PROVIDER) return `provider "${id}": at most ${MAX_MODELS_PER_PROVIDER} models`;
    const models: CustomModelDefinition[] = [];
    const modelIds = new Set<string>();
    for (const rawModel of p.models) {
      const m = asRecord(rawModel);
      const modelId = String(m.id ?? "").trim();
      if (!modelId || modelId.length > 200 || /\s/.test(modelId)) return `provider "${id}": invalid model id "${modelId}"`;
      if (modelIds.has(modelId)) return `provider "${id}": duplicate model id "${modelId}"`;
      modelIds.add(modelId);
      const num = (v: unknown, label: string, min: number, max: number): number | string | undefined => {
        if (v === undefined || v === null || v === "") return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) return `provider "${id}", model "${modelId}": ${label} out of range`;
        return n;
      };
      const contextWindow = num(m.contextWindow, "contextWindow", 1_000, 100_000_000);
      if (typeof contextWindow === "string") return contextWindow;
      const maxTokens = num(m.maxTokens, "maxTokens", 1, 10_000_000);
      if (typeof maxTokens === "string") return maxTokens;
      let cost: CustomModelDefinition["cost"];
      if (m.cost && typeof m.cost === "object") {
        const c = asRecord(m.cost);
        const parts: Record<string, number> = {};
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const v = num(c[key] ?? 0, `cost.${key}`, 0, 10_000);
          if (typeof v === "string") return v;
          parts[key] = v ?? 0;
        }
        cost = parts as CustomModelDefinition["cost"];
      }
      const input = Array.isArray(m.input) ? m.input.filter((x): x is "text" | "image" => x === "text" || x === "image") : undefined;
      const where = `model "${modelId}"`;
      const thinkingLevelMap = validateThinkingLevelMap(m.thinkingLevelMap, where);
      if (typeof thinkingLevelMap === "string") return thinkingLevelMap;
      const compat = validateCompat(m.compat, where);
      if (typeof compat === "string") return compat;
      // The effort path is the only one that honours `thinkingLevelMap`
      // verbatim: the budget path runs every level through
      // `clampReasoning()`, which folds xhigh/max down to high. A map alone
      // therefore looks correct and changes nothing, so refuse the pairing
      // rather than accept a setting that silently does not work.
      if (thinkingLevelMap && (thinkingLevelMap.xhigh !== undefined || thinkingLevelMap.max !== undefined) &&
          compat?.forceAdaptiveThinking !== true && api === "anthropic-messages") {
        return `${where}: a thinkingLevelMap for xhigh/max needs compat.forceAdaptiveThinking, or Pi clamps both levels to high`;
      }
      models.push({
        id: modelId,
        ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(input && input.length > 0 ? { input } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(cost ? { cost } : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        ...(compat ? { compat } : {}),
      });
    }
    out.push({
      id,
      ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim() } : {}),
      baseUrl,
      api: api as CustomModelApi,
      ...(apiKey ? { apiKey: encodeApiKeyForPi(apiKey) } : {}),
      ...(keepApiKey ? { keepApiKey } : {}),
      models,
    });
  }
  return out;
}

/**
 * Replace Kady-managed providers with `providers`, keeping every foreign
 * provider and other top-level key. Returns the resulting listing, or null if
 * models.json is malformed (left untouched — the caller reports 409).
 */
export function writeCustomProviders(providers: CustomProviderInput[], agentDir = KADY_PI_AGENT_DIR): CustomProviderListing[] | null {
  const file = readJson(modelsJsonPath(agentDir));
  if (file === null) return null;
  const managed = managedIds(agentDir);
  const existing = asRecord(file.providers);
  const next: Rec = {};
  for (const [id, raw] of Object.entries(existing)) {
    if (!managed.has(id)) next[id] = raw; // foreign: untouched
  }
  for (const p of providers) {
    if (existing[p.id] && !managed.has(p.id)) {
      // Never silently take over a hand-written provider.
      return null;
    }
    const saved = asRecord(existing[p.id]).apiKey;
    const apiKey = p.apiKey || (p.keepApiKey && typeof saved === "string" ? saved : "");
    next[p.id] = {
      ...(p.name ? { name: p.name } : {}),
      baseUrl: p.baseUrl,
      api: p.api,
      // Pi only lists models of providers whose auth resolved: keyless servers
      // need a placeholder, exactly like Kady's own ollama registration.
      apiKey: apiKey || "none",
      models: p.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.input ? { input: m.input } : {}),
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.cost ? { cost: m.cost } : {}),
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        ...(m.compat ? { compat: m.compat } : {}),
      })),
    };
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const target = modelsJsonPath(agentDir);
  const tmp = `${target}.${process.pid}.tmp`;
  // Holds API keys, like auth.json next to it: owner-only.
  fs.writeFileSync(tmp, JSON.stringify({ ...file, providers: next }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows ACLs do not map to POSIX modes.
  }
  fs.writeFileSync(manifestPath(agentDir), JSON.stringify({ managed: providers.map((p) => p.id) }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  idCache = null;
  return listCustomProviders(agentDir);
}

export const CUSTOM_SECTION_LABEL = "Custom servers";

/** Picker row for a model served by a custom provider (payg at declared cost). */
export function customModelForClient(model: Model<Api>, provider: CustomProviderListing): ClientDirectModel {
  return {
    id: `${provider.id}/${model.id}`,
    label: model.name,
    provider: provider.name ?? provider.id,
    sourceId: provider.id,
    sourceLabel: CUSTOM_SECTION_LABEL,
    tier: tierFor(model),
    context_length: model.contextWindow,
    pricing: { prompt: model.cost.input, completion: model.cost.output },
    modality: model.input.includes("image") ? "text+image->text" : "text->text",
    description: `Custom model server at ${provider.baseUrl}`,
    reasoning: model.reasoning,
    billingMode: "payg",
    available: true,
  };
}
