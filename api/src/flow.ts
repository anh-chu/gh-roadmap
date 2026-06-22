import type { FlowResult, FlowState } from "../../shared/types.js";

// Pre-fetched per-issue data passed into computeFlowState. Caller is responsible
// for joining issues + pulls + reviews + checks + events + comments.
export interface FlowInput {
  // Optional "now" override for historical replay. Defaults to Date.now() when omitted.
  // approximate: when set, age-based signals (stalled, cold, fresh) are computed
  // relative to this timestamp; signals like "stalled 14d ago" lose precision
  // because we don't have a per-day timeline of stall transitions.
  nowMs?: number;
  issue: {
    number: number;
    state: "open" | "closed";
    createdAt: string | null;
    updatedAt: string;
    assignee: string | null;
    commentCount: number;
    lastCommentAt: string | null;
  };
  pulls: Array<{
    number: number;
    state: "open" | "closed";
    merged: boolean;
    mergedAt: string | null;
    isDraft: boolean;
    lastCommitAt: string | null;
    ciStatus: string | null;
    reviews: Array<{ state: string; submittedAt: string; author: string | null }>;
  }>;
  events: Array<{ type: string; createdAt: string }>;
  thresholds: FlowThresholdsResolved;
}

export interface FlowThresholdsResolved {
  shippingHours: number;
  reviewActivityDays: number;
  codeActivityDays: number;
  discussionDays: number;
  stallDays: number;
  coldDays: number;
  freshDays: number;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function ageMs(iso: string | null, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return now - t;
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "never";
  const h = Math.round(ms / HOUR);
  if (h < 1) return `${Math.round(ms / 60000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Events per day in the last `days` window.
function eventDensity(events: FlowInput["events"], now: number, days: number): number {
  const floor = now - days * DAY;
  let c = 0;
  for (const e of events) {
    const t = Date.parse(e.createdAt);
    if (Number.isFinite(t) && t >= floor) c++;
  }
  return c / Math.max(1, days);
}

function commentDensity(lastCommentAt: string | null, commentCount: number, now: number, days: number): number {
  if (!lastCommentAt) return 0;
  const t = Date.parse(lastCommentAt);
  if (!Number.isFinite(t)) return 0;
  if (now - t > days * DAY) return 0;
  // Approximation — we only have last comment + total count. Cap to count / days.
  return Math.min(commentCount, days) / days;
}

export function computeFlowState(input: FlowInput): FlowResult {
  const now = input.nowMs ?? Date.now();
  const { issue, pulls, events, thresholds: t } = input;
  const signals: string[] = [];

  if (issue.state === "closed") {
    return { state: "closed", score: 0, signals: ["issue closed"] };
  }

  // shipping — a merged PR ships the issue, or open PR ready + CI green + approved.
  // A merged linked PR keeps the issue in `shipping` even past the merge window: the work
  // landed, it's just not closed yet. Without this an open-but-shipped issue decays into
  // "discussing" (its last comment), which reads as activity rather than done. `shippingHours`
  // no longer gates the state — it only marks a fresh ship vs a shipped-but-still-open one.
  let recentMergeMs = Number.POSITIVE_INFINITY;
  for (const p of pulls) {
    if (p.merged && p.mergedAt) {
      const age = ageMs(p.mergedAt, now);
      if (age < recentMergeMs) recentMergeMs = age;
    }
  }
  if (Number.isFinite(recentMergeMs)) {
    // pick the matching PR for signal
    const p = pulls.find((x) => x.merged && x.mergedAt && ageMs(x.mergedAt, now) === recentMergeMs)!;
    const stillOpen = recentMergeMs >= t.shippingHours * HOUR;
    signals.push(`PR #${p.number} merged ${fmtAge(recentMergeMs)}${stillOpen ? " · issue still open" : ""}`);
    // Higher score for fresher merge: invert (in minutes).
    const minSinceMerge = Math.max(1, Math.round(recentMergeMs / 60000));
    return { state: "shipping", score: 100000 / minSinceMerge, signals };
  }
  for (const p of pulls) {
    if (p.state !== "open" || p.isDraft) continue;
    if (p.ciStatus !== "SUCCESS") continue;
    let lastApprovedAt: number | null = null;
    let lastChangesRequestedAt: number | null = null;
    for (const r of p.reviews) {
      const t2 = Date.parse(r.submittedAt);
      if (!Number.isFinite(t2)) continue;
      if (r.state === "APPROVED") lastApprovedAt = Math.max(lastApprovedAt ?? 0, t2);
      if (r.state === "CHANGES_REQUESTED") lastChangesRequestedAt = Math.max(lastChangesRequestedAt ?? 0, t2);
    }
    if (lastApprovedAt && (!lastChangesRequestedAt || lastApprovedAt > lastChangesRequestedAt)) {
      signals.push(`PR #${p.number} approved, CI green, ready to merge`);
      return { state: "shipping", score: 50000, signals };
    }
  }

