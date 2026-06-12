import { db } from "./db.js";
import { masterFilterSql, type MasterFilter } from "./masterFilter.js";
import { computeFlowState, type FlowInput, type FlowThresholdsResolved } from "./flow.js";
import { SHIP_PROB } from "./health.js";
import type { RiskItem } from "../../shared/types.js";

export interface PredictiveThresholds {
  prStaleDays: number; // default 3
  prMinAgeForStale: number; // default 7
  reviewWaitDays: number; // default 2
  promiseConfidenceMin: number; // 0..1
  replyOverdueHours: number; // default 24
}

export const PREDICTIVE_DEFAULTS: PredictiveThresholds = {
  prStaleDays: 3,
  prMinAgeForStale: 7,
  reviewWaitDays: 2,
  promiseConfidenceMin: 0.6,
  replyOverdueHours: 24,
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function daysSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY));
}

function hoursSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / HOUR));
}

function currentMonthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}
function currentWeekKey(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// Build set of issue numbers permitted by the master filter (open OR closed).
// Use the SQL helper where possible.
function filterIssueNumbers(mf: MasterFilter, state?: "open" | "closed"): Set<number> {
  const sql = masterFilterSql(mf);
  const where: string[] = [];
  const params: unknown[] = [];
  if (state) {
    where.push("i.state = ?");
    params.push(state);
  }
  if (sql) {
    where.push(sql.sql);
    params.push(...sql.params);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = db()
    .prepare(`SELECT i.number FROM issues i${whereSql}`)
    .all(...params) as { number: number }[];
  return new Set(rows.map((r) => r.number));
}

function parseLinkedIssues(raw: string): number[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is number => typeof x === "number");
  } catch {
    /* skip */
  }
  return [];
}

interface IssueLite {
  number: number;
  title: string;
}

function issueTitlesFor(numbers: number[]): Map<number, string> {
  if (numbers.length === 0) return new Map();
  const placeholders = numbers.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT number, title FROM issues WHERE number IN (${placeholders})`)
    .all(...numbers) as IssueLite[];
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.number, r.title);
  return m;
}

// ─── pr-decelerating ───────────────────────────────────────────────────────
export function detectPrDecelerating(mf: MasterFilter, t: PredictiveThresholds): RiskItem[] {
  const now = Date.now();
  const allowed = filterIssueNumbers(mf);
  const rows = db()
    .prepare(
      `SELECT number, created_at, last_commit_at, linked_issues
       FROM pulls
       WHERE state = 'open' AND is_draft = 0`,
    )
    .all() as {
    number: number;
    created_at: string | null;
    last_commit_at: string | null;
    linked_issues: string;
  }[];

  const items: RiskItem[] = [];
  const issuesToLookup = new Set<number>();
  const matches: { pr: number; days: number; linked: number[] }[] = [];
  for (const r of rows) {
    if (!r.created_at || !r.last_commit_at) continue;
    if (daysSince(r.created_at, now) <= t.prMinAgeForStale) continue;
    const days = daysSince(r.last_commit_at, now);
    if (days <= t.prStaleDays) continue;
    const linked = parseLinkedIssues(r.linked_issues).filter((n) => allowed.has(n));
    if (linked.length === 0) continue;
    matches.push({ pr: r.number, days, linked });
    for (const n of linked) issuesToLookup.add(n);
  }
  const titles = issueTitlesFor([...issuesToLookup]);
  for (const m of matches) {
    for (const issueNum of m.linked) {
      const title = titles.get(issueNum);
      if (!title) continue;
      items.push({
        issueNumber: issueNum,
        title,
        reason: `PR #${m.pr}: no commits in ${m.days}d`,
        severity: 1,
        kind: "preventative",
        category: "pr-decelerating",
      });
    }
  }
  return items;
}

