"use client";

import { FileTreePanel } from "@/components/sandbox-panel";
import { FilePreviewPanel, SettingsDialog, WorkflowsPanel } from "@/components/lazy-surfaces";
import type { Model } from "@/components/model-selector";
import { ChatTab, type ChatTabHandle, type ChatTabMeta } from "@/components/chat-tab";
import { ChatTabsBar, type ChatTabDescriptor } from "@/components/chat-tabs-bar";
import { ProjectSwitcher } from "@/components/project-switcher";
import { ProjectView } from "@/components/project-view";
import { SessionCostPill } from "@/components/session-cost-pill";
import { ResourceMonitor } from "@/components/resource-monitor";
import { useSessionCost } from "@/lib/use-session-cost";
import { useProjectCost } from "@/lib/use-project-cost";
import { useProjectActivities } from "@/lib/use-project-activities";
import { useModalJobs } from "@/lib/use-modal-jobs";
import { useProjects } from "@/lib/use-projects";
import { APP_VERSION, isVersioned, useUpdateCheck } from "@/lib/version";
import { useSkills } from "@/lib/use-skills";
import { flattenFiles, flattenFolders, useSandbox } from "@/lib/use-sandbox";
import { ProjectScopeProvider } from "@/lib/projects";
import { consumeDialogRestoreRequest, consumeScreenRestoreRequest } from "@/lib/i18n/locale";
import {
  hasProjectActivity,
  sameProjectActivity,
  summarizeProjectActivity,
  type ProjectActivitySummary,
} from "@/lib/project-activity";
import { onChatPrefill } from "@/lib/chat-prefill";
import { onOpenSettings, readLastSettingsTab, type OpenSettingsRequest } from "@/lib/settings-nav";
import {
  OPEN_MODAL_JOB_EVENT,
  type ModalComputeScope,
} from "@/lib/modal-jobs";
import { isJunkFilePath } from "@/lib/utils";
import {
  PanelLeftIcon,
  PanelRightIcon,
  SettingsIcon,
  ServerCogIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  deletePersistedChatState,
  loadWorkspaceSnapshot,
  pruneDeletedProjectState,
  readShellStateSync,
  revokeSnapshotObjectUrls,
  saveProjectWorkspaceState,
  saveWorkspaceShellState,
  type ChatWorkspaceState,
  type ProjectWorkspaceState,
  type SandboxWorkspaceState,
  type WorkspaceScreen,
} from "@/lib/workspace-persistence";
import { seedChatStateFromTab } from "@/lib/new-tab-state";
import { useIsomorphicLayoutEffect } from "@/lib/use-isomorphic-layout-effect";
import {
  DEFAULT_CHAT_WIDTH,
  DEFAULT_TREE_WIDTH,
  DEFAULT_TRANSCRIPT_WIDTH,
  PANEL_HANDLE_WIDTH,
  clampPanelWidth,
  fitPanelWidths,
  handleTarget,
  splitPairWidths,
  usePanelOrder,
  type HandleTarget,
  type PanelId,
} from "@/lib/panel-order";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const MAX_CHAT_TABS = 10;

/**
 * Sent by the sandbox "Auto-organize files" wand. Moving a data file silently
 * breaks every script that read it by relative path, so the prompt makes the
 * agent plan first, never delete, and fix references it moved out from under.
 */
const ORGANIZE_FILES_PROMPT =
  "Organize the files in the sandbox into a clear folder structure (for example raw data, scripts, figures, results, notebooks). " +
  "First list the moves you intend to make, then carry them out. Do not delete anything, and leave dotfiles, config, lock files, and virtual environments in place. " +
  "After moving, update relative paths in any scripts, notebooks, or documents that referenced the moved files, and finish with a short summary of what moved where.";

interface ChatTabEntry {
  id: string;
  title: string;
  /** Stored session reopened into this tab (History menu), if any. */
  sessionId?: string;
}

/** Stable id for the first tab so SSR and hydration match. */
const INITIAL_TAB_ID = "tab-initial";

function makeTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTabTitle(index: number): string {
  return `Chat ${index + 1}`;
}

// Thin vertical divider between two panels. The middle band resizes the
// fixed-width pane beside it; the two ends swap the pair. Resize is the large
// target on purpose — swap is the occasional action, resizing is the one
// people reach for while reading.
function ResizeHandle({ onMouseDown, onSwap }: {
  onMouseDown: (e: React.MouseEvent) => void;
  onSwap: () => void;
}) {
  return (
    <div className="group relative z-10 flex w-2 shrink-0 flex-col bg-border">
      {/* Highlights come from `muted-foreground`, which is a mid grey in the
          light theme and a near-white in the dark one, so the same class reads
          correctly either way. A fixed blue did not. */}
      <button
        type="button"
        onClick={onSwap}
        aria-label="Swap panels"
        title="Swap panels"
        className="h-[20%] w-full cursor-pointer transition-colors hover:bg-muted-foreground/30"
      />
      {/* The grip highlights only from the resize band's own hover, so a
          pointer over a swap end must not light it up. */}
      <div
        className="group/resize flex flex-1 cursor-col-resize items-center justify-center transition-colors hover:bg-muted-foreground/30 active:bg-muted-foreground/45"
        onMouseDown={onMouseDown}
      >
        <span className="h-8 w-0.5 rounded-full bg-muted-foreground/25 transition-colors group-hover/resize:bg-muted-foreground" />
      </div>
      <button
        type="button"
        onClick={onSwap}
        aria-label="Swap panels"
        title="Swap panels"
        className="h-[20%] w-full cursor-pointer transition-colors hover:bg-muted-foreground/30"
      />
    </div>
  );
}