  // in-review — any review submitted within window on an open PR.
  let inReviewSignal = "";
  let inReviewLatestMs = Number.POSITIVE_INFINITY;
  for (const p of pulls) {
    if (p.state !== "open") continue;
    for (const r of p.reviews) {
      const age = ageMs(r.submittedAt, now);
      if (age < t.reviewActivityDays * DAY && age < inReviewLatestMs) {
        inReviewLatestMs = age;
        inReviewSignal = `${r.state.toLowerCase().replace("_", " ")} on PR #${p.number}${r.author ? ` by @${r.author}` : ""} ${fmtAge(age)}`;
      }
    }
  }
  if (Number.isFinite(inReviewLatestMs)) {
    signals.push(inReviewSignal);
    const density = eventDensity(events, now, 7) + 1;
    const recencyDays = Math.max(1, inReviewLatestMs / DAY);
    return { state: "in-review", score: (1 / recencyDays) * density * 100, signals };
  }

  // in-code — open PR (not draft) with recent commit.
  let codeSignal = "";
  let codeLatestMs = Number.POSITIVE_INFINITY;
  let codePr: number | null = null;
  for (const p of pulls) {
    if (p.state !== "open" || p.isDraft) continue;
    const age = ageMs(p.lastCommitAt, now);
    if (age < t.codeActivityDays * DAY && age < codeLatestMs) {
      codeLatestMs = age;
      codePr = p.number;
      codeSignal = `commit on PR #${p.number} ${fmtAge(age)}`;
    }
  }
  if (codePr !== null) {
    signals.push(codeSignal);
    const density = eventDensity(events, now, 7) + 1;
    const recencyDays = Math.max(1, codeLatestMs / DAY);
    return { state: "in-code", score: (1 / recencyDays) * density * 100, signals };
  }

  // discussing — no open PR but recent comment activity.
  const openPrs = pulls.filter((p) => p.state === "open");
  if (openPrs.length === 0 && issue.lastCommentAt) {
    const age = ageMs(issue.lastCommentAt, now);
    if (age < t.discussionDays * DAY) {
      signals.push(`comment ${fmtAge(age)} · ${issue.commentCount} total`);
      return {
        state: "discussing",
        score: commentDensity(issue.lastCommentAt, issue.commentCount, now, 7) * 100,
        signals,
      };
    }
  }

  // stalled — historical activity but nothing recent.
  const lastActivity = Math.min(
    ageMs(issue.updatedAt, now),
    ageMs(issue.lastCommentAt, now),
    ...pulls.map((p) => ageMs(p.lastCommitAt, now)),
    ...events.map((e) => ageMs(e.createdAt, now)),
  );
  const hasHistory = issue.commentCount + events.length > 0 || pulls.length > 0;
  if (hasHistory && lastActivity > t.stallDays * DAY && Number.isFinite(lastActivity)) {
    const days = Math.round(lastActivity / DAY);
    signals.push(`no activity in ${days}d`);
    return { state: "stalled", score: days, signals };
  }

  // cold — long-open with effectively no engagement.
  const ageDays = ageMs(issue.createdAt, now) / DAY;
  if (ageDays > t.coldDays && issue.commentCount <= 1 && pulls.length === 0 && events.length === 0) {
    signals.push(`open ${Math.round(ageDays)}d, no engagement`);
    return { state: "cold", score: Math.round(ageDays), signals };
  }

  // fresh — newly created.
  if (Number.isFinite(ageDays) && ageDays < t.freshDays) {
    signals.push(`created ${fmtAge(ageMs(issue.createdAt, now))}`);
    return { state: "fresh", score: -ageDays, signals };
  }

  // Default fall-through: treat as stalled with the available age.
  const days = Number.isFinite(lastActivity) ? Math.round(lastActivity / DAY) : Math.round(ageDays);
  signals.push(`no recent signals · last touched ${days}d ago`);
  return { state: "stalled", score: days, signals };
}
