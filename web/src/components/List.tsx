import { useMemo, useState } from "react";
import type { FlowResult, Issue } from "../../../shared/types";
import { formatRelative } from "./Drawer";
import { FlowPill } from "./FlowPill";
import { EffortChip } from "./EffortChip";

type SortKey = "num" | "title" | "state" | "flow" | "assignee" | "planned" | "updated" | "signal";
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: SortState = { key: "updated", dir: "desc" };

interface ListProps {
  issues: Issue[];
  passFilter: (i: Issue) => boolean;
  onOpen: (i: Issue) => void;
  flow: Map<number, FlowResult>;
  insightCounts: Record<number, number>;
  // Projects Status option names backing the TODO/Backlog meta columns (isTodo is deprecated).
  todoStatusName: string;
  backlogStatusName: string;
}

// Coarse priority order for sort: higher = more momentum/urgent.
const FLOW_SORT_RANK: Record<string, number> = {
  shipping: 7,
  "in-review": 6,
  "in-code": 5,
  discussing: 4,
  stalled: 3,
  fresh: 2,
  cold: 1,
  closed: 0,
};

// Format planned date for the list cell: month -> "Jun 2026", week -> "W23 · Jun 1", null -> "—".
function formatPlanned(i: Issue): string {
  if (i.week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(i.week);
    if (m) {
      const year = parseInt(m[1] ?? "", 10);
      const week = parseInt(m[2] ?? "", 10);
      // ISO week to Monday (UTC).
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const week1Monday = new Date(jan4);
      week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
      const monday = new Date(week1Monday);
      monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
      const mon = monday.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
      const day = monday.getUTCDate();
      return `W${m[2]} · ${mon} ${day}`;
    }
    return i.week;
  }
  if (i.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(i.month);
    if (m) {
      const d = new Date(Date.UTC(parseInt(m[1] ?? "", 10), parseInt(m[2] ?? "", 10) - 1, 1));
      return d.toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
    }
    return i.month;
  }
  return "—";
}

// Sort key extractor — returns a sortable scalar per row.
function sortValue(
  i: Issue,
  key: SortKey,
  flow: Map<number, FlowResult>,
  insightCounts: Record<number, number>,
  statusNames: { todo: string; backlog: string },
): string | number {
  switch (key) {
    case "num":
      return i.num;
    case "title":
      return i.title.toLowerCase();
    case "state":
      return i.state;
    case "flow": {
      const f = flow.get(i.num);
      if (!f) return -1;
      // Combine state-bucket rank + within-bucket score so identical states fall back to score.
      const rank = FLOW_SORT_RANK[f.state] ?? 0;
      return rank * 1_000_000 + Math.min(999_999, Math.max(0, f.score));
    }
    case "assignee":
      return i.assignee.toLowerCase();
    case "planned":
      // Group, then date within: TODO status first, dated (week beats month) ascending,
      // then Backlog status, then untriaged — mirrors the board's placement precedence.
      if (i.projectStatus === statusNames.todo) return "0";
      if (i.projectStatus === statusNames.backlog) return "2";
      if (i.week ?? i.month) return `1:${i.week ?? i.month}`;
      return "3";
    case "updated":
      return i.updatedAt;
    case "signal":
      return insightCounts[i.num] ?? 0;
  }
}

function compare(
  a: Issue,
  b: Issue,
  sort: SortState,
  flow: Map<number, FlowResult>,
  insightCounts: Record<number, number>,
  statusNames: { todo: string; backlog: string },
): number {
  const va = sortValue(a, sort.key, flow, insightCounts, statusNames);
  const vb = sortValue(b, sort.key, flow, insightCounts, statusNames);
  let cmp: number;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb));
  return sort.dir === "asc" ? cmp : -cmp;
}

interface ColDef {
  key: SortKey | "labels";
  label: string;
  sortable: boolean;
  className: string;
}

const COLS: ColDef[] = [
  { key: "num", label: "#", sortable: true, className: "list-c-num" },
  { key: "title", label: "Title", sortable: true, className: "list-c-title" },
  { key: "state", label: "State", sortable: true, className: "list-c-state" },
  { key: "flow", label: "Flow", sortable: true, className: "list-c-flow" },
  { key: "assignee", label: "Assignee", sortable: true, className: "list-c-assignee" },
  { key: "labels", label: "Labels", sortable: false, className: "list-c-labels" },
  { key: "signal", label: "📎", sortable: true, className: "list-c-signal" },
  { key: "planned", label: "Planned", sortable: true, className: "list-c-planned" },
  { key: "updated", label: "Updated", sortable: true, className: "list-c-updated" },
];

