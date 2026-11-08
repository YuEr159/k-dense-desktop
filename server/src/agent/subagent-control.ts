/** Supported event-bus RPC; scope is the actual Pi session, never a global run id. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { modalJobManager } from "../modal/manager.ts";
import { isTerminalModalState } from "../modal/types.ts";
import { workflowCallTargets } from "./subagent-bridge.ts";
import { webAccessPackageDir } from "./web-access-bridge.ts";
import { LEAD_DELEGATION_GUIDANCE, setSubagentPromptSection, verifierModelGuidance } from "./subagent-prompts.ts";
import { routedVerifiers } from "./verifier-models.ts";
import { resolvePaths } from "../projects.ts";
import {
  modelOverrideKey,
  readCompactionSettings,
  reserveForWindow,
  writeModelReserveTokens,
} from "./compaction-settings.ts";

type Rec = Record<string, any>;

/**
 * Leave the user's compaction trigger where a child process will find it.
 *
 * `contract.model` is a `provider/id` reference, not a Pi `Model`, so the
 * window behind it has to be looked up again. Anything unresolvable is skipped
 * rather than guessed: a child on Pi's default trigger costs more context than
 * asked, but a child on a window from the wrong model can compact on every
 * turn.
 */
function recordChildCompactionTrigger(
  projectId: string,
  ctx: ExtensionContext,
  ref: unknown,
): void {
  if (typeof ref !== "string") return;
  // First slash separates provider from id; the rest belongs to the id
  // (`openrouter/openai/gpt-6-astra`).
  const slash = ref.indexOf("/");
  if (slash <= 0) return;
  const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
  if (!model || !model.contextWindow || model.contextWindow <= 0) return;
  const paths = resolvePaths(projectId);
  const { autoCompactWindow } = readCompactionSettings(paths);
  if (autoCompactWindow === null) return;
  try {
    writeModelReserveTokens(
      paths,
      modelOverrideKey(model.provider, model.id),
      reserveForWindow(autoCompactWindow, model.contextWindow),
    );
  } catch {
    // The file is malformed or unwritable. Children fall back to Pi's default
    // trigger; a launch that otherwise works must not fail over a setting.
  }
}
interface Host { rpc(method: string, params?: Rec): Promise<Rec>; preflight(input: Rec): Promise<unknown>; refreshSchedules(): void; }
const hosts = new Map<string, Host>();
/**
 * Kady chat (and resident scheduler) sessions. Pi sees them as headless, so
 * pi-subagents would hold every turn's `agent_end` open until all background
 * work drains (up to 30 min); the backend outlives the turn and the session
 * observer adopts completion notices as system runs, so the patched seam
 * (KADY_HOST_NO_DRAIN_V1 in scripts/patch-subagents.mjs) skips the drain for
 * these ids. Shared through globalThis because the plugin cannot import Kady.
 */
