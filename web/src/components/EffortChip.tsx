import type { AiSummary, EffortRating, Issue } from "../../../shared/types";

interface EffortChipProps {
  effort: EffortRating;
  source: "label" | "estimate";
}

const EFFORT_COLOR: Record<EffortRating, string> = {
  lightning:   "var(--n)",    // teal — fast/light
  incremental: "#d97706",     // orange — medium (kept clear of foundation's red)
  foundation:  "var(--r)",    // red — heavy
};

export function EffortChip({ effort, source }: EffortChipProps): JSX.Element {
  const color = EFFORT_COLOR[effort];
  const isEst = source === "estimate";
  return (
    <span
      className={"effort-chip effort-" + effort + (isEst ? " est" : "")}
      style={{ color }}
      title={isEst ? "AI-estimated effort" : "effort label"}
    >
      {effort}
    </span>
  );
}

/** Pick the right chip given issue label (wins) + optional AI summary effort. */
export function resolveEffortChip(
  issue: Issue,
  summary: AiSummary | null | undefined,
): JSX.Element | null {
  if (issue.effort) return <EffortChip effort={issue.effort} source="label" />;
  if (summary?.effort) return <EffortChip effort={summary.effort} source="estimate" />;
  return null;
}
