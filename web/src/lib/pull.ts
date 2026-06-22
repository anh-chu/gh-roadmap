import type { Pull, PullCi, PullReviewDecision } from "../../../shared/types";

// Human label + CSS modifier for a PR's lifecycle state (draft/merged/open/closed).
export function pullStateLabel(p: Pull): { label: string; mod: string } {
  if (p.merged) return { label: "merged", mod: "merged" };
  if (p.state === "closed") return { label: "closed", mod: "closed" };
  if (p.isDraft) return { label: "draft", mod: "draft" };
  return { label: "open", mod: "open" };
}

export const CI_LABEL: Record<NonNullable<PullCi>, string> = {
  success: "CI green",
  failure: "CI failing",
  pending: "CI running",
};

export const REVIEW_LABEL: Record<NonNullable<PullReviewDecision>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "reviewed",
};

// Pick the most progress-relevant PR for a one-glance card chip:
// prefer an open/draft PR (active work) over merged/closed; among ties, latest update.
export function primaryPull(pulls: Pull[]): Pull | null {
  if (pulls.length === 0) return null;
  const rank = (p: Pull): number => (p.merged || p.state === "closed" ? 0 : 1);
  return [...pulls].sort((a, b) => rank(b) - rank(a) || (b.updatedAt > a.updatedAt ? 1 : -1))[0] ?? null;
}