const interactiveSessions: Set<string> = ((globalThis as { __kadyInteractiveSessions?: Set<string> }).__kadyInteractiveSessions ??= new Set<string>());
const key = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;
export function subagentHost(projectId: string, sessionId: string): Host {
  const host = hosts.get(key(projectId, sessionId));
  if (!host) throw new Error("Specialist controls are not ready for this session");
  return host;
}
export function liveSubagentSessions(projectId: string): string[] {
  return [...hosts.keys()].filter((k) => k.startsWith(projectId + ":")).map((k) => k.slice(projectId.length + 1));
}
export function makeSubagentControlExtension(projectId: string): ExtensionFactory {
  return (pi) => {
    let ctx: ExtensionContext;
    let currentSessionId: string | undefined;
    let pluginSessionId: string | undefined;
    let ceiling: ReturnType<typeof registerSubagentCapabilityCeiling> | undefined;
    const disposers: Array<() => void> = [];
    const pending = new Set<() => void>();
    const policy = () => ({ allowedTools: [...new Set([
      ...pi.getAllTools().map((tool) => tool.name).filter((name) => !["interview", "subagents_enable", "web_enable", "subagent_supervisor"].includes(name)),
      "contact_supervisor", "codemode", "tool_search",
    ])] });
    const preflight = async (input: Rec) => {
      ceiling?.update(policy());
      return resolveSubagentLaunchContract({
      agent: String(input.agent), task: typeof input.task === "string" ? input.task : undefined,
      cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(), parentLeafId: ctx.sessionManager.getLeafId(),
      parentModel: ctx.model, availableModels: ctx.modelRegistry.getAll(),
      capabilityCeiling: resolveSubagentCapabilityCeiling(ctx.sessionManager.getSessionId()),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(input.context === "fork" || input.context === "fresh" ? { context: input.context } : {}),
      });
    };
    const rpc = (method: string, params: Rec = {}): Promise<Rec> => new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const event = `subagents:rpc:v1:reply:${requestId}`;
      const cleanup = () => { clearTimeout(timer); off(); pending.delete(cancel); };
      const cancel = () => { cleanup(); reject(new Error("Specialist session closed")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Specialist control request timed out")); }, 20_000);
      const off = pi.events.on(event, (raw: unknown) => {
        const reply = raw as Rec;
        cleanup();
        if (reply.success) resolve(reply.data);
        else reject(new Error(reply.error?.message || "Specialist control failed"));
      });
      pending.add(cancel);
      pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params, source: { extension: "kady" } });
    });
    pi.on("session_start", (_event, context) => {
      ctx = context;
      const sessionId = ctx.sessionManager.getSessionId();
      currentSessionId = sessionId;
      // pi-subagents identifies a session by its file when it has one
      // (shared/session-identity.js), not by the session id.
      pluginSessionId = ctx.sessionManager.getSessionFile() ?? sessionId;
      interactiveSessions.add(pluginSessionId);
      ceiling = registerSubagentCapabilityCeiling({ sessionId, source: "kady-parent-tools", ceiling: policy() });
      disposers.push(() => ceiling?.dispose());
      const packages = path.resolve(import.meta.dirname, "../../pi-packages");
      const webEntry = path.resolve(webAccessPackageDir(), JSON.parse(fs.readFileSync(path.join(webAccessPackageDir(), "package.json"), "utf8")).pi.extensions[0]);
      const required = registerRequiredChildExtensions({ sessionId, extensions: [
        ...["kady-guard", "kady-bash-timeout", "kady-notebook", "kady-modal", "kady-pdf-annotations", "kady-child-runtime"].map((id) => ({ id, path: path.join(packages, id, "index.ts") })),
        { id: "pi-web-access", path: fs.statSync(webEntry).isDirectory() ? path.join(webEntry, "index.js") : webEntry },
      ] });
      disposers.push(() => required.dispose());
      disposers.push(registerBackgroundWorkProvider({ name: `kady-modal:${projectId}:${sessionId}`,
        // Matched and reported under the plugin's identity (the session file):
        // under the bare session id no query ever matched, so bg_wait could not
        // see this session's Modal jobs.
        listActiveWork(context) {
          const owner = pluginSessionId ?? sessionId;
          if (context?.sessionId !== owner) return [];
          return modalJobManager.list(projectId, { sessionId }).filter((job) => !isTerminalModalState(job.state)).map((job) => ({ id: `modal:${job.id}`, sessionId: owner }));
        },
      }));
      hosts.set(key(projectId, sessionId), {
        rpc, preflight,
        refreshSchedules: () => pi.events.emit("kady:schedules:refresh", {}),
      });
    });
    pi.on("before_agent_start", (event) => {
      ceiling?.update(policy());
      const verifiers = routedVerifiers(resolvePaths(projectId));
      setSubagentPromptSection(event, "kady_delegation", verifiers
        ? `${LEAD_DELEGATION_GUIDANCE}\n\n${verifierModelGuidance(verifiers.model, verifiers.agents)}`
        : LEAD_DELEGATION_GUIDANCE);
    });
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "subagent" || event.input.action || !ctx) return;
      ceiling?.update(policy());
      const targets = workflowCallTargets(event.input, { toolCallId: event.toolCallId, sessionManager: ctx.sessionManager, cwd: ctx.cwd });
      if (!targets || targets.dynamic) return;
      // Public preflight supplies early, readable configuration failures. Actual
      // provider admission remains authoritative for computed/file workflows.
      //
      // Every launch also records the compaction trigger its model needs, not
      // just the ones that need validating: a child runs in its own process
      // and cannot see this session's overrides, so the only way to give it the
      // user's trigger is to leave it in the shared settings file beforehand.
      for (const agent of targets.agents) {
        const result = await preflight({ agent, model: event.input.model });
        if (!result.ok) {
          if (targets.models.size === 0) return { block: true, reason: result.message };
          continue;
        }
        recordChildCompactionTrigger(projectId, ctx, (result.contract as { model?: unknown }).model);
      }
    });
    pi.on("session_shutdown", () => {
      if (currentSessionId) hosts.delete(key(projectId, currentSessionId));
      if (pluginSessionId) interactiveSessions.delete(pluginSessionId);
      for (const cancel of pending) cancel();
      disposers.splice(0).forEach((dispose) => dispose());
    });
  };
}
