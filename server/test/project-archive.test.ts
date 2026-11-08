import fs from "node:fs";
import path from "node:path";
import { buffer as consumeBuffer } from "node:stream/consumers";
import AdmZip from "adm-zip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  ensureProjectExists,
  resolvePaths,
} from "../src/projects.ts";
import {
  appendNotebookEntry,
  type NotebookEntry,
} from "../src/agent/notebook-store.ts";
import { writeNotebookAnnotations } from "../src/agent/notebook-annotations.ts";
import {
  buildProjectArchive,
  type ProjectArchiveOptions,
} from "../src/project-archive.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function zipText(zip: AdmZip, entry: string): string {
  const found = zip.getEntry(entry);
  expect(found, `missing ${entry}`).not.toBeNull();
  return found!.getData().toString("utf-8");
}

async function finishArchive(
  opts: ProjectArchiveOptions,
): Promise<Buffer> {
  const { archive } = await buildProjectArchive(opts);
  const result = consumeBuffer(archive);
  await archive.finalize();
  return result;
}

type ArchiveSession = NonNullable<ProjectArchiveOptions["sessions"]>[number];

function archiveSession(
  pathName: string,
  over: Partial<ArchiveSession> = {},
): ArchiveSession {
  return {
    id: "chat-1",
    path: pathName,
    name: "Analysis chat",
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date("2026-01-01T01:00:00Z"),
    messageCount: 2,
    firstMessage: "Analyze the data",
    ...over,
  } as ArchiveSession;
}

function message(role: string, text: string) {
  return {
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  };
}

