import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue } from "../../../shared/types";
import { TypeBadge } from "./TypeBadge";
import { useIssueSummary } from "../hooks/useIssueSummary";

interface IssueRefProps {
  num: number;
  issue: Issue | null;
  onOpen: (i: Issue) => void;
}

interface TooltipAnchor {
  top: number;
  left: number;
}

const TOOLTIP_WIDTH = 360;
const TOOLTIP_OFFSET = 6;
const HOVER_DELAY = 400;

export function IssueRef({ num, issue, onOpen }: IssueRefProps): JSX.Element {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const timerRef = useRef<number | null>(null);
  const elRef = useRef<HTMLSpanElement | null>(null);

  function cancelHover(): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAnchor(null);
  }

  function computeAnchor(): TooltipAnchor {
    const rect = elRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + TOOLTIP_OFFSET;
    let left = rect.left;
    if (left + TOOLTIP_WIDTH > vw - 8) {
      left = Math.max(8, rect.right - TOOLTIP_WIDTH);
    }
    if (top + 280 > vh - 8) {
      top = Math.max(8, rect.top - TOOLTIP_OFFSET - 280);
    }
    return { top, left };
  }

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

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (issue === null) {
    return <span className="issue-ref out-of-scope">#{num}</span>;
  }

  const onMouseEnter = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setAnchor(computeAnchor());
      timerRef.current = null;
    }, HOVER_DELAY);
  };

  const onMouseLeave = (): void => {
    cancelHover();
  };

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    cancelHover();
    onOpen(issue);
  };

  return (
    <span
      ref={elRef}
      className="issue-ref"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      #{num}
      {anchor !== null && <IssueRefTooltipPortal issue={issue} anchor={anchor} />}
    </span>
  );
}

function IssueRefTooltipPortal({
  issue,
  anchor,
}: {
  issue: Issue;
  anchor: TooltipAnchor;
}): JSX.Element | null {
  const { summary, loading, disabled } = useIssueSummary(issue.num);
  return createPortal(
    <div
      className="card-summary-tooltip"
      style={{ top: anchor.top, left: anchor.left, width: TOOLTIP_WIDTH, pointerEvents: "none" }}
    >
      <div className="issue-ref-tooltip-title">{issue.title}</div>
      <TypeBadge issue={issue} />
      <div className="issue-ref-tooltip-meta">
        {issue.assignee} · {issue.state}
      </div>
      <div className="issue-ref-tooltip-summary">
        {disabled ? null : loading && !summary ? (
          <>
            <div className="skel-bar skel-bar-wide" />
            <div className="skel-bar skel-bar-wide" />
            <div className="skel-bar skel-bar-wide" style={{ width: "55%" }} />
          </>
        ) : summary ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.summary}</ReactMarkdown>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