export default function HomePage() {
  // The reload a language switch triggers must reopen where the user was, and
  // it has to do so without a visible flash. Both constraints push the read
  // out of a `useState` initialiser: the first render is also the hydration
  // pass, so reading `localStorage` there made the client render the workspace
  // around server HTML that described the overview, which React reports as a
  // hydration mismatch and refuses to patch. A layout effect runs after
  // hydration but before the browser paints, so the restore lands on the first
  // frame the user can see. A plain launch or refresh has no marker and still
  // starts on the overview.
  const [screen, setScreen] = useState<WorkspaceScreen>("projects");
  const [openedProjectIds, setOpenedProjectIds] = useState<string[]>([]);
  const [restoreRequested, setRestoreRequested] = useState(false);
  // Which surface owns the restored dialog. A screen id rather than a boolean:
  // the dialog must reopen where the user left it, and — because switching to
  // the other surface later in the session must not pop it again — the value
  // is claimed by exactly one owner.
  const [restoreSettingsFor, setRestoreSettingsFor] = useState<
    "projects" | "workspace" | null
  >(null);

  useIsomorphicLayoutEffect(() => {
    const shell = readShellStateSync();
    const restoreWorkspace =
      consumeScreenRestoreRequest() &&
      shell.screen === "workspace" &&
      shell.openedProjectIds.length > 0;
    if (restoreWorkspace) {
      setRestoreRequested(true);
      setScreen("workspace");
      setOpenedProjectIds(shell.openedProjectIds);
    }
    if (consumeDialogRestoreRequest() === "settings") {
      // Settings is only ever opened from one surface, so the restored screen
      // is the owner — and it has to reuse the same test, or a workspace that
      // could not be restored would hand the dialog to a surface not mounted.
      setRestoreSettingsFor(restoreWorkspace ? "workspace" : "projects");
    }
  }, []);

  // One owner claims the restored dialog and reports back, so a later switch
  // to the other surface does not reopen it.
  const clearRestoreSettings = useCallback(() => setRestoreSettingsFor(null), []);

  const [restoredProjects, setRestoredProjects] = useState<
    Record<string, ProjectWorkspaceState>
  >({});
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [projectDirectoryHydrated, setProjectDirectoryHydrated] = useState(false);
  const [projectActivities, setProjectActivities] = useState<
    Record<string, ProjectActivitySummary>
  >({});
  const {
    activeProjectId,
    projects,
    loading: projectsLoading,
    error: projectsError,
  } = useProjects();
  const serverProjectActivities = useProjectActivities(
    workspaceHydrated && screen === "projects",
  );
  const displayedProjectActivities = useMemo(
    () => ({ ...serverProjectActivities, ...projectActivities }),
    [projectActivities, serverProjectActivities],
  );

  useEffect(() => {
    if (!projectsLoading) setProjectDirectoryHydrated(true);
  }, [projectsLoading]);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceSnapshot().then((snapshot) => {
      if (cancelled) {
        // Nothing will consume (or revoke) the restored attachment blob URLs.
        revokeSnapshotObjectUrls(snapshot);
        return;
      }
      setRestoredProjects(snapshot.projects);
      // The screen itself was already restored synchronously above; this only
      // re-applies the project list once the snapshot confirms which projects
      // still exist, so a project deleted between the two reads cannot
      // resurrect as an empty workspace.
      if (restoreRequested && snapshot.openedProjectIds.length > 0) {
        setOpenedProjectIds(snapshot.openedProjectIds);
      }
      setWorkspaceHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [restoreRequested]);

  const rememberProject = useCallback((projectId: string) => {
    setOpenedProjectIds((prev) => (
      prev.includes(projectId) ? prev : [...prev, projectId]
    ));
  }, []);

  const openProject = useCallback((projectId: string) => {
    rememberProject(projectId);
    setScreen("workspace");
  }, [rememberProject]);

  const handleProjectActivityChange = useCallback(
    (projectId: string, activity: ProjectActivitySummary) => {
      setProjectActivities((prev) => {
        const existing = prev[projectId];
        if (!hasProjectActivity(activity)) {
          if (!existing) return prev;
          const next = { ...prev };
          delete next[projectId];
          return next;
        }
        if (sameProjectActivity(existing, activity)) return prev;
        return { ...prev, [projectId]: activity };
      });
    },
    [],
  );

  // ProjectSwitcher changes the global selection from inside the currently
  // visible workspace. Mount the destination workspace without unmounting the
  // source, so any live SSE stream in the source keeps running.
  useEffect(() => {
    if (workspaceHydrated && screen === "workspace") rememberProject(activeProjectId);
  }, [activeProjectId, rememberProject, screen, workspaceHydrated]);

  // A deleted project must release its mounted workspace and persisted shell
  // state. The DELETE endpoint explicitly aborts its server-owned runs first;
  // this unmount only disconnects browser-side event observers.
  useEffect(() => {
    if (projectsLoading || !workspaceHydrated) return;
    // A failed or empty list is not "every project was deleted". On a fetch
    // error `projects` keeps its initial [] with loading=false, and the server
    // always has at least the default project, so pruning against an empty
    // set would wipe every project's persisted workspace on a backend blip.
    if (projectsError || projects.length === 0) return;
    const existing = new Set(projects.map((project) => project.id));
    setOpenedProjectIds((prev) => {
      const next = prev.filter((id) => existing.has(id));
      return next.length === prev.length ? prev : next;
    });
    setProjectActivities((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => existing.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setRestoredProjects((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => existing.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    void pruneDeletedProjectState(existing);
  }, [projects, projectsError, projectsLoading, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceShellState(screen, openedProjectIds);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [openedProjectIds, screen, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const flush = () => {
      void saveWorkspaceShellState(screen, openedProjectIds);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [openedProjectIds, screen, workspaceHydrated]);

  return (
    <>
      <div
        className={screen === "projects" ? "contents" : "hidden"}
        aria-hidden={screen !== "projects"}
      >
        <ProjectView
          isActive={screen === "projects"}
          onOpenProject={openProject}
          projectActivities={displayedProjectActivities}
          restoreSettingsOpen={restoreSettingsFor === "projects"}
          onRestoreSettingsHandled={clearRestoreSettings}
        />
      </div>
      {projectDirectoryHydrated && openedProjectIds.map((projectId) => {
        const isActive = screen === "workspace" && projectId === activeProjectId;
        return (
          <ProjectScopeProvider key={projectId} value={projectId}>
            <div className={isActive ? "contents" : "hidden"} aria-hidden={!isActive}>
              <WorkspacePage
                projectId={projectId}
                isActive={isActive}
                hydrated={workspaceHydrated}
                initialState={restoredProjects[projectId]}
                restoreSettingsOpen={restoreSettingsFor === "workspace" && isActive}
                onRestoreSettingsHandled={clearRestoreSettings}
                onProjectActivityChange={handleProjectActivityChange}
                onOpenProjectView={() => setScreen("projects")}
              />
            </div>
          </ProjectScopeProvider>
        );
      })}
    </>
  );
}

function WorkspacePage({
  projectId,
  isActive,
  hydrated,
  initialState,
  restoreSettingsOpen,
  onRestoreSettingsHandled,
  onProjectActivityChange,
  onOpenProjectView,
}: {
  projectId: string;
  isActive: boolean;
  hydrated: boolean;
  initialState?: ProjectWorkspaceState;
  /** The language switch reloaded while Settings was open in this workspace. */
  restoreSettingsOpen?: boolean;
  /** Called once the restored dialog has been shown, so the shell can drop it. */
  onRestoreSettingsHandled?: () => void;
  onProjectActivityChange: (
    projectId: string,
    activity: ProjectActivitySummary,
  ) => void;
  onOpenProjectView: () => void;
}) {
  const [sandboxWorkspace, setSandboxWorkspace] = useState<SandboxWorkspaceState>(
    () => initialState?.sandbox ?? { openPaths: [], activePath: null },
  );
  const handleSandboxWorkspaceChange = useCallback((next: SandboxWorkspaceState) => {
    setSandboxWorkspace((current) =>
      current.activePath === next.activePath &&
      current.openPaths.length === next.openPaths.length &&
      current.openPaths.every((path, index) => path === next.openPaths[index])
        ? current
        : next,
    );
  }, []);
  const sandbox = useSandbox(
    isActive,
    undefined,
    initialState?.sandbox,
    handleSandboxWorkspaceChange,
  );
  const { updateAvailable } = useUpdateCheck();
  const { skills: allSkills, loading: skillsLoading } = useSkills();
  const { projects: projectDirectory } = useProjects();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(
    () => initialState?.sandboxOpen ?? true,
  );
  const [chatOpen, setChatOpen] = useState(
    () => initialState?.chatOpen ?? true,
  );
  const [previewOpen, setPreviewOpen] = useState(
    () => initialState?.previewOpen ?? true,
  );
  const toggleSandbox = useCallback(() => setSandboxOpen((value) => !value), []);
  const toggleChat = useCallback(() => setChatOpen((value) => !value), []);
  const togglePreview = useCallback(() => setPreviewOpen((value) => !value), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<OpenSettingsRequest | null>(null);

  // Same reason as ProjectView: the restore marker is read in the shell's
  // layout effect, one render after mount, so this prop is not available to a
  // `useState` initialiser. The tab is restored too — a dialog on its default
  // tab loses the place the user was reading.
  useIsomorphicLayoutEffect(() => {
    if (!restoreSettingsOpen) return;
    setSettingsRequest({ tab: readLastSettingsTab() ?? undefined });
    setSettingsOpen(true);
    onRestoreSettingsHandled?.();
  }, [restoreSettingsOpen, onRestoreSettingsHandled]);
  const [showNotebook, setShowNotebook] = useState(
    () => initialState?.showNotebook ?? false,
  );
  const [showAutomation, setShowAutomation] = useState(
    () => initialState?.showAutomation ?? false,
  );
  const [showCompute, setShowCompute] = useState(
    () => initialState?.showCompute ?? false,
  );
  const [computeScope, setComputeScope] = useState<ModalComputeScope>(
    () => initialState?.computeScope ?? "project",
  );

  // Chat tab management. We allocate the initial id once via useRef so it
  // stays stable across React's strict-mode double-invocation of
  // useState's lazy initializer (which would otherwise mint two different
  // ids — one for the tabs array and one for activeTabId).
  const initialTabId = INITIAL_TAB_ID;
  const [tabs, setTabs] = useState<ChatTabEntry[]>(() =>
    initialState?.tabs.length
      ? initialState.tabs.map(({ id, title, sessionId }) => ({ id, title, sessionId }))
      : [{ id: initialTabId, title: defaultTabTitle(0) }],
  );
  const [activeTabId, setActiveTabId] = useState<string>(
    () => initialState?.activeTabId ?? initialTabId,
  );
  const [view, setView] = useState<"chat" | "workflows">(
    () => initialState?.view ?? "chat",
  );
  const [tabWorkspaceStates, setTabWorkspaceStates] = useState<
    Record<string, ChatWorkspaceState>
  >(() =>
    Object.fromEntries(
      (initialState?.tabs ?? []).flatMap((tab) =>
        tab.chat ? [[tab.id, tab.chat] as const] : [],
      ),
    ),
  );
  // Mirror of tabs in a ref so synchronous handlers can read length without
  // putting impure logic inside a setState updater (which strict mode runs
  // twice for purity testing).
  const tabsRef = useRef(tabs);
  // Same ref trick for what newTab seeds a fresh tab from; both change often
  // and neither should re-create the callback.
  const tabWorkspaceStatesRef = useRef(tabWorkspaceStates);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    tabWorkspaceStatesRef.current = tabWorkspaceStates;
  }, [tabWorkspaceStates]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Per-tab agent meta, populated by each <ChatTab> via onMetaChange. We
  // read from this to drive the cost pill and tab
  // strip badges (streaming spinner, message count) for the active tab.
  const [tabsMeta, setTabsMeta] = useState<Record<string, ChatTabMeta>>({});
  const tabHandles = useRef<Map<string, ChatTabHandle | null>>(new Map());
  // Stable per-tab ref callbacks so React doesn't repeatedly clear+set the
  // tab handle map on every render (inline `ref={(h) => ...}` would).
  const tabRefCallbacks = useRef<
    Map<string, (handle: ChatTabHandle | null) => void>
  >(new Map());
  const getTabRefCallback = useCallback(
    (id: string) => {
      let cb = tabRefCallbacks.current.get(id);
      if (!cb) {
        cb = (handle: ChatTabHandle | null) => {
          if (handle) tabHandles.current.set(id, handle);
          else tabHandles.current.delete(id);
        };
        tabRefCallbacks.current.set(id, cb);
      }
      return cb;
    },
    [],
  );

  // Bumped whenever any chat tab finishes a turn, so the cost pill (which
  // tracks the active tab's session) refetches.
  const [costRefreshKey, setCostRefreshKey] = useState(0);

  const handleMetaChange = useCallback(
    (tabId: string, meta: ChatTabMeta) => {
      if (meta.sessionId) {
        setTabs((current) => {
          if (!current.some((tab) => tab.id === tabId && tab.sessionId !== meta.sessionId)) {
            return current;
          }
          return current.map((tab) =>
            tab.id === tabId && tab.sessionId !== meta.sessionId
              ? { ...tab, sessionId: meta.sessionId ?? undefined }
              : tab,
          );
        });
      }
      setTabsMeta((prev) => {
        const existing = prev[tabId];
        // Token deltas stay local to ChatTab. Only workspace-visible state
        // crosses this boundary; notebook-only updates must still propagate.
        if (
          existing &&
          existing.sessionId === meta.sessionId &&
          existing.status === meta.status &&
          existing.runState === meta.runState &&
          existing.isStreaming === meta.isStreaming &&
          existing.userMessageCount === meta.userMessageCount &&
          existing.needsInput === meta.needsInput &&
          existing.notebookEntries === meta.notebookEntries &&
          existing.subagentCompletions === meta.subagentCompletions
        ) {
          return prev;
        }
        return { ...prev, [tabId]: meta };
      });
    },
    [],
  );

  const handleTabWorkspaceStateChange = useCallback(
    (tabId: string, state: ChatWorkspaceState) => {
      setTabWorkspaceStates((current) =>
        current[tabId] === state ? current : { ...current, [tabId]: state },
      );
    },
    [],
  );

  const handleTurnComplete = useCallback(() => {
    setCostRefreshKey((k) => k + 1);
  }, []);

  // Pull out the two sandbox functions we re-trigger on turn completion.
  // Destructuring keeps the deps stable below — useSandbox returns a new
  // object literal each render, so depending on `sandbox` directly would
  // make `handleSandboxRefresh` change identity every render.
  const {
    fetchTree: sandboxFetchTree,
    refreshOpenTabs: sandboxRefreshOpenTabs,
    selectFile: sandboxSelectFile,
  } = sandbox;
  const handleSandboxRefresh = useCallback(() => {
    sandboxFetchTree();
    sandboxRefreshOpenTabs();
  }, [sandboxFetchTree, sandboxRefreshOpenTabs]);

  useEffect(() => setMounted(true), []);

  // Drive sandbox polling cadence off the active tab's streaming state
  // (the live-poll mode used to be hard-wired to the single chat).
  const activeMeta = tabsMeta[activeTabId];
  const notebookEntries = activeMeta?.notebookEntries ?? [];
  const notebookStreaming = activeMeta?.isStreaming ?? false;
  const subagentCompletions = activeMeta?.subagentCompletions ?? 0;
  const anyStreaming = useMemo(
    () => Object.values(tabsMeta).some((m) => m.isStreaming),
    [tabsMeta],
  );
  // While any tab is streaming, poll the active sandbox more aggressively so
  // the file tree + open previews update as the agent writes files. Hidden
  // projects keep their SSE streams mounted but catch up when reopened.
  useEffect(() => {
    if (!isActive || !anyStreaming) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) await Promise.all([sandboxFetchTree(), sandboxRefreshOpenTabs()]);
      if (!cancelled) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [anyStreaming, isActive, sandboxFetchTree, sandboxRefreshOpenTabs]);

  const [treeWidth, setTreeWidth] = useState(
    () => initialState?.treeWidth ?? DEFAULT_TREE_WIDTH,
  );
  const [chatWidth, setChatWidth] = useState(
    () => initialState?.chatWidth ?? DEFAULT_CHAT_WIDTH,
  );
  const [transcriptWidth, setTranscriptWidth] = useState(
    () => initialState?.transcriptWidth ?? DEFAULT_TRANSCRIPT_WIDTH,
  );
  const [panelOrder, setPanelOrder] = usePanelOrder();
  const swapPanels = useCallback((left: PanelId, right: PanelId) => {
    setPanelOrder((current) => {
      const li = current.indexOf(left);
      const ri = current.indexOf(right);
      if (li < 0 || ri < 0) return current;
      const next = [...current];
      [next[li], next[ri]] = [next[ri], next[li]];
      return next;
    });
  }, [setPanelOrder]);
  // Which panes are on screen, in the user's order. The preview is the one
  // pane with no close control in the header, but it can still be collapsed
  // from Settings — see `previewOpen`.
  const visiblePanels = useMemo(
    () =>
      panelOrder.filter((id) =>
        id === "tree" ? sandboxOpen : id === "chat" ? chatOpen : previewOpen,
      ),
    [panelOrder, sandboxOpen, chatOpen, previewOpen],
  );
  const [isResizing, setIsResizing] = useState(false);
  const dragging = useRef<HandleTarget | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  // A `pair` drag moves width between the two panes rather than growing one:
  // `dragStartSum` is what they had together, so it stays what they have.
  const dragStartOtherWidth = useRef(0);
  // Width of the column area, so a drag cannot starve the preview. Read from
  // the DOM rather than tracked in state: it changes on window resizes that
  // React is not otherwise reacting to.
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const availableWidth = useCallback(
    () => columnsRef.current?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY,
    [],
  );

  // Widths saved on a wide window would otherwise follow the user onto a
  // narrow one and squeeze the preview to a sliver. The shrink is a render-time
  // derivation, not a write: the stored widths stay what the user picked, so
  // widening the window again restores them.
  const [columnArea, setColumnArea] = useState(Number.POSITIVE_INFINITY);
  useIsomorphicLayoutEffect(() => {
    const node = columnsRef.current;
    if (!node) return;
    const measure = () => setColumnArea(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const fittedWidths = useMemo(
    () =>
      fitPanelWidths(
        { tree: treeWidth, chat: chatWidth },
        { tree: sandboxOpen, chat: chatOpen, preview: previewOpen },
        columnArea,
      ),
    [treeWidth, chatWidth, sandboxOpen, chatOpen, previewOpen, columnArea],
  );
  const treePx = fittedWidths.tree;
  const chatPx = fittedWidths.chat;
  // The preview normally grows into whatever the fixed-width panes leave. With
  // it collapsed nothing would grow, so the last remaining pane takes the job
  // and keeps its own width as the floor.
  const filler = previewOpen ? null : visiblePanels[visiblePanels.length - 1];

  const startDrag = useCallback((target: HandleTarget) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = target;
    dragStartX.current = e.clientX;
    // Start from what is on screen, not from the stored preference: on a
    // narrow window the fit has already shrunk the pane, and starting from the
    // stored value would make the pane jump on the first pointer move.
    if (target.kind === "pair") {
      dragStartWidth.current = target.left === "tree" ? treePx : chatPx;
      dragStartOtherWidth.current = target.right === "tree" ? treePx : chatPx;
    } else {
      dragStartWidth.current = target.panel === "tree" ? treePx : chatPx;
      dragStartOtherWidth.current = target.panel === "tree" ? (chatOpen ? chatPx : 0) : (sandboxOpen ? treePx : 0);
    }
    setIsResizing(true);
  }, [treePx, chatPx, sandboxOpen, chatOpen]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const target = dragging.current;
      if (!target) return;
      const delta = (e.clientX - dragStartX.current) * (target.kind === "pair" ? 1 : target.sign);
      if (target.kind === "pair") {
        // Both panes are fixed width, so this is a split of a fixed total, not
        // a resize: growing the left pane has to shrink the right one.
        const split = splitPairWidths(
          target.left,
          target.right,
          dragStartWidth.current + delta,
          dragStartWidth.current + dragStartOtherWidth.current,
        );
        if (target.left === "tree") { setTreeWidth(split.left); setChatWidth(split.right); }
        else { setChatWidth(split.left); setTreeWidth(split.right); }
        return;
      }
      // The other fixed-width pane keeps its width. `clampPanelWidth` takes off
      // the preview's floor itself, which is right here because a `single`
      // target only exists while the preview is on screen. The dividers are
      // flex children too, so their width has to come off as well or the drag
      // can push the preview below its floor by exactly that much.
      const dividers = (visiblePanels.length - 1) * PANEL_HANDLE_WIDTH;
      const room = availableWidth() - dragStartOtherWidth.current - dividers;
      if (target.panel === "tree") {
        setTreeWidth(clampPanelWidth("tree", dragStartWidth.current + delta, room));
      } else {
        setChatWidth(clampPanelWidth("chat", dragStartWidth.current + delta, room));
      }
    };
    const onUp = () => {
      dragging.current = null;
      setIsResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  // The settings slider and the divider drag have to agree. With the preview
  // on screen the other pane keeps its width and only the preview's floor
  // limits the value. With the preview collapsed the two panes share the whole
  // row, so growing one must shrink the other — otherwise the slider would set
  // a width the layout cannot honour and the neighbour would look stuck.
  const setPanelWidth = useCallback(
    (panel: "tree" | "chat", value: number) => {
      const dividers = Math.max(0, visiblePanels.length - 1) * PANEL_HANDLE_WIDTH;
      const otherPanel = panel === "tree" ? "chat" : "tree";
      const otherOpen = otherPanel === "tree" ? sandboxOpen : chatOpen;
      if (!previewOpen && otherOpen) {
        const otherWidth = otherPanel === "tree" ? treePx : chatPx;
        const total = availableWidth() - dividers;
        const split = splitPairWidths(panel, otherPanel, value, Math.max(total, 0));
        if (panel === "tree") {
          setTreeWidth(split.left);
          setChatWidth(split.right);
        } else {
          setChatWidth(split.left);
          setTreeWidth(split.right);
        }
        return;
      }
      const other = otherOpen ? (otherPanel === "tree" ? treePx : chatPx) : 0;
      const room = availableWidth() - other - dividers;
      if (panel === "tree") setTreeWidth(clampPanelWidth("tree", value, room));
      else setChatWidth(clampPanelWidth("chat", value, room));
    },
    [
      availableWidth,
      previewOpen,
      sandboxOpen,
      chatOpen,
      treePx,
      chatPx,
      visiblePanels.length,
    ],
  );

  const projectWorkspaceState = useMemo<ProjectWorkspaceState>(
    () => ({
      tabs: tabs.map((tab) => ({
        ...tab,
        ...(tabWorkspaceStates[tab.id]
          ? { chat: tabWorkspaceStates[tab.id] }
          : {}),
      })),
      activeTabId,
      view,
      showNotebook,
      showCompute,
      showAutomation,
      computeScope,
      sandboxOpen,
      chatOpen,
      previewOpen,
      treeWidth,
      chatWidth,
      transcriptWidth,
      sandbox: sandboxWorkspace,
    }),
    [
      activeTabId,
      chatOpen,
      chatWidth,
      previewOpen,
      computeScope,
      sandboxOpen,
      sandboxWorkspace,
      showAutomation,
      showCompute,
      showNotebook,
      tabWorkspaceStates,
      tabs,
      transcriptWidth,
      treeWidth,
      view,
    ],
  );
  const projectWorkspaceStateRef = useRef(projectWorkspaceState);
  projectWorkspaceStateRef.current = projectWorkspaceState;

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveProjectWorkspaceState(projectId, projectWorkspaceState);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [hydrated, projectId, projectWorkspaceState]);

  useEffect(() => {
    if (!hydrated) return;
    const flush = () => {
      void saveProjectWorkspaceState(projectId, projectWorkspaceStateRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [hydrated, projectId]);

  // Ask Kady handoff: the active tab's composer (mounted even behind the
  // Workflows view) appends the text; this listener makes it visible.
  useEffect(() => {
    if (!isActive) return;
    return onChatPrefill(() => setView("chat"));
  }, [isActive]);

  // Deep links into Settings ("raise the limit in project settings", …).
  useEffect(() => {
    if (!isActive) return;
    return onOpenSettings((request) => {
      setSettingsRequest(request);
      setSettingsOpen(true);
    });
  }, [isActive]);

  // Flat list of all sandbox file paths for @ mentions (shared across tabs).
  // Cache artifacts are excluded — mentioning __pycache__/*.pyc is never useful.
  const allFiles = useMemo(
    () => flattenFiles(sandbox.tree).filter((p) => !isJunkFilePath(p)),
    [sandbox.tree],
  );
  const allFolders = useMemo(
    () => flattenFolders(sandbox.tree).filter((p) => !isJunkFilePath(p)),
    [sandbox.tree],
  );

  // ------------------------------------------------------------------
  // Tab management callbacks
  // ------------------------------------------------------------------

  const newTab = useCallback(() => {
    // Mint the id OUTSIDE any setState updater. Strict mode invokes
    // updaters twice for purity testing, which would otherwise produce
    // two different ids on a single click — the array would commit one
    // id while setActiveTabId got the other, leaving every tab with
    // isActive=false and display:none.
    if (tabsRef.current.length >= MAX_CHAT_TABS) return;
    const id = makeTabId();
    // A new chat continues the same piece of work far more often than it
    // switches models, so carry the active tab's model, thinking level, and
    // compute target over instead of resetting to the app defaults. Drafts,
    // attachments, and queued prompts stay with the tab they belong to.
    const seeded = seedChatStateFromTab(
      tabWorkspaceStatesRef.current[activeTabIdRef.current],
    );
    if (seeded) {
      setTabWorkspaceStates((prev) => ({ ...prev, [id]: seeded }));
    }
    setTabs((prev) =>
      prev.length >= MAX_CHAT_TABS
        ? prev
        : [...prev, { id, title: defaultTabTitle(prev.length) }],
    );
    setActiveTabId(id);
    setView("chat");
  }, []);

  const closeTab = useCallback((id: string) => {
    // Abort an in-flight stream so the agent doesn't keep running into a
    // detached component. Safe to call on a non-streaming tab too.
    tabHandles.current.get(id)?.stop();
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((curr) => {
        if (curr !== id) return curr;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback?.id ?? next[0].id;
      });
      return next;
    });
    tabHandles.current.delete(id);
    tabRefCallbacks.current.delete(id);
    setTabsMeta((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    setTabWorkspaceStates((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    void deletePersistedChatState(projectId, id);
  }, [projectId]);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title } : t)),
    );
  }, []);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setView("chat");
  }, []);

  // A tab whose stored session no longer exists on disk: keep the tab, drop the
  // binding, so it stops being treated as that session (dedupe, History focus)
  // and stops re-requesting it on every reload.
  const forgetTabSession = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id || !t.sessionId) return t;
        const { sessionId: _dropped, ...rest } = t;
        void _dropped;
        return rest;
      }),
    );
  }, []);

  // Reopen a stored session (History menu). If some tab already holds that
  // session, just focus it — two tabs must never share one session.
  const openSession = useCallback(
    (sessionId: string, title: string) => {
      // Check the tab descriptors as well as reported meta: a restored or
      // just-opened tab carries its sessionId before its ChatTab has mounted
      // and reported meta, and matching on meta alone let the same session be
      // opened into a second tab.
      const openTabId =
        tabsRef.current.find((t) => t.sessionId === sessionId)?.id ??
        Object.entries(tabsMeta).find(([, meta]) => meta.sessionId === sessionId)?.[0];
      if (openTabId) {
        setActiveTabId(openTabId);
        setView("chat");
        return;
      }
      if (tabsRef.current.length >= MAX_CHAT_TABS) return;
      const id = makeTabId();
      setTabs((prev) =>
        prev.length >= MAX_CHAT_TABS ? prev : [...prev, { id, title, sessionId }],
      );
      setActiveTabId(id);
      setView("chat");
    },
    [tabsMeta],
  );

  // ------------------------------------------------------------------
  // Workflow launch — routes to the active chat tab via its imperative
  // handle and switches the view back to "chat".
  // ------------------------------------------------------------------

  const handleWorkflowLaunch = useCallback(
    async (prompt: string, model: Model, inputFiles: string[]) => {
      const handle = tabHandles.current.get(activeTabId);
      if (!handle) return;
      setView("chat");
      await handle.launchWorkflow(prompt, model, inputFiles);
    },
    [activeTabId],
  );

  const handleFileSelect = useCallback((path: string) => {
    sandboxSelectFile(path);
    setShowNotebook(false);
    setShowCompute(false);
    setShowAutomation(false);
  }, [sandboxSelectFile]);
  const handleOrganizeFiles = useCallback(() => {
    const handle = tabHandles.current.get(activeTabId);
    if (!handle) return;
    setView("chat");
    void handle.sendQuick(ORGANIZE_FILES_PROMPT);
  }, [activeTabId]);

  // ------------------------------------------------------------------
  // Chat ↔ notebook deep links (join key: tool-call id === entry id).
  // ------------------------------------------------------------------
  const [notebookFocus, setNotebookFocus] = useState<{ id: string; token: number } | null>(null);
  const handleViewInNotebook = useCallback((entryId: string) => {
    setShowCompute(false);
    setShowAutomation(false);
    setShowNotebook(true);
    setNotebookFocus({ id: entryId, token: Date.now() });
  }, []);
  const [computeFocus, setComputeFocus] = useState<{ id: string; token: number } | null>(null);
  const handleViewCompute = useCallback((jobId?: string) => {
    setShowNotebook(false);
    setShowAutomation(false);
    setShowCompute(true);
    if (jobId) setComputeFocus({ id: jobId, token: Date.now() });
  }, []);
  useEffect(() => {
    if (!isActive) return;
    const onOpenJob = (event: Event) => {
      const jobId = (
        event as CustomEvent<{ jobId?: string }>
      ).detail?.jobId;
      handleViewCompute(jobId);
    };
    window.addEventListener(OPEN_MODAL_JOB_EVENT, onOpenJob);
    return () => window.removeEventListener(OPEN_MODAL_JOB_EVENT, onOpenJob);
  }, [handleViewCompute, isActive]);
  const handleNotebookJumpToChat = useCallback(
    (entryId: string) => {
      // Un-hide the chat column without toggling it closed, then scroll once
      // display:none has lifted (scrollIntoView no-ops on hidden elements).
      setChatOpen(true);
      setView("chat");
      setTimeout(() => {
        const ok = tabHandles.current.get(activeTabId)?.scrollToToolCall(entryId) ?? false;
        if (!ok) toast.error("Couldn't find this entry in the chat transcript.");
      }, 50);
    },
    [activeTabId],
  );

  // ------------------------------------------------------------------
  // Header pieces — cost pill — read from the active tab.
  // ------------------------------------------------------------------

  const activeSessionId = activeMeta?.sessionId ?? null;
  // A jump targets the chat it came from; a notebook view remounting under
  // another chat must not replay it ("That notebook entry isn't in this chat").
  useEffect(() => { setNotebookFocus(null); }, [activeSessionId]);
  const {
    activeCount: activeModalJobCount,
    loading: modalJobsLoading,
  } = useModalJobs({ projectId, enabled: isActive, limit: 200 });

  // Async subagents are ledgered when the child finishes, which can be long
  // after the parent turn ended. Without this the pill under-reported spend
  // until the next turn.
  const totalSubagentCompletions = useMemo(
    () =>
      Object.values(tabsMeta).reduce(
        (sum, meta) => sum + (meta.subagentCompletions ?? 0),
        0,
      ),
    [tabsMeta],
  );
  useEffect(() => {
    if (totalSubagentCompletions === 0) return;
    setCostRefreshKey((k) => k + 1);
  }, [totalSubagentCompletions]);

  const { summary: costSummary, loading: costLoading } = useSessionCost(
    activeSessionId,
    costRefreshKey,
  );
  const { summary: projectCost, loading: projectCostLoading } =
    useProjectCost(costRefreshKey);
  const directorySpendLimit = projectDirectory.find(
    (project) => project.id === projectId,
  )?.spendLimitUsd;
  // Match the server's admission rule: it compares *committed* money (ledgered
  // + compute reservations + in-flight runs) against the cap, and treats a
  // non-positive limit as unlimited.
  const committedUsd = projectCost.budget.committedUsd ?? projectCost.budget.totalUsd;
  const budgetBlocked =
    directorySpendLimit === undefined
      ? projectCost.budget.state === "exceeded"
      : directorySpendLimit !== null &&
        directorySpendLimit > 0 &&
        committedUsd >= directorySpendLimit;
  const projectActivity = useMemo(
    () =>
      summarizeProjectActivity(
        Object.values(tabsMeta).map((meta) => ({
          isStreaming: meta.isStreaming,
          runState: meta.runState,
          needsInput: meta.needsInput,
        })),
        budgetBlocked,
      ),
    [budgetBlocked, tabsMeta],
  );

  useEffect(() => {
    onProjectActivityChange(projectId, projectActivity);
  }, [onProjectActivityChange, projectActivity, projectId]);

  const tabDescriptors: ChatTabDescriptor[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        title: t.title,
        isStreaming: tabsMeta[t.id]?.isStreaming ?? false,
        userMessageCount: tabsMeta[t.id]?.userMessageCount ?? 0,
      })),
    [tabs, tabsMeta],
  );

  return (
    <div className="flex h-dvh min-w-0 flex-col">
      {/* Header */}
      <header className="relative flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenProjectView}
            aria-label="Back to projects"
            className="flex items-center gap-2"
          >
            {/* Plain <img> to avoid Next/Image's aspect-ratio warning when we
                set height via CSS and let width autosize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/kdense-logo.png"
              alt="K-Dense BYOK"
              className="h-7 w-auto object-contain dark:invert"
            />
            <span className="text-sm font-semibold tracking-tight text-foreground/80">BYOK</span>
          </button>
          {isVersioned && (
            <InfoTooltip
              content={
                <>
                  <b>K-Dense BYOK v{APP_VERSION}</b>
                  <br />
                  Bring-your-own-key research assistant. All API calls use keys from your{" "}
                  <kbd>.env</kbd> file and run on your machine.
                </>
              }
            >
              <span className="text-[11px] text-muted-foreground/60 cursor-help">
                v{APP_VERSION}
              </span>
            </InfoTooltip>
          )}
          {updateAvailable && (
            <InfoTooltip content="A newer version is available on GitHub. Click to open the release page.">
              <a
                href="https://github.com/K-Dense-AI/k-dense-byok"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-blue-500 hover:text-blue-400 transition-colors"
              >
                Update available
              </a>
            </InfoTooltip>
          )}
          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
          <ProjectSwitcher onOpenProjectView={onOpenProjectView} />
        </div>
        <p className="absolute left-1/2 hidden -translate-x-1/2 text-[11px] text-muted-foreground/60 tracking-wide select-none 2xl:block">
          Brought to you by K-Dense, Inc.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {isActive && <ResourceMonitor />}
          <SessionCostPill
            summary={costSummary}
            projectSummary={projectCost}
            limitUsd={projectCost.limitUsd}
            loading={costLoading || projectCostLoading}
          />
          {activeModalJobCount > 0 ? (
            <InfoTooltip
              content={`${activeModalJobCount} Modal compute job${
                activeModalJobCount === 1 ? " is" : "s are"
              } still running. Open Compute to inspect live logs.`}
            >
              <button
                type="button"
                onClick={() => handleViewCompute()}
                aria-label={`Open Compute, ${activeModalJobCount} active jobs`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2 py-1.5 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-500/15 dark:text-violet-300"
              >
                <ServerCogIcon className="size-3.5" />
                <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
                {activeModalJobCount}
              </button>
            </InfoTooltip>
          ) : modalJobsLoading ? (
            <span className="sr-only" aria-live="polite">Checking compute jobs</span>
          ) : null}
          {/* Panel visibility — collapse either side panel to give the center
              pane (file preview / LaTeX editor) more room. */}
          <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
            <InfoTooltip
              content={
                <>
                  <b>{sandboxOpen ? "Hide" : "Show"} file browser</b>
                  <br />
                  Collapse the left file tree to widen the editor and preview.
                </>
              }
            >
              <button
                onClick={toggleSandbox}
                aria-label={sandboxOpen ? "Hide file browser" : "Show file browser"}
                aria-pressed={sandboxOpen}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  sandboxOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PanelLeftIcon className="size-4" />
              </button>
            </InfoTooltip>
            <InfoTooltip
              content={
                <>
                  <b>{chatOpen ? "Hide" : "Show"} chat</b>
                  <br />
                  Collapse the right chat panel to widen the editor and preview.
                </>
              }
            >
              <button
                onClick={toggleChat}
                aria-label={chatOpen ? "Hide chat" : "Show chat"}
                aria-pressed={chatOpen}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  chatOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PanelRightIcon className="size-4" />
              </button>
            </InfoTooltip>
          </div>
          <InfoTooltip
            content={
              <>
                <b>Settings</b>
                <br />
                Model providers and defaults, this project&apos;s budget, skills and
                specialists, and services like web search and Modal.
              </>
            }
          >
            <button
              onClick={() => {
                setSettingsRequest(null);
                setSettingsOpen(true);
              }}
              aria-label="Open settings"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="size-4" />
            </button>
          </InfoTooltip>
          {mounted && (
            <InfoTooltip
              content={
                resolvedTheme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
            >
              <button
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                aria-label={
                  resolvedTheme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                }
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {resolvedTheme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              </button>
            </InfoTooltip>
          )}
        </div>
      </header>

      {/* Main content area — three columns: file tree | preview | chat.
          Panels keep a fixed DOM order and are arranged with CSS `order`:
          reordering nodes would remount ChatTab and drop a live stream.
          The breakpoint is `lg` (1024px), not `xl`: a half-screen window on a
          1080p display is 960–1200 CSS px, and at `xl` the whole row layout
          would silently fall back to the two-row grid — which is what made
          the reordering look broken in a half-screen browser. */}
      <div
        ref={columnsRef}
        className={cn("grid min-h-0 flex-1 overflow-hidden lg:flex", isResizing && "select-none")}
        style={{
          // Narrow layout: tree beside the preview on the first row, chat
          // spanning the second. Without the preview the first row is just the
          // tree, so it gets a single column instead of a stranded half-empty
          // pair.
          gridTemplateColumns:
            sandboxOpen && previewOpen
              ? `min(${treePx}px, 30vw) minmax(0, 1fr)`
              : "minmax(0, 1fr)",
          gridTemplateRows: chatOpen ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
        }}
      >

        {/* Left: file tree */}
        {isActive && sandboxOpen && (
          <div
            className={cn(
              "min-h-0 min-w-0 overflow-hidden lg:[order:var(--panel-order)]",
              filler === "tree"
                ? "flex-1 lg:min-w-[var(--tree-width)]"
                : "shrink-0 lg:w-[var(--tree-width)]",
            )}
            style={{ "--tree-width": `${treePx}px`, "--panel-order": panelOrder.indexOf("tree") * 2 } as CSSProperties}
          >
            <FileTreePanel
              tree={sandbox.tree}
              selectedPath={sandbox.activeTabPath}
              uploading={sandbox.uploading}
              onSelect={handleFileSelect}
              onDownload={sandbox.downloadFile}
              onDelete={sandbox.deleteFile}
              onDownloadDir={sandbox.downloadDir}
              onDeleteDir={sandbox.deleteDir}
              onDownloadAll={sandbox.downloadAll}
              onRefresh={sandbox.fetchTree}
              onClose={toggleSandbox}
              onUpload={sandbox.uploadFiles}
              onOrganize={handleOrganizeFiles}
              onMove={sandbox.moveItem}
              onRename={sandbox.renameItem}
              onCreateDir={sandbox.createDir}
            />
          </div>
        )}

        {/* Middle: file preview with tabs. Normally the flexible pane the
            side panels make room for (e.g. the LaTeX editor + PDF), but it can
            be collapsed from Settings. When it is, it stops taking part in the
            row so the last remaining pane grows into the space instead. */}
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden lg:[order:var(--panel-order)]",
            previewOpen ? "flex-1" : "hidden",
          )}
          style={{ "--panel-order": panelOrder.indexOf("preview") * 2 } as CSSProperties}
        >
            <FilePreviewPanel
              projectId={projectId}
              isActive={isActive}
              activeModelRef={tabWorkspaceStates[activeTabId]?.selectedModel.id}
              tabs={sandbox.tabs}
              activeTabPath={sandbox.activeTabPath}
              onTabSelect={handleFileSelect}
              onTabClose={sandbox.closeTab}
              onDownload={sandbox.downloadFile}
              onSaveText={sandbox.saveFile}
              onSaveImageBlob={sandbox.saveImageBlob}
              onRetry={sandbox.retryFile}
              onCompileLatex={sandbox.compileLatex}
              showNotebook={showNotebook}
              onSelectNotebook={() => {
                setShowCompute(false);
                setShowAutomation(false);
                setShowNotebook(true);
              }}
              showCompute={showCompute}
              onSelectCompute={() => {
                setShowNotebook(false);
                setShowAutomation(false);
                setShowCompute(true);
              }}
              showAutomation={showAutomation}
              onSelectAutomation={() => {
                setShowNotebook(false);
                setShowCompute(false);
                setShowAutomation(true);
              }}
              computeSessionId={activeSessionId}
              computeScope={computeScope}
              onComputeScopeChange={setComputeScope}
              computeFocus={computeFocus}
              onOpenComputeOutput={handleFileSelect}
              notebookSessionId={activeSessionId}
              notebookEntries={notebookEntries}
              notebookStreaming={notebookStreaming}
              notebookSubagentCompletions={subagentCompletions}
              onOpenNotebookFile={handleFileSelect}
              notebookFocus={notebookFocus}
              onNotebookJumpToChat={handleNotebookJumpToChat}
              onOpenNotebookEntry={handleViewInNotebook}
            />
        </div>

        {/* Right: chat / workflows. Kept mounted (hidden via CSS when
            collapsed) so background chat streams keep running. */}
        <div
          className={cn(
            "col-span-full flex min-h-0 min-w-0 flex-col overflow-hidden lg:[order:var(--panel-order)]",
            !chatOpen && "hidden",
            filler === "chat"
              ? "flex-1 lg:min-w-[var(--chat-width)]"
              : "shrink-0 lg:w-[var(--chat-width)]",
          )}
          style={{
            "--chat-width": `${chatPx}px`,
            "--panel-order": panelOrder.indexOf("chat") * 2,
          } as CSSProperties}
        >

          <ChatTabsBar
            projectId={projectId}
            tabs={tabDescriptors}
            activeTabId={activeTabId}
            view={view}
            maxTabs={MAX_CHAT_TABS}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={newTab}
            onRename={renameTab}
            onSelectWorkflows={() => setView("workflows")}
            onOpenSession={openSession}
            activeSessionId={activeSessionId}
            canExport={(activeMeta?.userMessageCount ?? 0) > 0}
          />

          {/* Chat tabs — all kept mounted so background streams continue.
              Each ChatTab hides itself with `display: none` when inactive. */}
          {tabs.map((t) => (
            <ChatTab
              key={t.id}
              ref={getTabRefCallback(t.id)}
              projectId={projectId}
              tabId={t.id}
              initialSessionId={t.sessionId ?? null}
              initialWorkspaceState={tabWorkspaceStates[t.id]}
              isActive={isActive && view === "chat" && t.id === activeTabId}
              isActiveTab={isActive && t.id === activeTabId}
              transcriptWidth={transcriptWidth}
              allFiles={allFiles}
              sandboxReady={sandbox.tree !== null}
              uploadFiles={sandbox.uploadFiles}
              onSandboxRefresh={handleSandboxRefresh}
              onTurnComplete={handleTurnComplete}
              allSkills={allSkills}
              skillsReady={!skillsLoading}
              budgetState={projectCost.budget.state}
              budgetTotalUsd={projectCost.budget.totalUsd}
              budgetLimitUsd={projectCost.budget.limitUsd}
              onMetaChange={handleMetaChange}
              onWorkspaceStateChange={handleTabWorkspaceStateChange}
              onSessionUnavailable={forgetTabSession}
              onViewInNotebook={handleViewInNotebook}
              onViewCompute={handleViewCompute}
              onOpenFile={handleFileSelect}
            />
          ))}

          {/* Workflows view */}
          {isActive && view === "workflows" && (
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              <WorkflowsPanel
                onLaunch={handleWorkflowLaunch}
                onUploadFiles={sandbox.uploadFiles}
                availableFiles={allFiles}
                availableFolders={allFolders}
                filesReady={sandbox.tree !== null}
                onRefreshFiles={sandbox.fetchTree}
                budgetBlocked={projectCost.budget.state === "exceeded"}
              />
            </div>
          )}
        </div>

        {/* Boundaries. Each sits between two visible panes, so its order is
            the left neighbour's + 1. Mounted last in the DOM so React never
            has to move a panel to place one. */}
        {isActive && visiblePanels.slice(0, -1).map((left, index) => {
          const right = visiblePanels[index + 1];
          const target = handleTarget(left, right);
          return (
            <div
              key={`${left}-${right}`}
              className="hidden lg:flex lg:[order:var(--panel-order)]"
              style={{ "--panel-order": panelOrder.indexOf(left) * 2 + 1 } as CSSProperties}
            >
              {/* Every visible pair names a target — including tree|chat,
                  where the preview sits at an end and the two fixed-width
                  panes trade width with each other. */}
              <ResizeHandle
                onMouseDown={target ? startDrag(target) : () => {}}
                onSwap={() => swapPanels(left, right)}
              />
            </div>
          );
        })}

      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        request={settingsRequest}
        panelWidths={{ tree: treePx, chat: chatPx }}
        onPanelWidthChange={setPanelWidth}
        transcriptWidth={transcriptWidth}
        onTranscriptWidthChange={setTranscriptWidth}
        panelVisibility={{ tree: sandboxOpen, chat: chatOpen, preview: previewOpen }}
        onPanelVisibilityChange={(panel, visible) =>
          panel === "tree"
            ? setSandboxOpen(visible)
            : panel === "chat"
              ? setChatOpen(visible)
              : setPreviewOpen(visible)
        }
      />
    </div>
  );
}
