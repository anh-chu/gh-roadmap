import type { Issue } from "../../../shared/types";

// GitHub IssueTypeColor enum → hex, mirroring GitHub's own type palette for instant recognition.
const TYPE_COLOR: Record<string, string> = {
  BLUE: "#0969da",
  GRAY: "#59636e",
  GREEN: "#1a7f37",
  ORANGE: "#bc4c00",
  PINK: "#bf3989",
  PURPLE: "#8250df",
  RED: "#cf222e",
  YELLOW: "#9a6700",
};

export function TypeBadge({ issue }: { issue: Issue }): JSX.Element | null {
  if (!issue.issueType) return null;
  const color = TYPE_COLOR[issue.issueTypeColor ?? "GRAY"] ?? TYPE_COLOR.GRAY;
  return (
    <span className="type-badge" style={{ color }} title={`Type: ${issue.issueType}`}>
      <span className="type-dot" style={{ background: color }} aria-hidden />
      {issue.issueType}
    </span>
  );
}