describe("buildProjectArchive", () => {
  it("keeps visible sandbox files and adds raw/readable non-empty chats", async () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "results.txt"), "result", "utf-8");
    fs.writeFileSync(path.join(paths.sessionsDir, "settings.json"), "hidden", "utf-8");

    const chatFile = path.join(paths.sessionsDir, "chat-1.jsonl");
    fs.writeFileSync(
      chatFile,
      [
        JSON.stringify({ type: "session", id: "chat-1" }),
        JSON.stringify(message("user", "Analyze the data")),
        JSON.stringify(message("assistant", "Analysis complete")),
      ].join("\n") + "\n",
      "utf-8",
    );
    const emptyFile = path.join(paths.sessionsDir, "empty.jsonl");
    fs.writeFileSync(
      emptyFile,
      JSON.stringify({ type: "session", id: "empty" }) + "\n",
      "utf-8",
    );

    const buffer = await finishArchive({
      paths,
      projectName: "Archive test",
      sessions: [
        archiveSession(chatFile),
        archiveSession(emptyFile, { id: "empty", messageCount: 0 }),
      ],
    });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);

    expect(names).toContain("results.txt");
    expect(names).not.toContain(".pi/sessions/settings.json");
    expect(names).toContain("chat-history/raw/chat-1.jsonl");
    expect(names).toContain("chat-history/markdown/chat-1.md");
    expect(names).not.toContain("chat-history/raw/empty.jsonl");
    expect(zipText(zip, "chat-history/raw/chat-1.jsonl")).toContain(
      '"id":"chat-1"',
    );
    expect(zipText(zip, "chat-history/markdown/chat-1.md")).toContain(
      "Analyze the data",
    );
    const manifest = JSON.parse(zipText(zip, "chat-history/manifest.json"));
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]).toMatchObject({
      id: "chat-1",
      messageCount: 2,
    });
  });

  it("includes every live notebook, annotations, and safe artifact links", async () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(path.join(paths.sandbox, "figures"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.sandbox, "figures", "plot.png"),
      "PNG",
      "utf-8",
    );
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    fs.writeFileSync(path.join(paths.kadyDir, "private.txt"), "no", "utf-8");

    const entry: NotebookEntry = {
      id: "entry-1",
      type: "observation",
      title: "Signal found",
      body: "The signal is strong.",
      timestamp: 1_000,
      role: "agent",
      artifacts: ["figures/plot.png", ".kady/private.txt"],
    };
    appendNotebookEntry("notebook-1", entry, "default");
    writeNotebookAnnotations(
      "notebook-1",
      {
        version: 1,
        annotations: [
          {
            id: "pin-1",
            kind: "pin",
            entryId: "entry-1",
            createdAt: 2_000,
          },
          {
            id: "comment-1",
            kind: "comment",
            entryId: "entry-1",
            body: "Check this result.",
            createdAt: 3_000,
          },
          {
            id: "note-1",
            kind: "note",
            title: "Follow-up",
            body: "Repeat with more samples.",
            createdAt: 4_000,
          },
        ],
      },
      "default",
    );
    writeNotebookAnnotations(
      "notes-only",
      {
        version: 1,
        annotations: [
          {
            id: "note-2",
            kind: "note",
            body: "Annotation-only session.",
            createdAt: 5_000,
          },
        ],
      },
      "default",
    );

    const buffer = await finishArchive({
      paths,
      projectName: "Notebook test",
      sessions: [],
    });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((item) => item.entryName);

    expect(names).toContain("figures/plot.png");
    expect(names).not.toContain(".kady/private.txt");
    expect(names).toContain("notebook/raw/notebook-1.jsonl");
    expect(names).toContain("notebook/raw/notebook-1.annotations.json");
    expect(names).toContain("notebook/markdown/notebook-1.md");
    expect(names).toContain("notebook/raw/notes-only.annotations.json");
    expect(names).toContain("notebook/markdown/notes-only.md");

    const markdown = zipText(zip, "notebook/markdown/notebook-1.md");
    expect(markdown).toContain("![plot.png](../../figures/plot.png)");
    expect(markdown).toContain(
      "`.kady/private.txt` _(artifact missing at export time)_",
    );
    expect(markdown).toContain("Pinned by user");
    expect(markdown).toContain("Check this result.");
    expect(markdown).toContain("Repeat with more samples.");

    const manifest = JSON.parse(zipText(zip, "notebook/manifest.json"));
    expect(manifest.sessions.map((session: { sessionId: string }) => session.sessionId))
      .toEqual(["notebook-1", "notes-only"]);
    expect(manifest.sessions[0].annotations).toHaveLength(3);
  });

  it("carries subagent child sessions and artifacts, and still hides other dot-state", async () => {
    const paths = resolvePaths("default");
    // pi-subagents writes children under <parentBasename>/<runUuid>/run-<n>/.
    const parentDir = path.join(
      paths.sessionsDir,
      "2026-01-01T00-00-00-000Z_01a1b672-2ab8-76c6-8045-6e04b79bdcde",
    );
    const childDir = path.join(parentDir, "6f64286f-e855-4a04-bc97-db065c242c5f", "run-0");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, "session.jsonl"),
      JSON.stringify(message("assistant", "fetched 28 hits")) + "\n",
      "utf-8",
    );
    // An empty run (runner died before its first turn) must not be archived.
    const emptyDir = path.join(parentDir, "a0a7834e-a4b5-4faf-b2cd-6cd190478bb2", "run-0");
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, "session.jsonl"), "", "utf-8");

    const artifactsDir = path.join(paths.sessionsDir, "subagent-artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactsDir, "6f64286f-e855-4a04-bc97-db065c242c5f_literature-researcher_output.md"),
      "=== A2 === hitCount=28",
      "utf-8",
    );
    // Unrelated dot-state under the sessions dir stays out.
    fs.writeFileSync(path.join(paths.sessionsDir, "settings.json"), "hidden", "utf-8");

    const buffer = await finishArchive({ paths, projectName: "Archive test", sessions: [] });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);

    expect(names).toContain(
      "subagents/sessions/01a1b672-2ab8-76c6-8045-6e04b79bdcde/" +
        "6f64286f-e855-4a04-bc97-db065c242c5f/run-0/session.jsonl",
    );
    expect(names).toContain("subagents/artifacts/6f64286f-e855-4a04-bc97-db065c242c5f_literature-researcher_output.md");
    expect(names).not.toContain("subagents/sessions/01a1b672-2ab8-76c6-8045-6e04b79bdcde/a0a7834e-a4b5-4faf-b2cd-6cd190478bb2/run-0/session.jsonl");
    expect(names).not.toContain(".pi/sessions/settings.json");
    expect(zipText(
      zip,
      "subagents/sessions/01a1b672-2ab8-76c6-8045-6e04b79bdcde/" +
        "6f64286f-e855-4a04-bc97-db065c242c5f/run-0/session.jsonl",
    )).toContain("fetched 28 hits");

    // No host path may reach the manifest; the archive is what gets forwarded.
    const manifestText = zipText(zip, "subagents/manifest.json");
    expect(manifestText).not.toContain(paths.sessionsDir);
    expect(manifestText).not.toContain(paths.sandbox);

    const manifest = JSON.parse(manifestText);
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0].parentSessionId).toBe("01a1b672-2ab8-76c6-8045-6e04b79bdcde");
    expect(manifest.sessions[0].runs[0].files).toEqual([
      "subagents/sessions/01a1b672-2ab8-76c6-8045-6e04b79bdcde/" +
        "6f64286f-e855-4a04-bc97-db065c242c5f/run-0/session.jsonl",
    ]);
  });

  it("drops the cleanup stamp and keeps nested artifact subtrees", async () => {
    const paths = resolvePaths("default");
    const parentDir = path.join(
      paths.sessionsDir,
      "2026-01-01T00-00-00-000Z_01a1b672-2ab8-76c6-8045-6e04b79bdcde",
    );
    fs.mkdirSync(path.join(parentDir, "6f64286f-e855-4a04-bc97-db065c242c5f", "run-0"), { recursive: true });

    const artifactsDir = path.join(paths.sessionsDir, "subagent-artifacts");
    fs.mkdirSync(path.join(artifactsDir, "progress", "9b20090b"), { recursive: true });
    // pi-subagents' cleanup throttle stamp: internal bookkeeping, not content.
    fs.writeFileSync(path.join(artifactsDir, ".last-cleanup"), "1794073319047", "utf-8");
    fs.writeFileSync(
      path.join(artifactsDir, "progress", "9b20090b", "progress.md"),
      "step 1",
      "utf-8",
    );

    const buffer = await finishArchive({ paths, projectName: "Archive test", sessions: [] });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);

    expect(names).not.toContain("subagents/artifacts/.last-cleanup");
    expect(names).toContain("subagents/artifacts/progress/9b20090b/progress.md");
  });

  it("attaches artifacts to the parent session that owns them", async () => {
    const paths = resolvePaths("default");
    const parentA = "01a1b672-2ab8-76c6-8045-6e04b79bdcde";
    const parentB = "01a19c50-3599-72cd-8c0f-738673b8a63d";
    for (const [parent, run] of [[parentA, "6f64286f-e855-4a04-bc97-db065c242c5f"], [parentB, "c8731449-465c-4e73-869f-5a6e120d5d2e"]]) {
      const dir = path.join(paths.sessionsDir, `2026-01-01T00-00-00-000Z_${parent}`, run, "run-0");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.jsonl"), JSON.stringify(message("assistant", "x")) + "\n");
    }

    const artifactsDir = path.join(paths.sessionsDir, "subagent-artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    // Each meta names its own run and parent; the siblings carry no metadata and
    // must be matched by the run id in their file name.
    fs.writeFileSync(
      path.join(artifactsDir, "6f64286f-e855-4a04-bc97-db065c242c5f_investigator_meta.json"),
      JSON.stringify({ runId: "6f64286f-e855-4a04-bc97-db065c242c5f", parentSessionId: parentA }),
    );
    fs.writeFileSync(
      path.join(artifactsDir, "6f64286f-e855-4a04-bc97-db065c242c5f_investigator_output.md"),
      "A output",
    );
    fs.writeFileSync(
      path.join(artifactsDir, "c8731449-465c-4e73-869f-5a6e120d5d2e_fact-checker_output.md"),
      "B output",
    );

    const buffer = await finishArchive({ paths, projectName: "Archive test", sessions: [] });
    const manifest = JSON.parse(zipText(new AdmZip(buffer), "subagents/manifest.json"));

    const a = manifest.sessions.find((s: { parentSessionId: string }) => s.parentSessionId === parentA);
    const b = manifest.sessions.find((s: { parentSessionId: string }) => s.parentSessionId === parentB);
    expect(a.runs[0].artifacts.map((x: { archived: string }) => x.archived)).toEqual([
      "subagents/artifacts/6f64286f-e855-4a04-bc97-db065c242c5f_investigator_meta.json",
      "subagents/artifacts/6f64286f-e855-4a04-bc97-db065c242c5f_investigator_output.md",
    ]);
    expect(b.runs[0].artifacts.map((x: { archived: string }) => x.archived)).toEqual([
      "subagents/artifacts/c8731449-465c-4e73-869f-5a6e120d5d2e_fact-checker_output.md",
    ]);
    expect(manifest.artifacts).toEqual([]);
  });

  it("keeps artifacts whose launch id matches no session directory under their parent", async () => {
    // In production the artifact's run id is the launch id, not the directory
    // UUID, so a run that died before writing session.jsonl leaves outputs
    // pointing at a parent whose run list has no matching entry.
    const paths = resolvePaths("default");
    const parent = "01a1b672-2ab8-76c6-8045-6e04b79bdcde";
    const sessionDir = path.join(
      paths.sessionsDir,
      `2026-01-01T00-00-00-000Z_${parent}`,
      "c8731449-465c-4e73-869f-5a6e120d5d2e",
      "run-0",
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.jsonl"), JSON.stringify(message("assistant", "x")) + "\n");

    const artifactsDir = path.join(paths.sessionsDir, "subagent-artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const orphanRun = "9b20090b-597f-4dc5-87f1-588ed42bd256";
    fs.writeFileSync(
      path.join(artifactsDir, `${orphanRun}_investigator_meta.json`),
      JSON.stringify({ runId: orphanRun, parentSessionId: parent }),
    );
    fs.writeFileSync(path.join(artifactsDir, `${orphanRun}_investigator_output.md`), "partial work");

    const buffer = await finishArchive({ paths, projectName: "Archive test", sessions: [] });
    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zipText(zip, "subagents/manifest.json"));

    const entry = manifest.sessions.find((s: { parentSessionId: string }) => s.parentSessionId === parent);
    // Both the meta and its meta-less sibling land under the parent, not dropped.
    expect(entry.ungrouped.map((x: { archived: string }) => x.archived).sort()).toEqual([
      `subagents/artifacts/${orphanRun}_investigator_meta.json`,
      `subagents/artifacts/${orphanRun}_investigator_output.md`,
    ]);
    // And both are still in the zip: attribution is metadata, not a filter.
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain(`subagents/artifacts/${orphanRun}_investigator_output.md`);
    expect(manifest.artifacts).toEqual([]);
  });
});