// ─── review-stuck ──────────────────────────────────────────────────────────
export function detectReviewStuck(mf: MasterFilter, t: PredictiveThresholds): RiskItem[] {
  const now = Date.now();
  const allowed = filterIssueNumbers(mf);
  const rows = db()
    .prepare(
      `SELECT p.number, p.created_at, p.linked_issues,
              (SELECT COUNT(*) FROM pull_reviews r WHERE r.pull_number = p.number) AS review_count
       FROM pulls p
       WHERE p.state = 'open' AND p.is_draft = 0`,
    )
    .all() as {
    number: number;
    created_at: string | null;
    linked_issues: string;
    review_count: number;
  }[];

  const matches: { pr: number; days: number; linked: number[] }[] = [];
  const issuesToLookup = new Set<number>();
  for (const r of rows) {
    if (!r.created_at) continue;
    if (r.review_count > 0) continue;
    const days = daysSince(r.created_at, now);
    if (days <= t.reviewWaitDays) continue;
    const linked = parseLinkedIssues(r.linked_issues).filter((n) => allowed.has(n));
    if (linked.length === 0) continue;
    matches.push({ pr: r.number, days, linked });
    for (const n of linked) issuesToLookup.add(n);
  }
  const titles = issueTitlesFor([...issuesToLookup]);
  const items: RiskItem[] = [];
  for (const m of matches) {
    for (const issueNum of m.linked) {
      const title = titles.get(issueNum);
      if (!title) continue;
      items.push({
        issueNumber: issueNum,
        title,
        reason: `PR #${m.pr} awaiting first review (open ${m.days}d)`,
        severity: 1,
        kind: "preventative",
        category: "review-stuck",
      });
    }
  }
  return items;
}

// ─── promise-at-risk ───────────────────────────────────────────────────────
interface ThresholdRow {
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
}
function loadFlowThresholds(workspaceId: number): FlowThresholdsResolved {
  const t = db()
    .prepare(
      "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days FROM workspace_config WHERE id = ?",
    )
    .get(workspaceId) as ThresholdRow | undefined;
  return {
    shippingHours: t?.flow_shipping_hours ?? 24,
    reviewActivityDays: t?.flow_review_days ?? 3,
    codeActivityDays: t?.flow_code_days ?? 3,
    discussionDays: t?.flow_discussion_days ?? 5,
    stallDays: t?.flow_stall_days ?? 14,
    coldDays: t?.flow_cold_days ?? 60,
    freshDays: t?.flow_fresh_days ?? 7,
  };
}

