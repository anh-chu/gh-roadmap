import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { BucketsInfo, FlowResult, Issue, Pull, RangeGranularity, WorkspaceConfig } from "../../../shared/types";
import type { BucketChange, MoveTarget } from "../hooks/useIssues";
import { Card } from "./Card";
import {
  buildColumns,
  gridMinWidth,
  issueColumnKey,
  monthSpanInWeekCols,
  type MonthSpan,
  type RangeColumn,
} from "../lib/timeRange";

interface BoardCol extends RangeColumn {
  isBacklog?: boolean;
  isTodo?: boolean;
}

// TODO column: meta-column for triaged-but-not-yet-scheduled items.
// Visual differentiator from Backlog: 2px var(--accent) left border (see .month-head.todo / .cell.todo-col).
const TODO_COL: BoardCol = {
  key: "todo",
  label: "TODO",
  sublabel: "",
  isCurrent: false,
  isTodo: true,
};

const BACKLOG_COL: BoardCol = {
  key: "backlog",
  label: "Backlog",
  sublabel: "",
  isCurrent: false,
  isBacklog: true,
};

const NO_MILESTONE = "(no milestone)";

interface BoardProps {
  issues: Issue[];
  buckets: BucketsInfo;
  config: WorkspaceConfig;
  onOpen: (i: Issue) => void;
  onMove: (
    num: number,
    target: MoveTarget,
    bucket?: BucketChange,
  ) => void;
  passFilter: (i: Issue) => boolean;
  flow: Map<number, FlowResult>;
  insightCounts?: Record<number, number>;
  pullsByIssue?: Map<number, Pull[]>;
  // False when GITHUB_PROJECT_NUMBER is unset — meta columns degrade to the
  // legacy app-only model (is_todo → TODO, unplanned → Backlog).
  projectPinned: boolean;
}

function ColHead({ c, count, done, collapsed }: { c: BoardCol; count: number; done: number; collapsed?: boolean }): JSX.Element {
  const pct = count ? Math.round((done / count) * 100) : 0;
  const cls =
    "month-head" +
    (c.isCurrent ? " current" : "") +
    (c.isBacklog ? " backlog" : "") +
    (c.isTodo ? " todo" : "") +
    (collapsed ? " collapsed" : "");
  // Collapsed (empty, non-current) time columns shrink to a labelled spine so
  // the populated weeks get the width instead of paying for empty future ones.
  if (collapsed) {
    return (
      <div className={cls} title={`${c.label} ${c.sublabel} · empty`}>
        <span className="nm">{c.label}</span>
      </div>
    );
  }
  return (
    <div className={cls}>
      <div className="row">
        <span className="nm">{c.label}</span>
        <span className="yr">{c.sublabel}</span>
      </div>
      <div className="stats">
        <span className="count">
          {count} {count === 1 ? "card" : "cards"}
        </span>
        <span className="bar">
          <i style={{ width: pct + "%" }} />
        </span>
        <span className="pct">{pct}%</span>
      </div>
    </div>
  );
}

// What a drop into a given cell will actually do, so the board can say it out
// loud instead of silently mutating GitHub.
type DropTone = "github" | "status" | "private";
interface DropHint {
  tone: DropTone;
  label: string;
}

interface CellProps {
  bucketKey: string;
  colKey: string;
  isLast: boolean;
  cards: Issue[];
  onOpen: (i: Issue) => void;
  onDrop: (num: number, colKey: string) => void;
  flow: Map<number, FlowResult>;
  insightCounts?: Record<number, number>;
  pullsByIssue?: Map<number, Pull[]>;
  granularity: RangeGranularity;
  dropHint: DropHint | null;
  collapsed?: boolean;
  emptyRow?: boolean;
  onCardDragBegin: (bucket: string, span?: boolean) => void;
  onCardDragFinish: () => void;
}

function Cell({ bucketKey, colKey, isLast, cards, onOpen, onDrop, flow, insightCounts, pullsByIssue, granularity, dropHint, collapsed, emptyRow, onCardDragBegin, onCardDragFinish }: CellProps): JSX.Element {
  const isBL = colKey === "backlog";
  const isTD = colKey === "todo";
  const cls =
    "cell" +
    (isBL ? " backlog-col" : "") +
    (isTD ? " todo-col" : "") +
    (isLast ? " last-row" : "") +
    (collapsed ? " collapsed" : "") +
    (emptyRow ? " empty-row" : "") +
    (dropHint ? ` drop-${dropHint.tone}` : "");

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
    const num = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (!Number.isFinite(num)) return;
    onDrop(num, colKey);
  };

  return (
    <div
      className={cls}
      data-col={colKey}
      data-bucket={bucketKey}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
    >
      {dropHint && <div className="drop-hint">{dropHint.label}</div>}
      {cards.map((c) => (
        <Card
          key={c.num}
          issue={c}
          onOpen={onOpen}
          flowResult={flow.get(c.num)}
          insightCount={insightCounts?.[c.num] ?? 0}
          pulls={pullsByIssue?.get(c.num)}
          granularity={granularity}
          onDragBegin={() => onCardDragBegin(bucketKey)}
          onDragFinish={onCardDragFinish}
        />
      ))}
    </div>
  );
}

