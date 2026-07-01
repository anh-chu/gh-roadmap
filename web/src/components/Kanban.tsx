import { useCallback, useMemo } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { FlowResult, Issue, ProjectFull, ProjectItem, ProjectStatusOption } from "../../../shared/types";
import type { UseProjectResult, UseProjectsResult } from "../hooks/useProjects";
import { patchProjectItemStatus } from "../lib/api";
import { FlowPill } from "./FlowPill";
import { TypeBadge } from "./TypeBadge";

const PILL_COLORS = ["--n", "--accent", "--e", "--r", "--green", "--purple"];
const NO_STATUS_KEY = "__no_status__";

interface KanbanProps {
  issues: Issue[];
  onOpen: (i: Issue) => void;
  onToast: (m: string) => void;
  flow: Map<number, FlowResult>;
  projectsApi: UseProjectsResult;
  projectApi: UseProjectResult;
}

function pillStyle(idx: number): CSSProperties {
  const v = PILL_COLORS[idx % PILL_COLORS.length];
  return { color: `var(${v})` };
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface KanbanCardProps {
  item: ProjectItem;
  issue: Issue | null;
  onOpen: (i: Issue) => void;
  onDraftClick: () => void;
  flowResult?: FlowResult | undefined;
}

function KanbanCard({ item, issue, onOpen, onDraftClick, flowResult }: KanbanCardProps): JSX.Element {
  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.currentTarget.classList.add("dragging");
    e.dataTransfer.setData("text/plain", item.itemId);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>): void => {
    e.currentTarget.classList.remove("dragging");
  };

  const isIssue = item.contentType === "Issue";
  const isPr = item.contentType === "PullRequest";
  const isDraft = item.contentType === "DraftIssue";

  const handleClick = (): void => {
    if (isIssue && issue) {
      onOpen(issue);
    } else {
      onDraftClick();
    }
  };

  const assignee = item.assignees[0] ?? issue?.assignee ?? null;
  const initial = (assignee ?? "?")[0] ?? "?";

  return (
    <div
      className="kb-card"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={handleClick}
    >
      <div className="kb-card-head">
        {item.contentNumber !== null ? (
          <span className="card-num">#{item.contentNumber}</span>
        ) : (
          <span className="card-num">—</span>
        )}
        {isDraft && <span className="kb-tag draft">Draft</span>}
        {isPr && <span className="kb-tag pr">PR</span>}
        <FlowPill result={flowResult} size="sm" hideBoard />
        {issue && <TypeBadge issue={issue} />}
      </div>
      <div className="kb-card-title">{item.contentTitle}</div>
      {assignee && (
        <div className="kb-card-foot">
          <span className="card-assignee">
            <span className={`av av-${assignee}`}>{initial}</span>
            {assignee}
          </span>
        </div>
      )}
    </div>
  );
}

interface KanbanColumnProps {
  option: ProjectStatusOption | null;
  colorIdx: number;
  items: ProjectItem[];
  issuesByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
  onDraftClick: () => void;
  onDrop: (itemId: string, optionId: string | null) => void;
  flow: Map<number, FlowResult>;
}