export function detectPromiseAtRisk(
  workspaceId: number,
  mf: MasterFilter,
  t: PredictiveThresholds,
  reactiveStalledNumbers: Set<number>,
): RiskItem[] {
  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? sql.params : [];
  const monthKey = currentMonthKey();
  const weekKey = currentWeekKey();
  const issues = db()
    .prepare(
      `SELECT i.number, i.title, i.state, i.assignee, i.created_at, i.updated_at,
              m.planned_month, m.planned_week
       FROM issues i
       LEFT JOIN roadmap_meta m ON m.issue_number = i.number AND m.workspace_id = ?
       WHERE i.state = 'open'
         AND (m.planned_month = ? OR m.planned_week = ?)${scope}`,
    )
    .all(workspaceId, monthKey, weekKey, ...params) as {
    number: number;
    title: string;
    state: "open" | "closed";
    assignee: string | null;
    created_at: string | null;
    updated_at: string;
    planned_month: string | null;
    planned_week: string | null;
  }[];

  if (issues.length === 0) return [];

  // Preload joins for flow state.
  const nums = issues.map((i) => i.number);
  const placeholders = nums.map(() => "?").join(",");
  const pulls = db()
    .prepare(`SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls`)
    .all() as {
    number: number;
    state: "open" | "closed";
    merged: number;
    merged_at: string | null;
    is_draft: number;
    last_commit_at: string | null;
    linked_issues: string;
  }[];
  const reviews = db()
    .prepare(`SELECT pull_number, state, submitted_at, author FROM pull_reviews`)
    .all() as { pull_number: number; state: string; submitted_at: string; author: string | null }[];
  const checks = db()
    .prepare(`SELECT pull_number, status FROM pull_checks`)
    .all() as { pull_number: number; status: string | null }[];
  const commentAgg =
    nums.length > 0
      ? (db()
          .prepare(
            `SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments WHERE issue_number IN (${placeholders}) GROUP BY issue_number`,
          )
          .all(...nums) as { issue_number: number; cnt: number; last_at: string | null }[])
      : [];
  const events =
    nums.length > 0
      ? (db()
          .prepare(
            `SELECT issue_number, event_type, created_at FROM issue_events WHERE issue_number IN (${placeholders})`,
          )
          .all(...nums) as { issue_number: number; event_type: string; created_at: string }[])
      : [];

  const reviewsByPull = new Map<number, { state: string; submittedAt: string; author: string | null }[]>();
  for (const r of reviews) {
    const arr = reviewsByPull.get(r.pull_number);
    const v = { state: r.state, submittedAt: r.submitted_at, author: r.author };
    if (arr) arr.push(v);
    else reviewsByPull.set(r.pull_number, [v]);
  }
  const checksByPull = new Map<number, string | null>();
  for (const c of checks) checksByPull.set(c.pull_number, c.status);
  const pullsByIssue = new Map<number, typeof pulls>();
  for (const p of pulls) {
    const linked = parseLinkedIssues(p.linked_issues);
    for (const n of linked) {
      const arr = pullsByIssue.get(n);
      if (arr) arr.push(p);
      else pullsByIssue.set(n, [p]);
    }
  }
  const commentsByIssue = new Map<number, { cnt: number; last_at: string | null }>();
  for (const c of commentAgg) commentsByIssue.set(c.issue_number, { cnt: c.cnt, last_at: c.last_at });
  const eventsByIssue = new Map<number, { type: string; createdAt: string }[]>();
  for (const e of events) {
    const arr = eventsByIssue.get(e.issue_number);
    const v = { type: e.event_type, createdAt: e.created_at };
    if (arr) arr.push(v);
    else eventsByIssue.set(e.issue_number, [v]);
  }

  const thresholds = loadFlowThresholds(workspaceId);
  const items: RiskItem[] = [];
  for (const i of issues) {
    if (reactiveStalledNumbers.has(i.number)) continue;
    const linkedPulls = pullsByIssue.get(i.number) ?? [];
    const comment = commentsByIssue.get(i.number);
    const evs = eventsByIssue.get(i.number) ?? [];
    const input: FlowInput = {
      issue: {
        number: i.number,
        state: i.state,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        assignee: i.assignee,
        commentCount: comment?.cnt ?? 0,
        lastCommentAt: comment?.last_at ?? null,
      },
      pulls: linkedPulls.map((p) => ({
        number: p.number,
        state: p.state,
        merged: !!p.merged,
        mergedAt: p.merged_at,
        isDraft: !!p.is_draft,
        lastCommitAt: p.last_commit_at,
        ciStatus: checksByPull.get(p.number) ?? null,
        reviews: reviewsByPull.get(p.number) ?? [],
      })),
      events: evs,
      thresholds,
    };
    const flow = computeFlowState(input);
    const prob = SHIP_PROB[flow.state];
    const isWeakFlow = flow.state === "stalled" || flow.state === "cold" || flow.state === "fresh";
    const isLowConfInFlight =
      (flow.state === "in-code" || flow.state === "in-review" || flow.state === "discussing") &&
      prob < t.promiseConfidenceMin;
    if (!isWeakFlow && !isLowConfInFlight) continue;
    items.push({
      issueNumber: i.number,
      title: i.title,
      reason: `low confidence for current period commit (flow: ${flow.state})`,
      severity: 2,
      kind: "preventative",
      category: "promise-at-risk",
    });
  }
  return items;
}

