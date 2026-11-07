/**
 * Complete project archive used by GET /sandbox/download-all.
 *
 * User-visible sandbox files keep their existing paths at the archive root.
 * Hidden application state stays hidden, except for explicit, portable exports
 * of user-facing chat sessions and Living Lab Notebook data.
 */
import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { ProjectPaths } from "./projects.ts";
import { apiRelative, isUserVisible, isWithin } from "./sandbox-fs.ts";
import { readNotebookAnnotations } from "./agent/notebook-annotations.ts";
import { notebookToMarkdown } from "./agent/notebook-export.ts";
import {
  isValidSessionId,
  readProjectNotebooks,
  type NotebookEntry,
} from "./agent/notebook-store.ts";
import { toNotebook } from "./agent/session-export.ts";
import { listSessions } from "./agent/session-registry.ts";

type ArchiveSession = Awaited<ReturnType<typeof listSessions>>[number];

export interface ProjectArchiveOptions {
  paths: ProjectPaths;
  projectName?: string;
  /** Test seam; production always uses the same list as GET /sessions. */
  sessions?: ArchiveSession[];
}

export interface ProjectArchiveResult {
  archive: ZipArchive;
  entryCount: number;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function addLocalFile(zip: ZipArchive, file: string, archived: string): void {
  zip.file(file, {
    name: archived,
    stats: fs.statSync(file),
  });
}

function addVisibleSandboxFiles(
  zip: ZipArchive,
  root: string,
  occupiedRoots: Set<string>,
): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (!isUserVisible(abs, root)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = apiRelative(root, abs);
        addLocalFile(zip, abs, rel);
        occupiedRoots.add(rel.split("/")[0]);
        count++;
      }
    }
  };
  walk(root);
  return count;
}

/** Avoid replacing a user's own top-level chat-history/ or notebook/ folder. */
function availableRoot(preferred: string, occupied: Set<string>): string {
  if (!occupied.has(preferred)) {
    occupied.add(preferred);
    return preferred;
  }
  const fallback = `${preferred}-kady-export`;
  if (!occupied.has(fallback)) {
    occupied.add(fallback);
    return fallback;
  }
  let suffix = 2;
  while (occupied.has(`${fallback}-${suffix}`)) suffix++;
  const root = `${fallback}-${suffix}`;
  occupied.add(root);
  return root;
}

function regularFileWithin(root: string, file: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    return isWithin(realRoot, realFile) && fs.statSync(realFile).isFile();
  } catch {
    return false;
  }
}

function notebookSessionIds(notebookDir: string): string[] {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(notebookDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.isFile()) continue;
    const match =
      /^(.+)\.annotations\.json$/.exec(file.name) ??
      /^(.+)\.jsonl$/.exec(file.name);
    if (match && isValidSessionId(match[1])) ids.add(match[1]);
  }
  return [...ids].sort();
}

function artifactLinks(
  entries: NotebookEntry[],
  sandboxRoot: string,
): {
  href: (relPath: string) => string | undefined;
  missing: ReadonlySet<string>;
} {
  const archived = new Map<string, string>();
  const missing = new Set<string>();
  for (const entry of entries) {
    for (const artifact of entry.artifacts ?? []) {
      if (archived.has(artifact) || missing.has(artifact)) continue;
      const normalized = artifact.replaceAll("\\", "/").replace(/^\/+/, "");
      const abs = path.resolve(sandboxRoot, normalized);
      let visibleFile = false;
      try {
        visibleFile =
          isWithin(sandboxRoot, abs) &&
          isUserVisible(abs, sandboxRoot) &&
          fs.lstatSync(abs).isFile();
      } catch {
        visibleFile = false;
      }
      if (visibleFile) archived.set(artifact, apiRelative(sandboxRoot, abs));
      else missing.add(artifact);
    }
  }
  return {
    href: (artifact) => {
      const rel = archived.get(artifact);
      return rel ? `../../${rel}` : undefined;
    },
    missing,
  };
}