function KanbanColumn({
  option,
  colorIdx,
  items,
  issuesByNum,
  onOpen,
  onDraftClick,
  onDrop,
  flow,
}: KanbanColumnProps): JSX.Element {
  const label = option?.name ?? "(no status)";
  const optionId = option?.id ?? null;

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.classList.add("drop-target");
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    e.currentTarget.classList.remove("drop-target");
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.classList.remove("drop-target");
    const itemId = e.dataTransfer.getData("text/plain");
    if (!itemId) return;
    onDrop(itemId, optionId);
  };

  return (
    <div className="kb-col" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={handleDrop}>
      <div className="kb-col-head">
        <span className="kb-pill" style={pillStyle(colorIdx)}>
          {label}
        </span>
        <span className="kb-count">{items.length}</span>
      </div>
      <div className="kb-col-body">
        {items.map((it) => (
          <KanbanCard
            key={it.itemId}
            item={it}
            issue={it.contentNumber !== null ? issuesByNum.get(it.contentNumber) ?? null : null}
            onOpen={onOpen}
            onDraftClick={onDraftClick}
            flowResult={it.contentNumber !== null ? flow.get(it.contentNumber) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function Kanban({ issues, onOpen, onToast, flow, projectsApi, projectApi }: KanbanProps): JSX.Element {
  const { projects, loading: projectsLoading, error: projectsError, reload: reloadProjects } = projectsApi;
  const { project, loading, error, reload, setProject } = projectApi;

  const issuesByNum = useMemo(() => {
    const m = new Map<number, Issue>();
    for (const i of issues) m.set(i.num, i);
    return m;
  }, [issues]);

  const handleDrop = useCallback(
    async (itemId: string, optionId: string | null): Promise<void> => {
      if (!project) return;
      const cur = project.items.find((i) => i.itemId === itemId);
      if (!cur) return;
      if (cur.statusOptionId === optionId) return;

      const newLabel =
        optionId === null ? null : project.statusOptions.find((o) => o.id === optionId)?.name ?? null;

      // Optimistic update.
      const next: ProjectFull = {
        ...project,
        items: project.items.map((i) =>
          i.itemId === itemId ? { ...i, statusOptionId: optionId, statusLabel: newLabel } : i,
        ),
      };
      setProject(next);

      try {
        await patchProjectItemStatus(project.number, itemId, optionId);
      } catch (e) {
        setProject(project);
        onToast(e instanceof Error ? `Failed: ${e.message}` : "Failed to update status");
      }
    },
    [project, setProject, onToast],
  );

  const handleCardClickNonIssue = useCallback(() => {
    onToast("Drafts/PRs not editable here");
  }, [onToast]);

  const handleRefresh = useCallback(() => {
    void reload(true);
  }, [reload]);

  // Stale-while-revalidate: only show the loading state when we have nothing to show yet.
  // If we already have project data from a previous visit, render it while the refetch
  // runs silently in the background.
  if (projectsLoading && projects.length === 0) {
    return (
      <main className="kanban">
        <div className="kb-top">
          <span className="kb-empty">Loading projects…</span>
        </div>
      </main>
    );
  }

  if (projectsError && projects.length === 0) {
    return (
      <main className="kanban">
        <div className="kb-top">
          <span className="kb-empty">Failed to load projects. {projectsError}</span>
          <button className="btn" onClick={() => void reloadProjects()}>Retry</button>
        </div>
      </main>
    );
  }

  if (projects.length === 0) {
    return (
      <main className="kanban">
        <div className="kb-top">
          <span className="kb-empty">
            No project found. Set GITHUB_PROJECT_NUMBER in .env or create a project linked to this repo.
          </span>
          <button className="btn" onClick={() => void reloadProjects()}>Refresh</button>
        </div>
      </main>
    );
  }

  // Build columns: status options in natural order + "(no status)" at end.
  const statusOptions = project?.statusOptions ?? [];
  const items = project?.items ?? [];
  const itemsByStatus = new Map<string, ProjectItem[]>();
  for (const opt of statusOptions) itemsByStatus.set(opt.id, []);
  itemsByStatus.set(NO_STATUS_KEY, []);
  for (const it of items) {
    const key = it.statusOptionId ?? NO_STATUS_KEY;
    if (!itemsByStatus.has(key)) itemsByStatus.set(key, []);
    itemsByStatus.get(key)!.push(it);
  }

  return (
    <main className="kanban reveal" style={{ animationDelay: "120ms" }}>
      <div className="kb-top">
        <span className="kb-project-title">{project?.title ?? projects[0]?.title ?? ""}</span>
        <span className="kb-sync">
          {project ? `Synced ${formatRelative(project.lastSyncedAt)}` : loading ? "Loading…" : ""}
        </span>
        <button className="btn" onClick={handleRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="kb-error">Failed to load project: {error}</div>}

      {loading && !project ? (
        <div className="kb-cols">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="kb-col kb-skel">
              <div className="kb-col-head">
                <span className="kb-pill" style={pillStyle(i)}>—</span>
              </div>
              <div className="kb-col-body">
                <div className="kb-card-skel" />
                <div className="kb-card-skel" />
              </div>
            </div>
          ))}
        </div>
      ) : project ? (
        <div className="kb-cols">
          {statusOptions.map((opt, idx) => (
            <KanbanColumn
              key={opt.id}
              option={opt}
              colorIdx={idx}
              items={itemsByStatus.get(opt.id) ?? []}
              issuesByNum={issuesByNum}
              onOpen={onOpen}
              onDraftClick={handleCardClickNonIssue}
              onDrop={handleDrop}
              flow={flow}
            />
          ))}
          <KanbanColumn
            key={NO_STATUS_KEY}
            option={null}
            colorIdx={statusOptions.length}
            items={itemsByStatus.get(NO_STATUS_KEY) ?? []}
            issuesByNum={issuesByNum}
            onOpen={onOpen}
            onDraftClick={handleCardClickNonIssue}
            onDrop={handleDrop}
            flow={flow}
          />
        </div>
      ) : null}
    </main>
  );
}
