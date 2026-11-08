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
 * Two ids meet here and they are *not* the same one: the child's own session
 * UUID names the directory, while the artifacts are prefixed with pi-subagents'
 * per-launch run id. `_meta.json` is the only file carrying both, which is what
 * `attachArtifacts` groups on.
 *
 * The walk is recursive and dot-files are dropped: pi-subagents writes internal
 * bookkeeping (`subagent-artifacts/.last-cleanup`, a cleanup throttle stamp) and
 * may nest `progress/<id>/` or `outputs/<id>/` under the artifacts directory.
 * A flat `isFile()` pass would ship the stamp and silently lose the subtrees.
 *
 * No per-file size cap: `addVisibleSandboxFiles` has none either, and a user's
 * 270 MB dataset and their 2.5 MB subagent transcript should not have different
 * rules in the same zip.
 */
interface SubagentArtifact {
  /** Path inside the archive. Absolute host paths never reach the manifest. */
  archived: string;
  /** Why a file was not archived; present only on the skipped side. */
  skipped?: string;
  /** From `_meta.json`, when this artifact has one. */
  parentSessionId?: string;
  runId?: string;
}

interface SubagentRun {
  runId: string;
  files: string[];
  artifacts: SubagentArtifact[];
  skipped: string[];
}

interface SubagentParent {
  parentSessionId: string;
  runs: SubagentRun[];
  /** Artifacts whose `_meta.json` was unreadable or named no parent. */
  ungrouped: SubagentArtifact[];
}

/** Read the two fields `_meta.json` that let an artifact find its run. */
function artifactOwner(file: string): { parentSessionId?: string; runId?: string } {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { runId?: unknown; parentSessionId?: unknown };
    return {
      ...(typeof meta.parentSessionId === "string" ? { parentSessionId: meta.parentSessionId } : {}),
      ...(typeof meta.runId === "string" ? { runId: meta.runId } : {}),
    };
  } catch {
    // Missing, half-written or not JSON: the artifact still ships, ungrouped.
    return {};
  }
}

function addSubagentRecords(
  zip: ZipArchive,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): number {
  const sessionsDir = opts.paths.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return 0;
  const root = availableRoot("subagents", occupiedRoots);

  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: SubagentParent[];
    /** Artifacts whose owning run is unknown; always shipped. */
    artifacts: SubagentArtifact[];
    artifactsNote?: string;
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
    addLocalFile(zip, file, archived);
    count++;
    return { ok: true };
  };

  /**
   * Collect `dir` into the archive, keeping relative structure. Dot-files are
   * skipped at every level, matching `isUserVisible`'s rule for the same tree.
   */
  const walkInto = (
    dir: string,
    archivedPrefix: string,
    onFile: (file: string, archived: string) => void,
  ): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const archived = `${archivedPrefix}/${entry.name}`;
      if (entry.isDirectory()) walkInto(abs, archived, onFile);
      else if (entry.isFile()) onFile(abs, archived);
    }
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
    const runs: SubagentRun[] = [];
    let runDirs: fs.Dirent[] = [];
    try {
      runDirs = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory() || runEntry.name.startsWith(".")) continue;
      const runDir = path.join(parentDir, runEntry.name);
      const record: SubagentRun = { runId: runEntry.name, files: [], artifacts: [], skipped: [] };
      walkInto(runDir, `${root}/sessions/${parentSessionId}/${runEntry.name}`, (file, archived) => {
        const result = addIfArchiveable(file, archived);
        if (result.ok) record.files.push(archived);
        else if (result.reason !== "unreadable") record.skipped.push(archived);
      });
      if (record.files.length || record.skipped.length) runs.push(record);
    }
    if (runs.length) manifest.sessions.push({ parentSessionId, runs, ungrouped: [] });
  }

  // Artifacts are a flat-to-nested tree shared by every parent session, so each
  // one is matched back to its run. `_meta.json` names `parentSessionId`
  // outright; its siblings carry the run id as their file-name prefix
  // (`<runId>_<agent>_output.md`), which is the child-session directory name.
  const runIndex = new Map<string, { parent: SubagentParent; run: SubagentRun }>();
  for (const parent of manifest.sessions) {
    for (const run of parent.runs) runIndex.set(run.runId, { parent, run });
  }
  const artifactsDir = path.join(sessionsDir, "subagent-artifacts");
  // `_meta.json` is the only artifact naming its parent outright, and it can be
  // visited after its siblings — read the whole directory's metadata first so
  // every file in a run's set resolves, not just the one holding the meta.
  const parentByRunId = new Map<string, string>();
  if (fs.existsSync(artifactsDir)) {
    walkInto(artifactsDir, "", (file, relative) => {
      if (!relative.endsWith("_meta.json")) return;
      const owner = artifactOwner(file);
      if (owner.runId && owner.parentSessionId) parentByRunId.set(owner.runId, owner.parentSessionId);
    });
  }
  const stray: SubagentArtifact[] = [];
  if (fs.existsSync(artifactsDir)) {
    walkInto(artifactsDir, `${root}/artifacts`, (file, archived) => {
      const result = addIfArchiveable(file, archived);
      const base = path.basename(file);
      const owner = base.endsWith("_meta.json") ? artifactOwner(file) : {};
      const id = owner.runId
        ?? /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i.exec(base)?.[1];
      const parentSessionId = owner.parentSessionId ?? (id ? parentByRunId.get(id) : undefined);
      const entry: SubagentArtifact = {
        archived,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(id ? { runId: id } : {}),
      };
      if (!result.ok) {
        if (result.reason !== "unreadable") stray.push({ ...entry, skipped: result.reason });
        return;
      }
      // The run directory is the child session's own UUID, a different id from
      // the run id in the artifact name, so only `_meta.json` links the two.
      const hit = id ? runIndex.get(id) : undefined;
      if (hit) {
        hit.run.artifacts.push(entry);
        return;
      }
      // Known parent but no session file (a launch that died before its first
      // turn): keep it under that parent rather than dropping the output.
      const byParent = parentSessionId
        ? manifest.sessions.find((session) => session.parentSessionId === parentSessionId)
        : undefined;
      if (byParent) {
        byParent.ungrouped.push(entry);
        return;
      }
      stray.push(entry);
    });
  }

  if (stray.length) manifest.artifacts = stray;
  if (manifest.sessions.length === 0 && manifest.artifacts.length === 0) return 0;
  // Artifact bodies are the child's own record of its work and are copied
  // verbatim, so a host path in the text is data, not something we introduced.
  // Say so once, rather than rewriting the record. `count` is what was packed,
  // so a manifest holding only skipped entries does not earn the note.
  if (count > 0) {
    manifest.artifactsNote =
      "Artifact bodies are the subagent's own transcript and output, copied " +
      "verbatim; any host paths inside them are part of that record.";
  }
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