function addChatHistory(
  zip: ZipArchive,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): number {
  const sessions = (opts.sessions ?? [])
    .filter((session) => session.messageCount > 0 && isValidSessionId(session.id));
  if (sessions.length === 0) return 0;

  const root = availableRoot("chat-history", occupiedRoots);
  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: Array<Record<string, unknown>>;
  } = {
    version: 1,
    projectId: opts.paths.id,
    projectName: opts.projectName ?? opts.paths.id,
    sessions: [],
  };
  let count = 0;
  for (const session of sessions) {
    if (!regularFileWithin(opts.paths.sessionsDir, session.path)) continue;
    const raw = `${root}/raw/${session.id}.jsonl`;
    const markdown = `${root}/markdown/${session.id}.md`;
    addLocalFile(zip, session.path, raw);
    zip.append(
      Buffer.from(toNotebook(session.path, session.id, opts.paths.sandbox), "utf-8"),
      { name: markdown },
    );
    manifest.sessions.push({
      id: session.id,
      name: session.name ?? null,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
      raw,
      markdown,
    });
    count += 2;
  }
  if (manifest.sessions.length === 0) return 0;
  zip.append(jsonBuffer(manifest), { name: `${root}/manifest.json` });
  return count + 1;
}

function addNotebooks(
  zip: ZipArchive,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): number {
  const sessionIds = notebookSessionIds(opts.paths.notebookDir);
  if (sessionIds.length === 0) return 0;

  const root = availableRoot("notebook", occupiedRoots);
  const entriesBySession = new Map(
    readProjectNotebooks(opts.paths.id).map((notebook) => [
      notebook.sessionId,
      notebook.entries,
    ]),
  );
  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: Array<Record<string, unknown>>;
  } = {
    version: 1,
    projectId: opts.paths.id,
    projectName: opts.projectName ?? opts.paths.id,
    sessions: [],
  };
  let count = 0;
  for (const sessionId of sessionIds) {
    const entries = entriesBySession.get(sessionId) ?? [];
    const { doc: annotations } = readNotebookAnnotations(sessionId, opts.paths.id);
    const entryFile = path.join(opts.paths.notebookDir, `${sessionId}.jsonl`);
    const annotationsFile = path.join(
      opts.paths.notebookDir,
      `${sessionId}.annotations.json`,
    );
    const rawEntries = `${root}/raw/${sessionId}.jsonl`;
    const rawAnnotations = `${root}/raw/${sessionId}.annotations.json`;
    const markdown = `${root}/markdown/${sessionId}.md`;
    const hasRawEntries = regularFileWithin(opts.paths.notebookDir, entryFile);
    const hasRawAnnotations = regularFileWithin(
      opts.paths.notebookDir,
      annotationsFile,
    );
    if (hasRawEntries) {
      addLocalFile(zip, entryFile, rawEntries);
      count++;
    }
    if (hasRawAnnotations) {
      addLocalFile(zip, annotationsFile, rawAnnotations);
      count++;
    }
    const links = artifactLinks(entries, opts.paths.sandbox);
    zip.append(
      Buffer.from(
        notebookToMarkdown(entries, {
          sessionId,
          projectName: opts.projectName ?? opts.paths.id,
          annotations: annotations.annotations,
          artifactHref: links.href,
          missingArtifacts: links.missing,
        }),
        "utf-8",
      ),
      { name: markdown },
    );
    count++;
    manifest.sessions.push({
      sessionId,
      entries,
      annotations: annotations.annotations,
      rawEntries: hasRawEntries ? rawEntries : null,
      rawAnnotations: hasRawAnnotations ? rawAnnotations : null,
      markdown,
    });
  }
  zip.append(jsonBuffer(manifest), { name: `${root}/manifest.json` });
  return count + 1;
}

/**
 * Child sessions and artifacts pi-subagents wrote next to the parent sessions.
 *
 * These live under `sessionsDir` (inside the project) but behind dot-directory
 * siblings, so `isUserVisible` drops them from the sandbox walk and
 * `addChatHistory` only reads top-level `*.jsonl`. Excluding them meant a
 * project export silently lost delegated work — the subagent's own session
 * (which can hold hundreds of KB of real analysis) and its archived outputs.
 *
 * Layout produced by pi-subagents (0.78):
 *   sessionsDir/<parentBasename>/<runUuid>/run-<n>/session.jsonl
 *   sessionsDir/subagent-artifacts/<runId>_<agent>_{input.md,output.md,meta.json,transcript.jsonl}
 *
 * 8 MiB per file keeps a runaway transcript from dominating the archive; the
 * manifest records what was skipped so the gap is visible rather than silent.
 */
const SUBAGENT_FILE_LIMIT_BYTES = 8 * 1024 * 1024;

