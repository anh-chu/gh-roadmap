import { useMemo, useState } from "react";
import type { FlowResult, FlowState, Issue } from "../../../shared/types";
import { FlowPill } from "./FlowPill";
import { IssueRef } from "./IssueRef";
import { TypeBadge } from "./TypeBadge";
import { AiBlock } from "./AiBlock";
import { useMilestoneNotes } from "../hooks/useMilestoneNotes";
import { canEdit } from "../lib/role";

interface MilestonesProps {
  issues: Issue[];
  flow: Map<number, FlowResult>;
  insightCounts: Record<number, number>;
  onOpen: (i: Issue) => void;
  onToast: (m: string) => void;
}

// Flow states that read as "no forward motion" — used to surface at-risk open issues.
const AT_RISK_FLOW: ReadonlySet<FlowState> = new Set<FlowState>(["stalled", "cold"]);

type Status = "done" | "overdue" | "due-soon" | "on-time" | "no-date";

const STATUS_LABEL: Record<Status, string> = {
  done: "Done",
  overdue: "Overdue",
  "due-soon": "Due soon",
  "on-time": "On-time",
  "no-date": "No due date",
};

const DUE_SOON_DAYS = 14;
const DAY_MS = 86_400_000;

interface Rollup {
  // null title = the synthetic "No milestone" bucket.
  title: string | null;
  due: string | null; // ISO date-time mirror from GitHub
  issues: Issue[];
  total: number;
  closed: number;
  open: number;
  atRisk: Issue[];
  status: Status;
  daysToDue: number | null; // signed; negative = past
}

function dueStatus(due: string | null, open: number, daysToDue: number | null): Status {
  if (open === 0) return "done";
  if (!due || daysToDue === null) return "no-date";
  if (daysToDue < 0) return "overdue";
  if (daysToDue <= DUE_SOON_DAYS) return "due-soon";
  return "on-time";
}