function issueBucket(i: Issue, buckets: BucketsInfo): string | null {
  if (buckets.field === "none") return "__all__";
  if (buckets.field === "label") {
    const prefix = `${buckets.value}:`;
    const hit = i.labels.find((l) => l.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  }
  if (buckets.field === "assignee") return i.assignee || null;
  return i.milestone ?? NO_MILESTONE;
}

export function Board({ issues, buckets, config, onOpen, onMove, passFilter, flow, insightCounts, pullsByIssue, projectPinned }: BoardProps): JSX.Element {
  const granularity = config.rangeGranularity;
  const timeCols = buildColumns(config);
  const metaCols: BoardCol[] = [TODO_COL, BACKLOG_COL];
  const pinned = config.pinMetaCols;
  // Single-grid mode: time cols + meta cols share one grid (current behaviour).
  // Pinned mode: time cols in scroll grid, meta cols in pinned grid.
  const cols: BoardCol[] = pinned ? timeCols : [...timeCols, ...metaCols];

  const showLabelCol = buckets.field !== "none";

  // Milestone bucketing: rows arrive alphabetically from the server. Re-sort them
  // by due date (soonest first, undated then no-milestone last) and auto-scroll the
  // next upcoming milestone to the top so passed ones sit above (scroll up to reach).
  const byMilestone = buckets.field === "milestone";
  const dueByMilestone = useMemo(() => {
    const m = new Map<string, string | null>();
    if (byMilestone) {
      for (const i of issues) {
        if (!i.milestone) continue;
        if (i.milestoneDue && !m.get(i.milestone)) m.set(i.milestone, i.milestoneDue);
        else if (!m.has(i.milestone)) m.set(i.milestone, i.milestoneDue ?? null);
      }
    }
    return m;
  }, [issues, byMilestone]);

  const rows = useMemo<string[]>(() => {
    const base = buckets.field === "none" ? ["__all__"] : buckets.options;
    if (!byMilestone) return base;
    return [...base].sort((a, b) => {
      if (a === NO_MILESTONE) return 1;
      if (b === NO_MILESTONE) return -1;
      const da = dueByMilestone.get(a) ?? null;
      const db = dueByMilestone.get(b) ?? null;
      if (da && db) return da.localeCompare(db);
      if (da) return -1;
      if (db) return 1;
      return a.localeCompare(b);
    });
  }, [buckets.field, buckets.options, byMilestone, dueByMilestone]);

  const nextMilestone = useMemo(() => {
    if (!byMilestone) return null;
    const t0 = new Date().setHours(0, 0, 0, 0);
    for (const r of rows) {
      if (r === NO_MILESTONE) continue;
      const due = dueByMilestone.get(r);
      if (due && new Date(due).getTime() >= t0) return r;
    }
    return null;
  }, [byMilestone, rows, dueByMilestone]);

  const nextRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (nextMilestone && nextRowRef.current) {
      nextRowRef.current.scrollIntoView({ block: "start", inline: "nearest" });
    }
  }, [nextMilestone]);

  // Reclaim board width: empty, non-current time columns collapse to a thin
  // labelled spine so the populated weeks aren't squeezed by empty future ones.
  const COLLAPSED_W = "46px";
  const issueInTimeCol = (i: Issue, key: string): boolean => {
    if (colKeyForIssue(i) === key) return true;
    if (!isMonthSpan(i) || !i.month) return false;
    const span = monthSpanInWeekCols(i.month, timeCols);
    if (!span) return false;
    return timeCols.slice(span.startIdx, span.endIdx + 1).some((c) => c.key === key);
  };

  const colHasCards = (key: string): boolean => issues.some((i) => passFilter(i) && issueInTimeCol(i, key));
  const isCollapsed = (c: BoardCol): boolean =>
    !c.isCurrent && !c.isTodo && !c.isBacklog && !colHasCards(c.key);
  const timeTrack = timeCols
    .map((c) => {
      if (granularity !== "week") return isCollapsed(c) ? COLLAPSED_W : gridMinWidth(granularity);
      return isCollapsed(c) ? "23px 23px" : "minmax(80px, 0.5fr) minmax(80px, 0.5fr)";
    })
    .join(" ");

  // A bucket row is "empty in view" when no filtered card lands in any rendered
  // column (off-grid/out-of-range issues don't count). Such rows collapse short.
  const colKeySet = new Set(cols.map((c) => c.key));
  const bucketHasCards = (bucket: string): boolean =>
    issues.some(
      (i) =>
        issueBucket(i, buckets) === bucket &&
        passFilter(i) &&
        (colKeySet.has(colKeyForIssue(i)) || (isMonthSpan(i) && i.month !== null && monthSpanInWeekCols(i.month, timeCols) !== null)),
    );

  // The bucket (row) the in-flight card came from — drives drop-intent hints.
  const [dragSrcBucket, setDragSrcBucket] = useState<string | null>(null);
  const [dragSrcSpan, setDragSrcSpan] = useState(false);

  // What a drop into (bucket, colKey) will actually do. A cross-bucket move in
  // label/assignee/milestone mode is a real GitHub mutation the whole team sees;
  // a horizontal time move is app-only. Say so before the drop, not after.
  function dropIntentFor(bucket: string, colKey: string): DropHint | null {
    if (dragSrcBucket === null) return null;
    if (buckets.field !== "none" && bucket !== dragSrcBucket) {
      const what =
        buckets.field === "label"
          ? `${buckets.value}:${bucket}`
          : buckets.field === "assignee"
            ? `assignee → ${bucket === NO_MILESTONE ? "none" : bucket}`
            : `milestone → ${bucket === NO_MILESTONE ? "none" : bucket}`;
      return { tone: "github", label: `Writes ${what} to GitHub · visible to team` };
    }
    if (colKey === "todo" || colKey === "backlog") {
      return { tone: "status", label: `Moves to ${colKey === "todo" ? "To Do" : "Backlog"}` };
    }
    if (dragSrcSpan) {
      return { tone: "private", label: "Re-plans to this week · was whole month" };
    }
    return { tone: "private", label: "Planning only · private" };
  }

  // Translate a drop-target column key into the placement MoveTarget.
  function targetForCol(colKey: string): MoveTarget {
    if (colKey === "todo") return { kind: "todo" };
    if (colKey === "backlog") return { kind: "backlog" };
    if (granularity === "week") return { kind: "week", value: colKey };
    if (granularity === "month") return { kind: "month", value: colKey };
    return { kind: "quarter", value: colKey };
  }

  const handleDrop = (bucket: string) => (num: number, colKey: string) => {
    const target = targetForCol(colKey);
    let bucketChange: BucketChange | undefined;
    if (buckets.field === "label") {
      bucketChange = { field: "label", prefix: buckets.value, bucket };
    } else if (buckets.field === "assignee") {
      bucketChange = { field: "assignee", bucket };
    } else if (buckets.field === "milestone") {
      bucketChange = { field: "milestone", bucket: bucket === NO_MILESTONE ? null : bucket };
    }
    onMove(num, target, bucketChange);
  };

  // For each issue, derive its column key under the active granularity.
  // TODO/Backlog placement reads the GitHub Projects Status (single source of
  // truth; isTodo is deprecated): a planned date wins → time col (so a milestone-
  // snapped item leaves its meta column); then Todo status → TODO; then Backlog
  // status; else off-grid (status unset = untriaged). The meta columns hold only
  // items with no planned date — TODO = parked/not-yet-plannable.
  function colKeyForIssue(i: Issue): string {
    if (!projectPinned) {
      // Legacy model (no pinned project): is_todo drives TODO, unplanned → Backlog.
      if (i.isTodo) return "todo";
      return issueColumnKey(granularity, i.month, i.week) ?? "backlog";
    }
    const timeKey = issueColumnKey(granularity, i.month, i.week);
    if (timeKey) return timeKey;
    if (i.projectStatus === config.todoStatusName) return "todo";
    return i.projectStatus === config.backlogStatusName ? "backlog" : "untriaged";
  }

  function isMonthSpan(i: Issue): boolean {
    return granularity === "week" && !i.week && !!i.month;
  }

  function renderBucketLabel(bucket: string, isLast: boolean): JSX.Element {
    const rowIssues = issues.filter((i) => issueBucket(i, buckets) === bucket);
    const total = rowIssues.length;
    const planned = rowIssues.filter((i) => i.month || i.week).length;
    return (
      <div ref={bucket === nextMilestone ? nextRowRef : undefined} className={"bucket-label" + (isLast ? " last-row" : "") + (bucketHasCards(bucket) ? "" : " empty-row")}>
        <span className="nm">{bucket}</span>
        {buckets.field === "label" && (
          <span className="lbl">{buckets.value}:{bucket}</span>
        )}
        <div className="nums">
          <b>{planned}</b>
          <small>/ {total} planned</small>
        </div>
      </div>
    );
  }

  function renderColHead(c: BoardCol): JSX.Element {
    const inCol = issues.filter((i) => passFilter(i) && issueInTimeCol(i, c.key));
    const done = inCol.filter((i) => i.state === "closed").length;
    return <ColHead key={c.key} c={c} count={inCol.length} done={done} collapsed={isCollapsed(c)} />;
  }

  function renderCells(bucket: string, isLast: boolean, list: BoardCol[]): JSX.Element[] {
    const emptyRow = !bucketHasCards(bucket);
    return list.map((c) => {
      const cards = issues.filter(
        (i) => issueBucket(i, buckets) === bucket && colKeyForIssue(i) === c.key && passFilter(i) && !isMonthSpan(i),
      );
      return (
        <Cell
          key={`${bucket}-${c.key}`}
          bucketKey={bucket}
          colKey={c.key}
          isLast={isLast}
          cards={cards}
          onOpen={onOpen}
          onDrop={handleDrop(bucket)}
          flow={flow}
          insightCounts={insightCounts}
          pullsByIssue={pullsByIssue}
          granularity={granularity}
          dropHint={dropIntentFor(bucket, c.key)}
          collapsed={isCollapsed(c)}
          emptyRow={emptyRow}
          onCardDragBegin={(bucket, span) => {
            setDragSrcBucket(bucket);
            setDragSrcSpan(!!span);
          }}
          onCardDragFinish={() => {
            setDragSrcBucket(null);
            setDragSrcSpan(false);
          }}
        />
      );
    });
  }

  const labelOffset = showLabelCol ? 1 : 0;

  // Lay spanning month-bands of a bucket onto stacked rows: greedy interval
  // packing so non-overlapping months share a row. Each entry carries its
  // resolved row (0-based, rendered into grid-row row+2 — row 1 holds the cells).
  function spanEntriesFor(bucket: string): { i: Issue; span: MonthSpan; monthTag: string; row: number }[] {
    if (granularity !== "week") return [];
    const raw = issues
      .filter((i) => issueBucket(i, buckets) === bucket && passFilter(i) && isMonthSpan(i))
      .map((i) => {
        const span: MonthSpan | null = i.month ? monthSpanInWeekCols(i.month, timeCols) : null;
        if (!span) return null;
        const monthTag = new Date(Date.UTC(2000, Number(i.month!.slice(5, 7)) - 1, 1))
          .toLocaleString("en", { month: "short" })
          .toUpperCase();
        return { i, span, monthTag };
      })
      .filter((x): x is { i: Issue; span: MonthSpan; monthTag: string } => x !== null)
      .sort((a, b) => a.span.startLine - b.span.startLine);

    const rowEnds: number[] = [];
    return raw.map((e) => {
      let row = rowEnds.findIndex((end) => e.span.startLine >= end);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(e.span.endLine);
      } else {
        rowEnds[row] = e.span.endLine;
      }
      return { ...e, row };
    });
  }

  function renderSpanBands(bucket: string, entries: { i: Issue; span: MonthSpan; monthTag: string; row: number }[]): JSX.Element[] {
    // A band whose end line equals another band's start line means two months meet
    // at a shared straddle-week midline; give those inner edges a small gap.
    const startLines = new Set(entries.map((e) => e.span.startLine));
    const endLines = new Set(entries.map((e) => e.span.endLine));

    return entries.map(({ i, span, monthTag, row }) => {
        const seamStart = span.boundStart && endLines.has(span.startLine);
        const seamEnd = span.boundEnd && startLines.has(span.endLine);
        const cls = `span-band${seamStart ? " seam-start" : ""}${seamEnd ? " seam-end" : ""}`;
        const style: CSSProperties = {
          gridColumn: `${span.startLine} / ${span.endLine}`,
          gridRow: String(row + 2),
        };
        return (
          <div className={cls} style={style} key={`span-${bucket}-${i.num}`}>
            <Card
              issue={i}
              onOpen={onOpen}
              flowResult={flow.get(i.num)}
              insightCount={insightCounts?.[i.num] ?? 0}
              pulls={pullsByIssue?.get(i.num)}
              granularity={granularity}
              monthTag={monthTag}
              onDragBegin={() => {
                setDragSrcBucket(bucket);
                setDragSrcSpan(true);
              }}
              onDragFinish={() => {
                setDragSrcBucket(null);
                setDragSrcSpan(false);
              }}
            />
          </div>
        );
      });
  }

  function renderTimeRegion(bucket: string, isLast: boolean, mode: "single" | "split"): JSX.Element {
    const timeSpan = granularity === "week" ? 2 * timeCols.length : timeCols.length;
    const entries = spanEntriesFor(bucket);
    const bandRows = entries.reduce((m, e) => Math.max(m, e.row + 1), 0);
    const style: CSSProperties = {
      gridColumn: mode === "split" ? `${labelOffset + 1} / -1` : `${labelOffset + 1} / ${labelOffset + 1 + timeSpan}`,
    };
    // Pin the lane's row tracks so the cells fill the row's full height (the
    // subgrid wrapper otherwise leaves them at row-1 height, so a taller sibling
    // — e.g. stacked Backlog cards — leaves an empty, borderless gap below).
    // No bands: one filler row so cells stretch. With bands: cells size row 1,
    // each band-row is max-content, and a trailing 1fr absorbs extra height so
    // the column dividers (grid-row 2 / -1) reach the true bottom.
    style.gridTemplateRows = bandRows > 0 ? `repeat(${bandRows + 1}, max-content) 1fr` : "1fr";
    return (
      <div className={"span-lane" + (isLast ? " last-row" : "")} style={style}>
        {renderCells(bucket, isLast, timeCols)}
        {bandRows > 0 &&
          timeCols.map((c, idx) => (
            <div
              key={`span-div-${bucket}-${c.key}`}
              className="span-divider"
              style={{ gridColumn: `${idx * 2 + 1} / span 2`, gridRow: "2 / -1" }}
            />
          ))}
        {renderSpanBands(bucket, entries)}
      </div>
    );
  }

  // ── SINGLE-GRID MODE (pinned === false): unchanged from original.
  if (!pinned) {
    const cellTemplate = `${timeTrack} 220px 220px`;
    const gridStyle: CSSProperties = showLabelCol
      ? { ["--grid-cols" as string]: `156px ${cellTemplate}` }
      : { ["--grid-cols" as string]: cellTemplate };

    return (
      <main className="board reveal" style={{ animationDelay: "120ms" }}>
        <div className={"grid" + (granularity === "week" ? " week-cols" : "")} style={gridStyle}>
          {showLabelCol && <div className="month-head corner"></div>}
          {cols.map(renderColHead)}

          {rows.map((bucket, rowIdx) => {
            const isLast = rowIdx === rows.length - 1;
            return (
              <Fragment key={`bucket-row-${bucket}`}>
                {showLabelCol && renderBucketLabel(bucket, isLast)}
                {renderTimeRegion(bucket, isLast, "single")}
                {renderCells(bucket, isLast, metaCols)}
              </Fragment>
            );
          })}
        </div>
      </main>
    );
  }

  // ── SPLIT MODE (pinned === true): two side-by-side grids using subgrid for shared rows.
  // Outer .board-split defines the row tracks ONCE (header + one row per bucket).
  // Inner .board-scroll holds label col + time cols and scrolls horizontally.
  // Inner .board-pinned holds TODO + Backlog and stays fixed to the right edge.
  const scrollCols = showLabelCol ? `156px ${timeTrack}` : timeTrack;
  const splitStyle: CSSProperties = {
    ["--scroll-cols" as string]: scrollCols,
    gridTemplateRows: `auto ${rows.map((b) => (bucketHasCards(b) ? "minmax(130px, max-content)" : "minmax(40px, max-content)")).join(" ")}`,
  };

  return (
    <main className="board reveal" style={{ animationDelay: "120ms" }}>
      <div className="board-split" style={splitStyle}>
        <div className={"board-scroll" + (granularity === "week" ? " week-cols" : "")}>
          {showLabelCol && <div className="month-head corner"></div>}
          {timeCols.map(renderColHead)}
          {rows.map((bucket, rowIdx) => {
            const isLast = rowIdx === rows.length - 1;
            return (
              <Fragment key={`scroll-row-${bucket}`}>
                {showLabelCol && renderBucketLabel(bucket, isLast)}
                {renderTimeRegion(bucket, isLast, "split")}
              </Fragment>
            );
          })}
        </div>
        <div className="board-pinned">
          {metaCols.map(renderColHead)}
          {rows.map((bucket, rowIdx) => {
            const isLast = rowIdx === rows.length - 1;
            return (
              <Fragment key={`pinned-row-${bucket}`}>
                {renderCells(bucket, isLast, metaCols)}
              </Fragment>
            );
          })}
        </div>
      </div>
    </main>
  );
}
