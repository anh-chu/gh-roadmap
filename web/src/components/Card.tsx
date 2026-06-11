import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FlowResult, Issue, RangeGranularity } from "../../../shared/types";
import { FlowPill } from "./FlowPill";
import { resolveEffortChip } from "./EffortChip";
import { useIssueSummary } from "../hooks/useIssueSummary";
import { driftState, milestoneColumnKey, planPrecision } from "../lib/timeRange";
import { canEdit } from "../lib/role";

interface CardProps {
  issue: Issue;
  onOpen: (i: Issue) => void;
  flowResult?: FlowResult | undefined;
  insightCount?: number;
  granularity?: RangeGranularity;
}

interface TooltipAnchor {
  top: number;
  left: number;
}

const TOOLTIP_WIDTH = 360;
const TOOLTIP_OFFSET = 8;

export function Card({ issue, onOpen, flowResult, insightCount = 0, granularity }: CardProps): JSX.Element {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const timerRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.currentTarget.classList.add("dragging");
    e.dataTransfer.setData("text/plain", String(issue.num));
    e.dataTransfer.effectAllowed = "move";
    // Drag and hover-tooltip don't mix.
    cancelHover();
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>): void => {
    e.currentTarget.classList.remove("dragging");
  };

  function cancelHover(): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAnchor(null);
  }

  function computeAnchor(): TooltipAnchor {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Default: below + left-aligned to the card.
    let top = rect.bottom + TOOLTIP_OFFSET;
    let left = rect.left;
    // Flip horizontally if it would overflow the right edge.
    if (left + TOOLTIP_WIDTH > vw - 8) {
      left = Math.max(8, rect.right - TOOLTIP_WIDTH);
    }
    // Flip vertically if it would overflow the bottom (estimated tooltip max-height = ~280px).
    if (top + 280 > vh - 8) {
      top = Math.max(8, rect.top - TOOLTIP_OFFSET - 280);
    }
    return { top, left };
  }

  const onMouseEnter = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setAnchor(computeAnchor());
      timerRef.current = null;
    }, 600);
  };
  const onMouseLeave = (): void => {
    cancelHover();
  };

  // Reposition on scroll / resize so the tooltip tracks the card.
  useEffect(() => {
    if (anchor === null) return;
    const update = (): void => setAnchor(computeAnchor());
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor !== null]);

  // Clean up timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Effort label wins; fall back to the AI estimate (module-cached fetch).
  const { summary } = useIssueSummary(issue.num);
  const initial = (issue.assignee || "?")[0] ?? "?";

  // Milestone-vs-plan drift: warn chip on actual drift; a faint notice when an issue
  // is planned but has no milestone at all (undated milestones show nothing — never claim "no milestone" when one exists).
  const dState = granularity !== undefined ? driftState(issue) : null;
  const drifted = dState === "drift";
  const precision = drifted ? planPrecision(issue) : null;
  const milestoneCol = precision ? milestoneColumnKey(issue.milestoneDue, precision) : null;
  // Chip only when the milestone is truly absent — a milestone present but undated shows nothing.
  const unanchored = dState === "unanchored" && !issue.milestone && issue.state !== "closed";

  return (
    <div
      ref={cardRef}
      className="card"
      draggable={canEdit()} /* viewers can't move issues — drag disabled at the source */
      data-num={issue.num}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(issue)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="card-head">
        <span className="card-num">#{issue.num}</span>
        <FlowPill result={flowResult} size="md" />
        {resolveEffortChip(issue, summary)}
      </div>
      <div className="card-title">{issue.title}</div>
      <div className="card-foot">
        <span className="card-assignee">
          <span className={`av av-${issue.assignee}`}>{initial}</span>
          <span className="card-assignee-name">{issue.assignee}</span>
        </span>
        <span className="card-meta">
          {insightCount > 0 ? (
            <span className="com card-insight-chip" title={`${insightCount} insight${insightCount === 1 ? "" : "s"}`}>
              <span aria-hidden>📎</span>
              {insightCount}
            </span>
          ) : null}
          {milestoneCol ? (
            <span className="com card-drift-chip" title={`Milestone "${issue.milestone ?? ""}" due ${milestoneCol} — plan disagrees`}>
              <span aria-hidden>⚠</span>
              {milestoneCol}
            </span>
          ) : null}
          {unanchored ? (
            <span
              className="com card-unanchored-chip"
              title="Planned, but no milestone"
            >
              <span aria-hidden>⚠</span>
              no milestone
            </span>
          ) : null}
          {issue.comments ? (
            <span className="com">
              <svg viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 4.5C3 3.7 3.7 3 4.5 3h7c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H7l-3 2.5V11h-.5C2.7 11 2 10.3 2 9.5v-5C2 3.7 2.7 3 3.5 3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
              {issue.comments}
            </span>
          ) : null}
          <span className={`card-state ${issue.state}`}>
            <span className="ring"></span>
          </span>
        </span>
      </div>
      {anchor !== null && <CardSummaryTooltipPortal num={issue.num} anchor={anchor} />}
    </div>
  );
}

function CardSummaryTooltipPortal({
  num,
  anchor,
}: {
  num: number;
  anchor: TooltipAnchor;
}): JSX.Element | null {
  const { summary, loading, disabled } = useIssueSummary(num);
  if (disabled) return null;
  return createPortal(
    <div
      className="card-summary-tooltip"
      style={{ top: anchor.top, left: anchor.left, width: TOOLTIP_WIDTH }}
    >
      {loading && !summary ? (
        <>
          <div className="skel-bar skel-bar-wide" />
          <div className="skel-bar skel-bar-wide" />
          <div className="skel-bar skel-bar-wide" style={{ width: "55%" }} />
        </>
      ) : summary ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.summary}</ReactMarkdown>
      ) : null}
    </div>,
    document.body,
  );
}
