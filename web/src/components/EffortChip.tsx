import type { AiSummary, EffortRating, Issue } from "../../../shared/types";

interface EffortChipProps {
  effort: EffortRating;
  source: "label" | "estimate";
  // "bars" renders effort as a 3-step signal-bar magnitude glyph (board card);
  // "chip" is the labelled pill used everywhere else.
  display?: "chip" | "bars";
}

const EFFORT_COLOR: Record<EffortRating, string> = {
  lightning:   "var(--n)",    // teal — fast/light
  incremental: "#d97706",     // orange — medium (kept clear of foundation's red)
  foundation:  "var(--r)",    // red — heavy
};

// Ordinal weight: how many of the three bars light up.
const EFFORT_LEVEL: Record<EffortRating, number> = {
  lightning: 1,
  incremental: 2,
  foundation: 3,
};

export function EffortChip({ effort, source, display = "chip" }: EffortChipProps): JSX.Element {
  const color = EFFORT_COLOR[effort];
  const isEst = source === "estimate";

  if (display === "bars") {
    const level = EFFORT_LEVEL[effort];
    return (
      <span
        className={"effort-bars" + (isEst ? " est" : "")}
        style={{ color }}
        title={`effort: ${effort}` + (isEst ? " (AI estimate)" : "")}
        aria-label={`effort: ${effort}`}
      >
        {[1, 2, 3].map((n) => (
          <i key={n} className={n <= level ? "on" : ""} />
        ))}
      </span>
    );
  }

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
  display: "chip" | "bars" = "chip",
): JSX.Element | null {
  if (issue.effort) return <EffortChip effort={issue.effort} source="label" display={display} />;
  if (summary?.effort) return <EffortChip effort={summary.effort} source="estimate" display={display} />;
  return null;
}
