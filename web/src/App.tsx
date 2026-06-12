import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser, Issue } from "../../shared/types";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import type { FilterKey, TabKey } from "./components/Toolbar";
import { Board } from "./components/Board";
import { Drawer } from "./components/Drawer";
import { Progress } from "./components/Progress";
import { List } from "./components/List";
import { Kanban } from "./components/Kanban";
import { Insights } from "./components/Insights";
import { Accounts } from "./components/Accounts";
import { AccountDrawer } from "./components/AccountDrawer";
import { useIssueInsightCounts } from "./hooks/useIssueInsightCounts";
import { postSync, setGithubConnectHandler, type GithubConnectReason } from "./lib/api";
import { GithubConnectModal } from "./components/GithubConnectModal";
import { useToast } from "./components/Toast";
import { useIssues } from "./hooks/useIssues";
import { useMeta } from "./hooks/useMeta";
import { useCatalog } from "./hooks/useCatalog";
import { useConfig } from "./hooks/useConfig";
import { usePulls } from "./hooks/usePulls";
import { useFlow } from "./hooks/useFlow";
import { useProject, useProjects } from "./hooks/useProjects";
import { NewIssueModal } from "./components/NewIssueModal";
import {
  DEFAULT_RICH_FILTER,
  FilterPopover,
  isRichFilterActive,
  type RichFilter,
} from "./components/FilterPopover";

