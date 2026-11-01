/**
 * App-wide defaults for new chats (Settings → Models → Defaults), global rather than
 * project-scoped: `<agentDir>/kady-settings.json` (see app-settings.ts).
 *   - GET /settings/defaults → { defaults, verifierAgents }
 *   - PUT /settings/defaults → patch (a key set to null clears it) → { defaults, verifierAgents }
 *     A changed verifier model is projected into every project right away
 *     (agent/verifier-models.ts), so open chats pick it up on their next delegation.
 *   - GET /settings/image-models → { models, builtIn } for the image-model picker
 */
import type { FastifyInstance } from "fastify";
import {
  readAppDefaults,
  validateAppDefaultsPatch,
  writeAppDefaults,
  type AppDefaultsPatch,
} from "../app-settings.ts";
import { resolveModel } from "../agent/models.ts";
import { getModelRegistry, modelRefAvailable } from "../agent/session-registry.ts";
import { reconcileVerifierModels, verifierAgentNames } from "../agent/verifier-models.ts";
import { listProjects, resolvePaths } from "../projects.ts";
import { DEFAULT_IMAGE_MODELS, imageModelIssue, listImageModels } from "../agent/image-tool.ts";
import { readShellSettings, writeShellSettings } from "../shell-settings.ts";

export interface RegisterAppSettingsRoutesOptions {
  /** Agent dir holding kady-settings.json (tests point this at a temp dir). */
  agentDir?: string;
}

export async function registerAppSettingsRoutes(
  app: FastifyInstance,
  options: RegisterAppSettingsRoutesOptions = {},
): Promise<void> {
  app.get("/settings/defaults", async () => ({
    defaults: readAppDefaults(options.agentDir),
    verifierAgents: verifierAgentNames(),
  }));

  app.get("/settings/image-models", async () => ({
    models: await listImageModels(getModelRegistry()),
    builtIn: [...DEFAULT_IMAGE_MODELS],
  }));

  // Shell preferences (currently just what closing the window does). They live
  // in `<dataRoot>/shell.json`, which the Electron main process owns; the UI
  // reaches them through here because the renderer has no preload bridge and
  // no direct file access.
  app.get("/settings/shell", async () => readShellSettings());

  app.put<{
    Body: {
      closeAction?: unknown;
      notifyOnRunComplete?: unknown;
      notifyOnlyWhenUnfocused?: unknown;
    };
  }>("/settings/shell", async (req, reply) => {
    const action = req.body?.closeAction;
    if (action !== undefined && action !== "tray" && action !== "quit") {
      reply.code(400);
      return { detail: 'closeAction must be "tray" or "quit"' };
    }
    const notify = req.body?.notifyOnRunComplete;
    if (notify !== undefined && typeof notify !== "boolean") {
      reply.code(400);
      return { detail: "notifyOnRunComplete must be a boolean" };
    }
    const onlyUnfocused = req.body?.notifyOnlyWhenUnfocused;
    if (onlyUnfocused !== undefined && typeof onlyUnfocused !== "boolean") {
      reply.code(400);
      return { detail: "notifyOnlyWhenUnfocused must be a boolean" };
    }
    const next = writeShellSettings({
      ...(action ? { closeAction: action } : {}),
      ...(typeof notify === "boolean" ? { notifyOnRunComplete: notify } : {}),
      ...(typeof onlyUnfocused === "boolean" ? { notifyOnlyWhenUnfocused: onlyUnfocused } : {}),
    });
    if (!next) {
      reply.code(409);
      return { detail: "shell.json is not valid JSON; fix or delete it before changing settings" };
    }
    return next;
  });

  app.put<{ Body: AppDefaultsPatch }>("/settings/defaults", async (req, reply) => {
    const error = validateAppDefaultsPatch(req.body);
    if (error) {
      reply.code(400);
      return { detail: error };
    }
    const patch = req.body;
    // Shape alone would accept a typo'd direct-provider id that then fails
    // every new chat's first run; resolve it now, like the watchdog model.
    if (typeof patch.model === "string") {
      try {
        resolveModel(patch.model.trim(), getModelRegistry());
      } catch (err) {
        reply.code(400);
        return { detail: `Unknown default model: ${(err as Error).message}` };
      }
    }
    if (typeof patch.verifierModel === "string") {
      try {
        resolveModel(patch.verifierModel.trim(), getModelRegistry());
      } catch (err) {
        reply.code(400);
        return { detail: `Unknown verifier model: ${(err as Error).message}` };
      }
    }
    // Only meterable image models: an unpriced one would bill images as free.
    if (typeof patch.imageModel === "string") {
      const issue = imageModelIssue(getModelRegistry(), patch.imageModel.trim());
      if (issue) {
        reply.code(400);
        return { detail: `Invalid default image model: ${issue}` };
      }
    }
    const before = readAppDefaults(options.agentDir).verifierModel;
    const written = writeAppDefaults(patch, options.agentDir);
    if (!written) {
      reply.code(409);
      return { detail: "kady-settings.json is not valid JSON; fix or delete it before changing defaults" };
    }
    if (written.verifierModel !== before) {
      for (const project of listProjects()) {
        try {
          reconcileVerifierModels(resolvePaths(project.id), written.verifierModel, modelRefAvailable);
        } catch (err) {
          // A project whose files cannot be read now is reconciled at its next session build.
          req.log.warn({ err, projectId: project.id }, "verifier model routing not applied");
        }
      }
    }
    return { defaults: written, verifierAgents: verifierAgentNames() };
  });
}
