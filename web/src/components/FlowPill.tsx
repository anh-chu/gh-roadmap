import type { CSSProperties } from "react";
import type { FlowDisagreement, FlowResult, FlowState } from "../../../shared/types";

interface Props {
  result: FlowResult | undefined;
  size?: "sm" | "md";
  hideBoard?: boolean;
}

const COLOR: Record<FlowState, string> = {
  shipping: "var(--green)",
  "in-review": "var(--n)",
  "in-code": "var(--blue)",
  discussing: "var(--purple)",
  stalled: "var(--e)",
  cold: "var(--ink-3)",
  fresh: "var(--accent)",
  closed: "var(--ink-3)",
};

const LABEL: Record<FlowState, string> = {
  shipping: "shipping",
  "in-review": "in review",
  "in-code": "in code",
  discussing: "discussing",
  stalled: "stalled",
  cold: "cold",
  fresh: "fresh",
  closed: "closed",
};

const DISAGREE_NOTE: Record<FlowDisagreement, string> = {
  "board-done-open": "board says done, but the issue is still open with no merged PR",
  "board-active-merged": "board still active, but a linked PR already merged",
  "board-review-idle": "board says in review, but no review activity in the window",
};

export function FlowPill({ result, size = "md", hideBoard = false }: Props): JSX.Element | null {
  if (!result) return null;
  if (result.state === "closed" && size === "sm") return null;

  const rawBoardStatus = hideBoard ? null : result.boardStatus ?? null;
  const boardStatus = rawBoardStatus && rawBoardStatus.trim() ? rawBoardStatus : null;
  const disagreement = hideBoard ? null : result.disagreement ?? null;
  const stale = result.state === "stalled" || result.state === "cold";
  const color = disagreement ? "var(--r)" : stale ? "var(--e)" : COLOR[result.state];
  const label = boardStatus ?? LABEL[result.state];
  const staleDays = size === "md" && stale && Number.isFinite(result.score) ? Math.round(result.score) : null;

  const tipParts = [
    boardStatus ? `flow: ${LABEL[result.state]} (score ${result.score.toFixed(1)})` : `${label} (score ${result.score.toFixed(1)})`,
  ];
  if (boardStatus) tipParts.push(`board: ${boardStatus}`);
  if (disagreement) tipParts.push(DISAGREE_NOTE[disagreement]);
  if (result.noPrLinked) tipParts.push("no PR linked");
  if (result.signals.length) tipParts.push(result.signals.join(" · "));

  const style: CSSProperties = { color };
  const cls = `flow-pill ${result.state} size-${size}${disagreement ? " disagree" : ""}`;
  if (size === "sm") {
    return (
      <span className={cls} style={style} title={tipParts.join(" · ")}>
        <i className="flow-dot" />
      </span>
    );
  }

  return (
    <span className={cls} style={style} title={tipParts.join(" · ")}>
      <i className="flow-dot" />
      {disagreement ? <span className="flow-warn" aria-hidden>⚠</span> : null}
      <span className="flow-label">{label}</span>
      {staleDays !== null ? <span className="flow-age">quiet {staleDays}d</span> : null}
      {result.noPrLinked ? <span className="flow-nopr">no PR</span> : null}
    </span>
  );
}