function addSubagentRecords(
  zip: ZipArchive,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): number {
  const sessionsDir = opts.paths.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return 0;
  const root = availableRoot("subagents", occupiedRoots);

  interface RunRecord {
    runId: string;
    runs: Array<{ file: string; archived: string }>;
    skipped: Array<{ file: string; reason: string }>;
  }
  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: Array<{ parentSessionId: string; runs: RunRecord[] }>;
    artifacts: Array<{ file: string; archived?: string; skipped?: string }>;
  } = {
    version: 1,
    projectId: opts.paths.id,
    projectName: opts.projectName ?? opts.paths.id,
    sessions: [],
    artifacts: [],
  };
  let count = 0;

  const addIfArchiveable = (file: string, archived: string):
    | { ok: true }
    | { ok: false; reason: string } => {
    if (!regularFileWithin(sessionsDir, file)) return { ok: false, reason: "unreadable" };
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (size === 0) return { ok: false, reason: "empty" };
    if (size > SUBAGENT_FILE_LIMIT_BYTES) return { ok: false, reason: "too-large" };
    addLocalFile(zip, file, archived);
    count++;
    return { ok: true };
  };

  let parentDirs: fs.Dirent[] = [];
  try {
    parentDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const parent of parentDirs) {
    if (!parent.isDirectory()) continue;
    if (parent.name === "subagent-artifacts") continue;
    const parentDir = path.join(sessionsDir, parent.name);
    // The directory is named after the parent session's file stem, which is
    // `<timestamp>_<sessionId>`; the id is what the UI knows.
    const match = /_([0-9a-f-]{36})$/i.exec(parent.name);
    const parentSessionId = match ? match[1] : parent.name;
    const runs: RunRecord[] = [];
    let runDirs: fs.Dirent[] = [];
    try {
      runDirs = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(parentDir, runEntry.name);
      let stepDirs: fs.Dirent[] = [];
      try {
        stepDirs = fs.readdirSync(runDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const record: RunRecord = { runId: runEntry.name, runs: [], skipped: [] };
      for (const step of stepDirs) {
        if (!step.isDirectory() || !step.name.startsWith("run-")) continue;
        const file = path.join(runDir, step.name, "session.jsonl");
        const archived = `${root}/sessions/${parentSessionId}/${runEntry.name}/${step.name}.jsonl`;
        const result = addIfArchiveable(file, archived);
        if (result.ok) record.runs.push({ file, archived });
        else if (result.reason !== "unreadable") record.skipped.push({ file, reason: result.reason });
      }
      if (record.runs.length || record.skipped.length) runs.push(record);
    }
    if (runs.length) manifest.sessions.push({ parentSessionId, runs });
  }

  const artifactsDir = path.join(sessionsDir, "subagent-artifacts");
  if (fs.existsSync(artifactsDir)) {
    let files: fs.Dirent[] = [];
    try {
      files = fs.readdirSync(artifactsDir, { withFileTypes: true });
    } catch {
      files = [];
    }
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const file = path.join(artifactsDir, entry.name);
      const archived = `${root}/artifacts/${entry.name}`;
      const result = addIfArchiveable(file, archived);
      if (result.ok) manifest.artifacts.push({ file, archived });
      else if (result.reason !== "unreadable") manifest.artifacts.push({ file, skipped: result.reason });
    }
  }

  if (manifest.sessions.length === 0 && manifest.artifacts.length === 0) return 0;
  zip.append(jsonBuffer(manifest), { name: `${root}/manifest.json` });
  return count + 1;
}

export async function buildProjectArchive(
  opts: ProjectArchiveOptions,
): Promise<ProjectArchiveResult> {
  // Resolve async metadata before file streams are queued so callers can attach
  // the archive to the HTTP response before any stream errors are possible.
  const completeOpts: ProjectArchiveOptions = {
    ...opts,
    sessions: opts.sessions ?? await listSessions(opts.paths),
  };
  const archive = new ZipArchive({
    forceZip64: true,
    zlib: { level: 6 },
  });
  archive.on("warning", (err) => archive.destroy(err));
  const occupiedRoots = new Set<string>();
  let entryCount = addVisibleSandboxFiles(
    archive,
    opts.paths.sandbox,
    occupiedRoots,
  );
  entryCount += addChatHistory(archive, completeOpts, occupiedRoots);
  entryCount += addSubagentRecords(archive, completeOpts, occupiedRoots);
  entryCount += addNotebooks(archive, completeOpts, occupiedRoots);
  return { archive, entryCount };
}