const TABS: readonly TabKey[] = ["roadmap", "list", "kanban", "insights", "accounts", "progress"];
function tabFromHash(): TabKey {
  const h = window.location.hash.replace(/^#/, "") as TabKey;
  return TABS.includes(h) ? h : "roadmap";
}

export function App({ authUser }: { authUser: AuthUser | null }): JSX.Element {
  // When auth is disabled, authUser is null and the user is treated as an admin.
  const isAdmin = authUser?.isAdmin ?? true;
  const { node: toastNode, controller: toast } = useToast();
  const onError = useCallback((m: string) => toast.show(m), [toast]);
  const issuesApi = useIssues(onError);
  const { meta, refresh: refreshMeta } = useMeta();
  const { config, updateConfig } = useConfig(onError);
  const pulls = usePulls();
  const { flow } = useFlow();
  const insightCounts = useIssueInsightCounts();

  const [tab, setTab] = useState<TabKey>(tabFromHash);
  // Keep tab in the URL hash so reload / back-forward lands on the same view.
  useEffect(() => {
    if (tabFromHash() !== tab) window.location.hash = tab;
  }, [tab]);
  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t === "kanban") setKanbanVisited(true);
      setTab(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Project data lives at App level so it survives tab switches (Kanban → other → Kanban
  // no longer blanks). Lazy-enabled: only starts fetching once user has visited Kanban.
  const [kanbanVisited, setKanbanVisited] = useState(tab === "kanban");
  const projectsApi = useProjects(kanbanVisited);
  const pinnedProjectNum = projectsApi.projects[0]?.number ?? null;
  const projectApi = useProject(pinnedProjectNum, kanbanVisited);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [openNum, setOpenNum] = useState<number | null>(null);
  const [openAccountSlug, setOpenAccountSlug] = useState<string | null>(null);
  const openAccount = useCallback((slug: string) => setOpenAccountSlug(slug), []);
  const [richFilter, setRichFilter] = useState<RichFilter>(DEFAULT_RICH_FILTER);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null);
  const [syncing, setSyncing] = useState(false);
  // GitHub write-identity gate (layer 3): one app-level Connect prompt, raised by the
  // shared 409 interceptor in lib/api.ts. No per-action wiring — write buttons stay live.
  const [ghConnectReason, setGhConnectReason] = useState<GithubConnectReason | null>(null);
  useEffect(() => {
    setGithubConnectHandler(setGhConnectReason);
    return () => setGithubConnectHandler(null);
  }, []);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await postSync();
      await Promise.all([issuesApi.refresh(), refreshMeta()]);
      toast.show(`Synced · ${r.github.issues} issues`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [syncing, issuesApi, refreshMeta, toast]);

  const currentUser = meta?.currentUser ?? null;

  const passFilter = useCallback(
    (i: Issue): boolean => {
      if (search) {
        const s = search.toLowerCase();
        if (!i.title.toLowerCase().includes(s) && !String(i.num).includes(s)) return false;
      }
      if (filter === "mine") {
        if (!currentUser || i.assignee !== currentUser) return false;
      }
      if (richFilter.assignees.length > 0 && !richFilter.assignees.includes(i.assignee)) return false;
      if (richFilter.state !== "all" && i.state !== richFilter.state) return false;
      if (richFilter.labelQuery.trim()) {
        const q = richFilter.labelQuery.toLowerCase();
        if (!i.labels.some((l) => l.toLowerCase().includes(q))) return false;
      }
      return true;
    },
    [filter, search, richFilter, currentUser],
  );

  const issues = issuesApi.issues;
  const totalShown = useMemo(() => issues.filter(passFilter).length, [issues, passFilter]);

  // Buckets come exclusively from the server via /api/meta — no client-side fallback.
  // When meta hasn't loaded or its grouping doesn't match the active config, render an empty grid.
  const buckets = useMemo(() => {
    if (
      meta?.buckets &&
      meta.buckets.field === config.bucketingField &&
      meta.buckets.value === config.bucketingValue
    ) {
      return meta.buckets;
    }
    return null;
  }, [meta, config]);

  // Set of known assignee logins seen in the data, sorted. Used for filter dropdowns.
  const knownAssignees = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) if (i.assignee && i.assignee !== "unassigned") s.add(i.assignee);
    return [...s].sort();
  }, [issues]);

  // Label + milestone universes for the Drawer pickers: the full repo catalog
  // (from GitHub, incl. unused values) unioned with whatever's in-use in loaded
  // issues — so pickers stay populated even if the catalog fetch fails.
  const catalog = useCatalog();
  const knownLabels = useMemo(() => {
    const s = new Set<string>(catalog.labels);
    for (const i of issues) for (const l of i.labels) s.add(l);
    return [...s].sort();
  }, [issues, catalog.labels]);

  const knownMilestones = useMemo(() => {
    const s = new Set<string>(catalog.milestones);
    for (const i of issues) if (i.milestone) s.add(i.milestone);
    return [...s].sort();
  }, [issues, catalog.milestones]);

  const openIssue = useMemo(() => issues.find((i) => i.num === openNum) ?? null, [issues, openNum]);
  const issuesByNum = useMemo(() => new Map(issues.map((i) => [i.num, i])), [issues]);

  const handleOpen = useCallback((i: Issue) => setOpenNum(i.num), []);
  const handleClose = useCallback(() => setOpenNum(null), []);

  const handleMove = useCallback(
    async (
      num: number,
      target: Parameters<typeof issuesApi.move>[1],
      bucket?: Parameters<typeof issuesApi.move>[2],
    ) => {
      // No pinned project → legacy is_todo placement: omit status so move()
      // never calls the project-status endpoint (which would 400).
      const status = meta?.projectPinned
        ? {
            todo: config.todoStatusName,
            backlog: config.backlogStatusName,
            onAddedToBoard: (n: number) => toast.show(`#${n} added to the project board`),
          }
        : undefined;
      const ok = await issuesApi.move(num, target, bucket, status);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast, meta?.projectPinned, config.todoStatusName, config.backlogStatusName],
  );

  const handleTitle = useCallback(
    async (num: number, title: string) => {
      const ok = await issuesApi.setTitle(num, title);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast],
  );

  const handleStateToggle = useCallback(
    async (num: number) => {
      const cur = issues.find((i) => i.num === num);
      if (!cur) return;
      const ok = await issuesApi.setState(num, cur.state === "open" ? "closed" : "open");
      if (ok) toast.show("Saved");
    },
    [issues, issuesApi, toast],
  );

  const handleAssignee = useCallback(
    async (num: number, a: string) => {
      const ok = await issuesApi.setAssignee(num, a);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast],
  );

  const handleNotes = useCallback(
    async (num: number, notes: string | null) => {
      const ok = await issuesApi.setNotes(num, notes);
      if (ok) toast.show("Note saved");
    },
    [issuesApi, toast],
  );

  const handleBody = useCallback(
    async (num: number, body: string) => {
      const ok = await issuesApi.setBody(num, body);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast],
  );

  const handleLabels = useCallback(
    async (num: number, labels: string[]) => {
      const ok = await issuesApi.setLabels(num, labels);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast],
  );

  const handleMilestone = useCallback(
    async (num: number, m: string | null) => {
      const ok = await issuesApi.setMilestone(num, m);
      if (ok) toast.show("Saved");
    },
    [issuesApi, toast],
  );

  return (
    <>
      <Header
        meta={meta}
        config={config}
        authUser={authUser}
        isAdmin={isAdmin}
        onScopeChange={(patch) => {
          void (async () => {
            const ok = await updateConfig(patch);
            if (ok) void issuesApi.refresh();
          })();
        }}
        onAiChange={(patch) => {
          void updateConfig(patch);
        }}
        onOpenFilter={(r) => setFilterAnchor(r)}
        onNewIssue={() => setShowNewIssue(true)}
        filterActive={isRichFilterActive(richFilter)}
        onSync={handleSync}
        syncing={syncing}
      />
      {issuesApi.errorMessage && (
        <div
          role="alert"
          style={{
            background: "rgba(200, 60, 60, 0.08)",
            color: "var(--red, #c83c3c)",
            borderBottom: "1px solid rgba(200, 60, 60, 0.25)",
            padding: "8px 16px",
            fontSize: 13,
          }}
        >
          Could not load issues from API. Check that the server is running and GITHUB_TOKEN is configured.
        </div>
      )}
      <Toolbar
        filter={filter}
        onFilter={setFilter}
        tab={tab}
        onTab={(t) => {
          if (t === "kanban") setKanbanVisited(true);
          setTab(t);
        }}
        search={search}
        onSearch={setSearch}
        totalShown={totalShown}
        config={config}
        onConfigChange={(patch) => void updateConfig(patch)}
      />
      {tab === "progress" ? (
        <Progress issues={issues} meta={meta} onOpen={handleOpen} />
      ) : tab === "insights" ? (
        <Insights issuesByNum={issuesByNum} onOpenIssue={handleOpen} onOpenAccount={openAccount} />
      ) : tab === "accounts" ? (
        <Accounts onOpenAccount={openAccount} />
      ) : tab === "list" ? (
        <List issues={issues} passFilter={passFilter} onOpen={handleOpen} flow={flow} insightCounts={insightCounts} todoStatusName={config.todoStatusName} backlogStatusName={config.backlogStatusName} />
      ) : tab === "kanban" ? (
        <Kanban
          issues={issues}
          onOpen={handleOpen}
          onToast={(m) => toast.show(m)}
          flow={flow}
          projectsApi={projectsApi}
          projectApi={projectApi}
        />
      ) : buckets ? (
        <Board
          issues={issues}
          buckets={buckets}
          config={config}
          onOpen={handleOpen}
          onMove={handleMove}
          passFilter={passFilter}
          flow={flow}
          insightCounts={insightCounts}
          projectPinned={meta?.projectPinned ?? false}
        />
      ) : (
        <main className="board" style={{ padding: 40, textAlign: "center", color: "var(--ink-4)" }}>
          {issuesApi.loading ? "Loading…" : "—"}
        </main>
      )}
      <Drawer
        issue={openIssue}
        currentUser={currentUser}
        knownAssignees={knownAssignees}
        knownLabels={knownLabels}
        knownMilestones={knownMilestones}
        linkedPulls={openIssue ? pulls.byIssue.get(openIssue.num) ?? [] : []}
        flowResult={openIssue ? flow.get(openIssue.num) : undefined}
        issuesByNum={issuesByNum}
        repoSlug={meta?.repoSlug ?? null}
        todoStatusName={config.todoStatusName}
        backlogStatusName={config.backlogStatusName}
        onClose={handleClose}
        onTitle={handleTitle}
        onStateToggle={handleStateToggle}
        onAssignee={handleAssignee}
        onNotes={handleNotes}
        onMove={(num, target) => {
          void handleMove(num, target);
        }}
        onBody={handleBody}
        onLabels={handleLabels}
        onMilestone={handleMilestone}
        onOpenAnother={handleOpen}
        onOpenAccount={openAccount}
        onToast={(m) => toast.show(m)}
      />
      <AccountDrawer
        slug={openAccountSlug}
        issuesByNum={issuesByNum}
        onClose={() => setOpenAccountSlug(null)}
        onOpenIssue={(i) => {
          setOpenAccountSlug(null);
          handleOpen(i);
        }}
      />
      <NewIssueModal
        open={showNewIssue}
        knownAssignees={knownAssignees}
        currentUser={currentUser}
        onClose={() => setShowNewIssue(false)}
        onCreate={issuesApi.createIssue}
        onCreated={(created) => toast.show(`Created #${created.number}`)}
      />
      <FilterPopover
        anchor={filterAnchor}
        knownAssignees={knownAssignees}
        value={richFilter}
        onChange={setRichFilter}
        onClose={() => setFilterAnchor(null)}
      />
      <GithubConnectModal reason={ghConnectReason} onClose={() => setGhConnectReason(null)} />
      {toastNode}
    </>
  );
}