describe("GET /sandbox/download-all", () => {
  it("hides system files and dependency caches from the sandbox tree", async () => {
    const paths = ensureProjectExists("alpha");
    fs.mkdirSync(path.join(paths.sandbox, "node_modules", "package"), { recursive: true });
    fs.mkdirSync(path.join(paths.sandbox, "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(paths.sandbox, "analysis-venv", "lib"), { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "node_modules", "package", "index.js"), "");
    fs.writeFileSync(path.join(paths.sandbox, "__pycache__", "module.pyc"), "");
    fs.writeFileSync(path.join(paths.sandbox, "analysis-venv", "lib", "dependency.py"), "");
    fs.writeFileSync(path.join(paths.sandbox, "results.csv"), "value\n1\n");
    expect(fs.existsSync(path.join(paths.sandbox, "AGENTS.md"))).toBe(true);

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    const tree = JSON.stringify(response.json());
    expect(tree).toContain("results.csv");
    expect(tree).not.toContain("AGENTS.md");
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain("__pycache__");
    expect(tree).not.toContain("analysis-venv");

    const etag = response.headers.etag;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const unchanged = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: {
        "x-project-id": "alpha",
        "if-none-match": etag,
      },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
  });

  it("streams a directory ZIP through the folder download endpoint", async () => {
    const paths = ensureProjectExists("alpha");
    const directory = path.join(paths.sandbox, "dataset", "nested");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "dataset", "samples.csv"), "sample\n1\n");
    fs.writeFileSync(path.join(directory, "results.txt"), "complete");
    fs.writeFileSync(path.join(directory, ".hidden"), "private");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/download-dir?path=dataset",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toContain(
      'filename="dataset.zip"',
    );
    const names = new AdmZip(response.rawPayload)
      .getEntries()
      .map((entry) => entry.entryName);
    expect(names).toContain("samples.csv");
    expect(names).toContain("nested/results.txt");
    expect(names).not.toContain("nested/.hidden");
  });

  it("returns a scoped project archive through the existing download contract", async () => {
    const alpha = ensureProjectExists("alpha");
    const beta = ensureProjectExists("beta");
    fs.writeFileSync(path.join(alpha.sandbox, "alpha.txt"), "alpha", "utf-8");
    fs.writeFileSync(path.join(beta.sandbox, "beta.txt"), "beta", "utf-8");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/download-all",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toContain(
      'filename="sandbox.zip"',
    );
    const names = new AdmZip(response.rawPayload)
      .getEntries()
      .map((entry) => entry.entryName);
    expect(names).toContain("alpha.txt");
    expect(names).not.toContain("AGENTS.md");
    expect(names).not.toContain("beta.txt");
  });
});