// ─── owed-reply ────────────────────────────────────────────────────────────
export function detectOwedReply(
  mf: MasterFilter,
  t: PredictiveThresholds,
  currentUser: string | null,
): RiskItem[] {
  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? sql.params : [];
  const rows = db()
    .prepare(
      `SELECT i.number, i.title, i.assignee,
              (SELECT c.author FROM comments c WHERE c.issue_number = i.number ORDER BY c.created_at DESC LIMIT 1) AS last_author,
              (SELECT c.created_at FROM comments c WHERE c.issue_number = i.number ORDER BY c.created_at DESC LIMIT 1) AS last_at
       FROM issues i
       WHERE i.state = 'open'${scope}`,
    )
    .all(...params) as {
    number: number;
    title: string;
    assignee: string | null;
    last_author: string | null;
    last_at: string | null;
  }[];

  const now = Date.now();
  const items: RiskItem[] = [];
  for (const r of rows) {
    if (!r.last_at || !r.last_author) continue;
    if (r.assignee && r.last_author === r.assignee) continue;
    if (currentUser && r.last_author === currentUser) continue;
    const hours = hoursSince(r.last_at, now);
    if (hours <= t.replyOverdueHours) continue;
    items.push({
      issueNumber: r.number,
      title: r.title,
      reason: `${r.last_author} commented ${hours}h ago, no reply`,
      severity: 1,
      kind: "preventative",
      category: "owed-reply",
    });
  }
  return items;
}

// ─── premature-close ───────────────────────────────────────────────────────
export function detectPrematureClose(mf: MasterFilter, _t: PredictiveThresholds): RiskItem[] {
  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? sql.params : [];
  const issues = db()
    .prepare(
      `SELECT i.number, i.title, i.closed_at
       FROM issues i
       WHERE i.state = 'closed' AND i.closed_at IS NOT NULL${scope}`,
    )
    .all(...params) as { number: number; title: string; closed_at: string | null }[];
  if (issues.length === 0) return [];

  const closedSet = new Map(issues.map((i) => [i.number, i] as const));
  const pulls = db()
    .prepare(
      `SELECT number, merged, created_at, linked_issues FROM pulls`,
    )
    .all() as {
    number: number;
    merged: number;
    created_at: string | null;
    linked_issues: string;
  }[];

  // For each closed issue, find earliest unmerged PR created before close.
  const found = new Map<number, { pr: number }>();
  for (const p of pulls) {
    if (p.merged) continue;
    if (!p.created_at) continue;
    const linked = parseLinkedIssues(p.linked_issues);
    for (const n of linked) {
      const issue = closedSet.get(n);
      if (!issue || !issue.closed_at) continue;
      if (Date.parse(p.created_at) >= Date.parse(issue.closed_at)) continue;
      if (!found.has(n)) found.set(n, { pr: p.number });
    }
  }

  const items: RiskItem[] = [];
  for (const [n, { pr }] of found) {
    const issue = closedSet.get(n);
    if (!issue) continue;
    items.push({
      issueNumber: n,
      title: issue.title,
      reason: `closed but PR #${pr} not merged`,
      severity: 2,
      kind: "preventative",
      category: "premature-close",
    });
  }
  return items;
}

export function detectAllPredictive(
  workspaceId: number,
  mf: MasterFilter,
  t: PredictiveThresholds,
  ctx: { reactiveStalledNumbers: Set<number>; currentUser: string | null },
): RiskItem[] {
  return [
    ...detectPrDecelerating(mf, t),
    ...detectReviewStuck(mf, t),
    ...detectPromiseAtRisk(workspaceId, mf, t, ctx.reactiveStalledNumbers),
    ...detectOwedReply(mf, t, ctx.currentUser),
    ...detectPrematureClose(mf, t),
  ];
}