// Columns whose first click should sort descending (high-to-low / newest-first).
const DESC_FIRST: ReadonlySet<SortKey> = new Set<SortKey>(["updated", "num", "signal"]);

function StateChip({ state }: { state: Issue["state"] }): JSX.Element {
  return <span className={`list-state ${state}`}><i className="dot" />{state}</span>;
}

function avatarClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "x";
  return `av av-${slug}`;
}

export function List({ issues, passFilter, onOpen, flow, insightCounts, todoStatusName, backlogStatusName }: ListProps): JSX.Element {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const visible = useMemo(() => {
    const filtered = issues.filter(passFilter);
    const statusNames = { todo: todoStatusName, backlog: backlogStatusName };
    return [...filtered].sort((a, b) => compare(a, b, sort, flow, insightCounts, statusNames));
  }, [issues, passFilter, sort, flow, insightCounts, todoStatusName, backlogStatusName]);

  // Click cycle: sort asc -> sort desc -> reset to default.
  // For the "updated" column the default is desc, so the cycle starts at desc -> asc -> reset.
  const handleHeaderClick = (key: SortKey): void => {
    if (sort.key !== key) {
      // First click on a fresh column: default dir is desc for updated/num/signal, asc for others.
      const firstDir: SortDir = DESC_FIRST.has(key) ? "desc" : "asc";
      setSort({ key, dir: firstDir });
      return;
    }
    // Already sorted by this column — flip, or reset on third click.
    const initial: SortDir = DESC_FIRST.has(key) ? "desc" : "asc";
    if (sort.dir === initial) {
      setSort({ key, dir: initial === "asc" ? "desc" : "asc" });
    } else {
      setSort(DEFAULT_SORT);
    }
  };

  return (
    <main className="board list-view reveal" style={{ animationDelay: "120ms" }}>
      <div className="list-card">
        <table className="list-table">
          <thead>
            <tr>
              {COLS.map((c) => {
                const active = c.sortable && sort.key === c.key;
                const cls = "list-th " + c.className + (c.sortable ? " sortable" : "") + (active ? " active" : "");
                return (
                  <th
                    key={c.key}
                    className={cls}
                    onClick={c.sortable ? () => handleHeaderClick(c.key as SortKey) : undefined}
                  >
                    <span className="list-th-label">{c.label}</span>
                    {active && (
                      <span className="list-sort-indicator">{sort.dir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => {
              const initial = (i.assignee || "?")[0] ?? "?";
              const shownLabels = i.labels.slice(0, 3);
              const extra = i.labels.length - shownLabels.length;
              return (
                <tr key={i.num} className="list-tr" onClick={() => onOpen(i)}>
                  <td className="list-td list-c-num">#{i.num}</td>
                  <td className="list-td list-c-title">
                    <span className="list-title-text">{i.title}</span>
                    {i.effort && <EffortChip effort={i.effort} source="label" />}
                  </td>
                  <td className="list-td list-c-state"><StateChip state={i.state} /></td>
                  <td className="list-td list-c-flow"><FlowPill result={flow.get(i.num)} size="md" /></td>
                  <td className="list-td list-c-assignee">
                    <span className="list-assignee">
                      <span className={avatarClass(i.assignee)}>{initial}</span>
                      <span className="list-assignee-name">{i.assignee}</span>
                    </span>
                  </td>
                  <td className="list-td list-c-labels">
                    <span className="list-labels">
                      {shownLabels.map((l) => (
                        <span key={l} className="list-label-chip">{l}</span>
                      ))}
                      {extra > 0 && <span className="list-label-more">+{extra}</span>}
                    </span>
                  </td>
                  <td className="list-td list-c-signal">
                    {(insightCounts[i.num] ?? 0) > 0 ? (
                      <span
                        className="list-signal-chip"
                        title={`${insightCounts[i.num]} customer insight${insightCounts[i.num] === 1 ? "" : "s"}`}
                      >
                        <span aria-hidden>📎</span>
                        {insightCounts[i.num]}
                      </span>
                    ) : (
                      <span className="list-signal-none">—</span>
                    )}
                  </td>
                  <td className="list-td list-c-planned">
                    {i.projectStatus === todoStatusName ? (
                      <span className="list-todo">TODO</span>
                    ) : i.projectStatus === backlogStatusName ? (
                      <span className="list-todo list-backlog">BACKLOG</span>
                    ) : (
                      formatPlanned(i)
                    )}
                  </td>
                  <td className="list-td list-c-updated">{formatRelative(i.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="list-empty">
            <div className="list-empty-title">No issues match the current filters</div>
            <div className="list-empty-hint">Try clearing the search or filter chips.</div>
          </div>
        )}
      </div>
    </main>
  );
}