function fmtDue(due: string): string {
  return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtCountdown(days: number): string {
  if (days === 0) return "due today";
  const abs = Math.abs(days);
  const unit = abs === 1 ? "day" : "days";
  return days < 0 ? `${abs} ${unit} overdue` : `in ${abs} ${unit}`;
}

function buildRollups(
  issues: Issue[],
  flow: Map<number, FlowResult>,
  nowMs: number,
): Rollup[] {
  const byTitle = new Map<string, Issue[]>();
  const noMilestone: Issue[] = [];
  for (const i of issues) {
    if (i.milestone) {
      const arr = byTitle.get(i.milestone) ?? [];
      arr.push(i);
      byTitle.set(i.milestone, arr);
    } else {
      noMilestone.push(i);
    }
  }

  const make = (title: string | null, list: Issue[]): Rollup => {
    const closed = list.filter((i) => i.state === "closed").length;
    const open = list.length - closed;
    // Due date: take the first non-null mirror (all issues in a milestone share it).
    const due = list.find((i) => i.milestoneDue)?.milestoneDue ?? null;
    const daysToDue = due ? Math.round((new Date(due).getTime() - nowMs) / DAY_MS) : null;
    const atRisk = list.filter(
      (i) => i.state === "open" && AT_RISK_FLOW.has(flow.get(i.num)?.state ?? "fresh"),
    );
    return {
      title,
      due,
      issues: list,
      total: list.length,
      closed,
      open,
      atRisk,
      status: dueStatus(due, open, daysToDue),
      daysToDue,
    };
  };

  const rollups = [...byTitle.entries()].map(([title, list]) => make(title, list));
  // Sort: dated milestones first (soonest due first), then undated, by title.
  rollups.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  if (noMilestone.length) rollups.push(make(null, noMilestone));
  return rollups;
}

// Stakeholder-comms digest: a markdown summary the PM can paste anywhere.
function buildDigest(rollups: Rollup[]): string {
  const lines: string[] = [];
  for (const r of rollups) {
    if (r.title === null) continue; // skip the un-milestoned bucket in comms
    const pct = r.total ? Math.round((r.closed / r.total) * 100) : 0;
    const head = `## ${r.title} — ${STATUS_LABEL[r.status]}`;
    const meta = [`${r.closed}/${r.total} closed (${pct}%)`];
    if (r.due && r.daysToDue !== null) meta.push(`due ${fmtDue(r.due)} (${fmtCountdown(r.daysToDue)})`);
    lines.push(head, meta.join(" · "));
    if (r.atRisk.length) {
      lines.push(`At-risk: ${r.atRisk.map((i) => `#${i.num} ${i.title}`).join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function ProgressBar({ closed, total }: { closed: number; total: number }): JSX.Element {
  const pct = total ? Math.round((closed / total) * 100) : 0;
  return (
    <div className="ms-progress" title={`${closed} of ${total} closed`}>
      <div className="ms-progress-bar" style={{ width: `${pct}%` }} />
      <span className="ms-progress-label">{pct}%</span>
    </div>
  );
}

// AI release notes for one milestone. Generation is gated behind a click (it's an
// AI call), so the hook only fires once the PM opens this panel.
function ReleaseNotesPanel({
  title,
  issuesByNum,
  onOpen,
}: {
  title: string;
  issuesByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { notes, loading, error, disabled, refresh } = useMilestoneNotes(title, open);

  if (disabled) return null; // AI not configured — hide the surface entirely
  if (!open) {
    return (
      <div className="ms-notes-cta">
        <button className="btn" onClick={() => setOpen(true)}>✨ Release notes</button>
      </div>
    );
  }
  return (
    <div className="ms-notes">
      <AiBlock
        label="Release notes"
        content={notes?.content ?? ""}
        model={notes?.model ?? ""}
        generatedAt={notes?.generatedAt ?? ""}
        loading={loading}
        error={error}
        onRefresh={() => void refresh()}
        issuesByNum={issuesByNum}
        onOpenIssue={onOpen}
      />
      {notes && canEdit() && (
        <button
          className="ms-notes-copy"
          onClick={() => {
            void navigator.clipboard.writeText(notes.content);
          }}
        >
          Copy
        </button>
      )}
    </div>
  );
}

function MilestoneCard({
  rollup,
  flow,
  insightCounts,
  issuesByNum,
  onOpen,
  passed,
}: {
  rollup: Rollup;
  flow: Map<number, FlowResult>;
  insightCounts: Record<number, number>;
  issuesByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
  passed?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const r = rollup;
  const titleText = r.title ?? "No milestone";

  // Scope list: at-risk open issues first, then other open, then closed.
  const ordered = useMemo(() => {
    const rank = (i: Issue): number => {
      if (i.state === "closed") return 2;
      return r.atRisk.includes(i) ? 0 : 1;
    };
    return [...r.issues].sort((a, b) => rank(a) - rank(b) || a.num - b.num);
  }, [r]);

  return (
    <div className="ms-card">
      <div className="ms-card-head" onClick={() => setExpanded((e) => !e)}>
        <button className="ms-toggle" aria-label={expanded ? "Collapse" : "Expand"}>
          <svg className="icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden style={{ transform: expanded ? "rotate(90deg)" : "none" }}>
            <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="ms-card-title">
          <span className="ms-name">{titleText}</span>
          <span className={`ms-status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
          {r.atRisk.length > 0 && (
            <span className="ms-atrisk-flag" title={`${r.atRisk.length} at-risk`}>
              ⚠ {r.atRisk.length}
            </span>
          )}
          {passed && r.open > 0 && (
            <span className="ms-atrisk-flag" title={`${r.open} unclosed`}>
              ⚠ {r.open} open
            </span>
          )}
        </div>
        <div className="ms-card-meta">
          {r.due && r.daysToDue !== null ? (
            <span className="ms-due">
              {fmtDue(r.due)} <span className="ms-countdown">· {fmtCountdown(r.daysToDue)}</span>
            </span>
          ) : (
            <span className="ms-due ms-due-none">—</span>
          )}
          <span className="ms-counts">{r.closed}/{r.total}</span>
        </div>
        <ProgressBar closed={r.closed} total={r.total} />
      </div>
      {expanded && (
        <div className="ms-card-body">
          {r.title !== null && r.total > 0 && (
            <ReleaseNotesPanel title={r.title} issuesByNum={issuesByNum} onOpen={onOpen} />
          )}
          {ordered.map((i) => (
            <div key={i.num} className="ms-row" onClick={() => onOpen(i)}>
              <span className={`ms-row-state ${i.state}`}><i className="dot" />{i.state}</span>
              <FlowPill result={flow.get(i.num)} size="sm" />
              <TypeBadge issue={i} />
              <span className="ms-row-ref" onClick={(e) => e.stopPropagation()}>
                <IssueRef num={i.num} issue={i} onOpen={onOpen} />
              </span>
              <span className="ms-row-title">{i.title}</span>
              {(insightCounts[i.num] ?? 0) > 0 && (
                <span className="ms-row-signal" title={`${insightCounts[i.num]} insights`}>📎{insightCounts[i.num]}</span>
              )}
              <span className="ms-row-assignee">{i.assignee !== "unassigned" ? i.assignee : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Milestones({ issues, flow, insightCounts, onOpen, onToast }: MilestonesProps): JSX.Element {
  const rollups = useMemo(() => buildRollups(issues, flow, Date.now()), [issues, flow]);
  const real = rollups.filter((r) => r.title !== null);
  const issuesByNum = useMemo(() => new Map(issues.map((i) => [i.num, i])), [issues]);
  const [showPassed, setShowPassed] = useState(false);

  // Passed = a real milestone whose due date is in the past. These clutter the
  // planning view; fold them away but keep an ⚠ open-count so unfinished ones
  // stay visible while collapsed.
  const isPassed = (r: Rollup): boolean => r.title !== null && r.daysToDue !== null && r.daysToDue < 0;
  const current = rollups.filter((r) => !isPassed(r));
  const passed = rollups.filter(isPassed);
  const passedOpenTotal = passed.reduce((n, r) => n + r.open, 0);

  const handleCopy = async (): Promise<void> => {
    const digest = buildDigest(rollups);
    if (!digest) {
      onToast("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(digest);
      onToast("Milestone summary copied");
    } catch {
      onToast("Copy failed");
    }
  };

  if (real.length === 0) {
    return (
      <main className="board ms-view reveal" style={{ animationDelay: "120ms" }}>
        <div className="ms-empty">
          <div className="ms-empty-title">No milestones in scope</div>
          <div className="ms-empty-hint">Assign milestones to issues on GitHub — they’ll roll up here.</div>
        </div>
      </main>
    );
  }

  return (
    <main className="board ms-view reveal" style={{ animationDelay: "120ms" }}>
      <div className="ms-main">
        <div className="ms-toolbar">
          <span className="ms-toolbar-count">{real.length} milestone{real.length === 1 ? "" : "s"}</span>
        </div>
        <div className="ms-list">
          {current.map((r) => (
            <MilestoneCard
              key={r.title ?? "__none__"}
              rollup={r}
              flow={flow}
              insightCounts={insightCounts}
              issuesByNum={issuesByNum}
              onOpen={onOpen}
            />
          ))}
        </div>
        {passed.length > 0 && (
          <div className="ms-passed">
            <button className="ms-passed-toggle" onClick={() => setShowPassed((s) => !s)}>
              <svg className="icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden style={{ transform: showPassed ? "rotate(90deg)" : "none" }}>
                <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Passed milestone{passed.length === 1 ? "" : "s"} ({passed.length})</span>
              {passedOpenTotal > 0 && (
                <span className="ms-atrisk-flag" title={`${passedOpenTotal} unclosed across passed milestones`}>
                  ⚠ {passedOpenTotal} open
                </span>
              )}
            </button>
            {showPassed && (
              <div className="ms-list ms-passed-list">
                {passed.map((r) => (
                  <MilestoneCard
                    key={r.title ?? "__none__"}
                    rollup={r}
                    flow={flow}
                    insightCounts={insightCounts}
                    issuesByNum={issuesByNum}
                    onOpen={onOpen}
                    passed
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <aside className="ms-aside">
        <div className="ms-aside-head">
          <span className="ms-aside-title">Summary</span>
          <button className="btn" onClick={() => void handleCopy()}>Copy</button>
        </div>
        <div className="ms-aside-body">
          {real.map((r) => {
            const pct = r.total ? Math.round((r.closed / r.total) * 100) : 0;
            return (
              <div key={r.title} className="ms-sum-row">
                <div className="ms-sum-line">
                  <span className="ms-sum-name">{r.title}</span>
                  <span className={`ms-status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </div>
                <div className="ms-sum-meta">
                  {r.closed}/{r.total} closed · {pct}%
                  {r.due && r.daysToDue !== null && ` · ${fmtCountdown(r.daysToDue)}`}
                </div>
                {r.atRisk.length > 0 && (
                  <div className="ms-sum-atrisk">
                    ⚠ {r.atRisk.map((i) => (
                      <span key={i.num} className="ms-sum-atrisk-ref" onClick={() => onOpen(i)}>#{i.num}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </main>
  );
}
