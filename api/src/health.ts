import { db, getKv } from "./db.js";
import { getMasterFilter, masterFilterSql, type MasterFilter } from "./masterFilter.js";
import { computeFlowState, type FlowInput, type FlowThresholdsResolved } from "./flow.js";
import { detectAllPredictive, type PredictiveThresholds } from "./predictive.js";
import { loadIssueNumbersWithInsights } from "./insights.js";
import {
  currentPeriodOrdinal,
  issuePeriodOrdinal,
  periodColumns,
  periodsUntilDue,
} from "./period.js";
import { effortFromLabels } from "../../shared/types.js";
import type {
  EffortRating,
  FlowState,
  RangeGranularity,
  RiskItem,
  ScheduleHealth,
  ScheduleStatus,
} from "../../shared/types.js";

const VALID_EFFORT = new Set<string>(["lightning", "incremental", "foundation"]);

// Relative weight of a risk item by size, for the schedule-status verdict.
// Unknown effort defaults to incremental (1) — neutral, not free.
const EFFORT_WEIGHT: Record<EffortRating, number> = { lightning: 0.5, incremental: 1, foundation: 3 };
function effortWeight(e: EffortRating | null): number {
  return e ? EFFORT_WEIGHT[e] : 1;
}

// AI-estimated effort per issue (from the cached summary). Live only — historical
// snapshots have no per-day summary history.
function loadEstimateEffort(nums: number[]): Map<number, EffortRating> {
  const out = new Map<number, EffortRating>();
  if (nums.length === 0) return out;
  const ph = nums.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT issue_number, effort FROM ai_summaries WHERE issue_number IN (${ph})`)
    .all(...nums) as Array<{ issue_number: number; effort: string | null }>;
  for (const r of rows) {
    if (r.effort && VALID_EFFORT.has(r.effort)) out.set(r.issue_number, r.effort as EffortRating);
  }
  return out;
}

// States that count as "moving toward ship" when an item is due now.
const MOVING_STATES = new Set<FlowState>(["shipping", "in-review", "in-code"]);

function loadGranularity(): RangeGranularity {
  const r = db()
    .prepare("SELECT range_granularity FROM workspace_config WHERE id = 1")
    .get() as { range_granularity?: string } | undefined;
  const v = r?.range_granularity;
  return v === "week" || v === "quarter" ? v : "month";
}

function loadRangeConfig(): { granularity: RangeGranularity; count: number; offset: number } {
  const r = db()
    .prepare("SELECT range_granularity, range_count, range_offset FROM workspace_config WHERE id = 1")
    .get() as { range_granularity?: string; range_count?: number; range_offset?: number } | undefined;
  const g = r?.range_granularity;
  return {
    granularity: g === "week" || g === "quarter" ? g : "month",
    count: r?.range_count ?? 3,
    offset: r?.range_offset ?? 0,
  };
}

// Probability that an issue in this flow state actually ships. These are
// calibrated guesses, not fitted — adjust over time with real outcome data.
export const SHIP_PROB: Record<FlowState, number> = {
  closed: 1.0,
  shipping: 0.95,
  "in-review": 0.9,
  "in-code": 0.75,
  discussing: 0.5,
  fresh: 0.5,
  stalled: 0.2,
  cold: 0.1,
};

interface IssueRow {
  number: number;
  title: string;
  state: "open" | "closed";
  assignee: string | null;
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  planned_month: string | null;
  planned_week: string | null;
  is_todo: number | null;
  app_updated_at: string | null;
  labels: string;
}

interface PullRow {
  number: number;
  state: "open" | "closed";
  merged: number;
  merged_at: string | null;
  is_draft: number;
  last_commit_at: string | null;
  linked_issues: string;
}

interface ReviewRow {
  pull_number: number;
  state: string;
  submitted_at: string;
  author: string | null;
}

interface CheckRow {
  pull_number: number;
  status: string | null;
}

interface CommentAgg {
  issue_number: number;
  cnt: number;
  last_at: string | null;
}

interface EventRow {
  issue_number: number;
  event_type: string;
  created_at: string;
}

interface ThresholdRow {
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
  todo_stale_days: number;
}

function loadThresholds(): { flow: FlowThresholdsResolved; todoStaleDays: number } {
  const t = db()
    .prepare(
      "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days, todo_stale_days FROM workspace_config WHERE id = 1",
    )
    .get() as ThresholdRow | undefined;
  return {
    flow: {
      shippingHours: t?.flow_shipping_hours ?? 24,
      reviewActivityDays: t?.flow_review_days ?? 3,
      codeActivityDays: t?.flow_code_days ?? 3,
      discussionDays: t?.flow_discussion_days ?? 5,
      stallDays: t?.flow_stall_days ?? 14,
      coldDays: t?.flow_cold_days ?? 60,
      freshDays: t?.flow_fresh_days ?? 7,
    },
    todoStaleDays: t?.todo_stale_days ?? 14,
  };
}

function loadIssues(mf: MasterFilter, asOf?: string): IssueRow[] {
  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? [...sql.params] : [];
  // Live: only currently-open issues. Historic: any issue that was open at asOf —
  // created_at <= asOf AND (closed_at IS NULL OR closed_at > asOf).
  let openWhere = "i.state = 'open'";
  if (asOf) {
    openWhere =
      "(i.created_at IS NULL OR i.created_at <= ?) AND (i.closed_at IS NULL OR i.closed_at > ?)";
    params.unshift(asOf, asOf);
  }
  return db()
    .prepare(
      `SELECT i.number, i.title, i.state, i.assignee, i.created_at, i.updated_at, i.closed_at,
              i.labels, m.planned_month, m.planned_week, m.is_todo, m.app_updated_at
       FROM issues i
       LEFT JOIN roadmap_meta m ON m.issue_number = i.number
       WHERE ${openWhere}${scope}`,
    )
    .all(...params) as IssueRow[];
}

// Build the join maps once, reuse across confidence and risk passes.
interface JoinedData {
  pullsByIssue: Map<number, PullRow[]>;
  reviewsByPull: Map<number, ReviewRow[]>;
  checksByPull: Map<number, CheckRow>;
  commentsByIssue: Map<number, CommentAgg>;
  eventsByIssue: Map<number, EventRow[]>;
}

function loadJoins(asOf?: string): JoinedData {
  // Live (no asOf): load everything.
  // Historic: pulls created on or before asOf; reviews submitted on or before asOf;
  // comments and events created on or before asOf. Checks: skipped historically
  // because we only store the current rollup (no per-day history).
  const pullsSql = asOf
    ? `SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls WHERE created_at IS NULL OR created_at <= ?`
    : `SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls`;
  const pulls = (
    asOf
      ? db().prepare(pullsSql).all(asOf)
      : db().prepare(pullsSql).all()
  ) as PullRow[];
  const reviews = (
    asOf
      ? db()
          .prepare(
            `SELECT pull_number, state, submitted_at, author FROM pull_reviews WHERE submitted_at <= ?`,
          )
          .all(asOf)
      : db()
          .prepare(`SELECT pull_number, state, submitted_at, author FROM pull_reviews`)
          .all()
  ) as ReviewRow[];
  // approximate: pull_checks holds only current rollup, no historic series.
  // For historic snapshots we drop check rollups entirely.
  const checks: CheckRow[] = asOf
    ? []
    : (db().prepare(`SELECT pull_number, status FROM pull_checks`).all() as CheckRow[]);
  const commentAgg = (
    asOf
      ? db()
          .prepare(
            `SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments WHERE created_at <= ? GROUP BY issue_number`,
          )
          .all(asOf)
      : db()
          .prepare(
            `SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments GROUP BY issue_number`,
          )
          .all()
  ) as CommentAgg[];
  const events = (
    asOf
      ? db()
          .prepare(
            `SELECT issue_number, event_type, created_at FROM issue_events WHERE created_at <= ?`,
          )
          .all(asOf)
      : db()
          .prepare(`SELECT issue_number, event_type, created_at FROM issue_events`)
          .all()
  ) as EventRow[];

  // approximate: for historic snapshots, a merged PR with merged_at > asOf must
  // be treated as still open. We rewrite the row in-place before building maps.
  if (asOf) {
    for (const p of pulls) {
      if (p.merged_at && p.merged_at > asOf) {
        p.merged = 0;
        p.merged_at = null;
        p.state = "open";
      }
      // approximate: last_commit_at is the most recent commit timestamp; if it
      // post-dates asOf we can't recover the prior one, so we clamp by hiding it.
      if (p.last_commit_at && p.last_commit_at > asOf) {
        p.last_commit_at = null;
      }
    }
  }

  const checksByPull = new Map<number, CheckRow>();
  for (const c of checks) checksByPull.set(c.pull_number, c);
  const reviewsByPull = new Map<number, ReviewRow[]>();
  for (const r of reviews) {
    const arr = reviewsByPull.get(r.pull_number);
    if (arr) arr.push(r);
    else reviewsByPull.set(r.pull_number, [r]);
  }
  const pullsByIssue = new Map<number, PullRow[]>();
  for (const p of pulls) {
    let linked: number[] = [];
    try {
      const parsed = JSON.parse(p.linked_issues) as unknown;
      if (Array.isArray(parsed)) linked = parsed.filter((x): x is number => typeof x === "number");
    } catch {
      /* skip */
    }
    for (const n of linked) {
      const arr = pullsByIssue.get(n);
      if (arr) arr.push(p);
      else pullsByIssue.set(n, [p]);
    }
  }
  const commentsByIssue = new Map<number, CommentAgg>();
  for (const c of commentAgg) commentsByIssue.set(c.issue_number, c);
  const eventsByIssue = new Map<number, EventRow[]>();
  for (const e of events) {
    const arr = eventsByIssue.get(e.issue_number);
    if (arr) arr.push(e);
    else eventsByIssue.set(e.issue_number, [e]);
  }
  return { pullsByIssue, reviewsByPull, checksByPull, commentsByIssue, eventsByIssue };
}

function flowFor(
  issue: IssueRow,
  joins: JoinedData,
  thresholds: FlowThresholdsResolved,
  nowMs?: number,
): FlowState {
  const linkedPulls = joins.pullsByIssue.get(issue.number) ?? [];
  const comment = joins.commentsByIssue.get(issue.number);
  const evs = joins.eventsByIssue.get(issue.number) ?? [];
  const input: FlowInput = {
    nowMs,
    issue: {
      number: issue.number,
      state: issue.state,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      assignee: issue.assignee,
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
      ciStatus: joins.checksByPull.get(p.number)?.status ?? null,
      reviews: (joins.reviewsByPull.get(p.number) ?? []).map((r) => ({
        state: r.state,
        submittedAt: r.submitted_at,
        author: r.author,
      })),
    })),
    events: evs.map((e) => ({ type: e.event_type, createdAt: e.created_at })),
    thresholds,
  };
  return computeFlowState(input).state;
}

// Current period helpers — match conventions in routes/attention.ts.
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

function shortMonthLabel(yyyyMm: string): string {
  // "2026-05" → "May"
  const [yStr, mStr] = yyyyMm.split("-");
  const m = Number(mStr);
  if (!Number.isFinite(m) || m < 1 || m > 12) return yyyyMm;
  return new Date(Date.UTC(Number(yStr), m - 1, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

function daysSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
}

// An issue is "judgeable" for momentum only if we can actually observe whether
// it's moving — a linked PR, a timeline event, or a comment. With no signal at
// all, flow falls through to stalled/cold purely on age, which would drag
// momentum down on absence of data rather than evidence of trouble. We exclude
// those and report the count separately so the number stays honest.
function hasFlowSignal(num: number, joins: JoinedData): boolean {
  if ((joins.pullsByIssue.get(num)?.length ?? 0) > 0) return true;
  if ((joins.eventsByIssue.get(num)?.length ?? 0) > 0) return true;
  if ((joins.commentsByIssue.get(num)?.cnt ?? 0) > 0) return true;
  return false;
}

export function computeConfidence(
  mf: MasterFilter = getMasterFilter(),
  asOf?: string,
): {
  confidence: number | null;
  sampleSize: number;
  noSignal: number;
} {
  const { flow } = loadThresholds();
  const issues = loadIssues(mf, asOf);
  const planned = issues.filter((i) => i.planned_month !== null || i.planned_week !== null);
  if (planned.length === 0) return { confidence: null, sampleSize: 0, noSignal: 0 };
  const joins = loadJoins(asOf);
  const judged = planned.filter((i) => hasFlowSignal(i.number, joins));
  const noSignal = planned.length - judged.length;
  if (judged.length === 0) return { confidence: null, sampleSize: 0, noSignal };
  const nowMs = asOf ? Date.parse(asOf) : undefined;
  let sum = 0;
  for (const i of judged) {
    const state = flowFor(i, joins, flow, nowMs);
    sum += SHIP_PROB[state];
  }
  const mean = sum / judged.length;
  return { confidence: Math.round(mean * 100), sampleSize: judged.length, noSignal };
}

// The verdict is effort-weighted: it reflects the SIZE of what's at risk, not a
// raw count. `riskWeight` sums overdue items (weight ×2 — a blown date is worse)
// and due-now-not-moving items (×1), each scaled by effort. So one stalled
// `lightning` (0.5) can't flip a 95%-on-time roadmap to "at risk", but a slipping
// `foundation` (overdue 6, or due-now 3) does. The on-time % stays an auditable
// headcount; only this judgment label is effort-aware.
function scheduleStatusOf(
  committed: number,
  overdueCount: number,
  foundationOverdue: number,
  riskWeight: number,
  onTime: number,
): ScheduleStatus {
  if (committed === 0) return "no-plan";
  if (foundationOverdue >= 1 || overdueCount / committed >= 0.34 || riskWeight >= 6) return "off-track";
  if (riskWeight >= 2) return "at-risk";
  if (riskWeight > 0 || onTime < 90) return "watch";
  return "on-track";
}

// Schedule (timeline) health — how well committed work is tracking to its
// planned dates. Distinct from the flow-only momentum "confidence":
//   overdue           → miss (date already blown)
//   due this period   → on-schedule only if actively moving (shipping/review/code)
//   future            → on-schedule (has runway) unless cold (effectively dead)
export function computeScheduleHealth(
  mf: MasterFilter = getMasterFilter(),
  asOf?: string,
): ScheduleHealth {
  const { flow } = loadThresholds();
  const g = loadGranularity();
  const issues = loadIssues(mf, asOf).filter(
    (i) => i.planned_month !== null || i.planned_week !== null,
  );
  const committed = issues.length;
  if (committed === 0) {
    return { onTime: null, status: "no-plan", committed: 0, overdue: 0, dueSoonAtRisk: 0 };
  }
  const joins = loadJoins(asOf);
  const nowMs = asOf ? Date.parse(asOf) : undefined;
  const now = asOf ? new Date(asOf) : new Date();

  // Effort per committed issue: label wins, AI estimate fills (live only).
  const labelEffortByNum = new Map<number, EffortRating>();
  for (const i of issues) {
    try {
      const parsed = JSON.parse(i.labels) as unknown;
      if (Array.isArray(parsed)) {
        const e = effortFromLabels(parsed.filter((x): x is string => typeof x === "string"));
        if (e) labelEffortByNum.set(i.number, e);
      }
    } catch {
      /* skip */
    }
  }
  const estEffortByNum = asOf
    ? new Map<number, EffortRating>()
    : loadEstimateEffort(issues.map((i) => i.number));
  const effortOf = (num: number): EffortRating | null =>
    labelEffortByNum.get(num) ?? estEffortByNum.get(num) ?? null;

  let onSchedule = 0;
  let overdue = 0;
  let dueSoonAtRisk = 0;
  let foundationOverdue = 0;
  let riskWeight = 0;
  for (const i of issues) {
    const d = periodsUntilDue(g, i.planned_month, i.planned_week, now);
    const state = flowFor(i, joins, flow, nowMs);
    if (d === null) {
      onSchedule++; // has a plan we couldn't place — assume fine
      continue;
    }
    const w = effortWeight(effortOf(i.number));
    if (d < 0) {
      overdue++; // date already passed
      riskWeight += w * 2; // a blown date weighs more than a due-now stall
      if (effortOf(i.number) === "foundation") foundationOverdue++;
      continue;
    }
    if (d === 0) {
      if (MOVING_STATES.has(state)) {
        onSchedule++;
      } else {
        dueSoonAtRisk++; // due now, not moving
        riskWeight += w;
      }
      continue;
    }
    // future — runway exists; only cold work is a schedule drag
    if (state !== "cold") onSchedule++;
  }
  const onTime = Math.round((onSchedule / committed) * 100);
  return {
    onTime,
    status: scheduleStatusOf(committed, overdue, foundationOverdue, riskWeight, onTime),
    committed,
    overdue,
    dueSoonAtRisk,
  };
}

export interface RoadmapPeriodRollup {
  key: string;
  label: string;
  isCurrent: boolean;
  planned: number; // committed to this period (open + closed)
  done: number; // closed
  atRisk: number; // open & currently at-risk
}

export interface RoadmapTimeline {
  granularity: RangeGranularity;
  periods: RoadmapPeriodRollup[];
  overdueOpen: number; // open committed issues whose planned period is already past
}

interface PlannedIssueRow {
  number: number;
  state: "open" | "closed";
  planned_month: string | null;
  planned_week: string | null;
}

// Per-period roadmap rollup over the active range — feeds the AI progress read.
export function computeRoadmapTimeline(mf: MasterFilter = getMasterFilter()): RoadmapTimeline {
  const { granularity, count, offset } = loadRangeConfig();
  const cols = periodColumns(granularity, count, offset);
  const ordToCol = new Map<number, RoadmapPeriodRollup>();
  const periods: RoadmapPeriodRollup[] = cols.map((c) => {
    const r: RoadmapPeriodRollup = {
      key: c.key,
      label: c.label,
      isCurrent: c.isCurrent,
      planned: 0,
      done: 0,
      atRisk: 0,
    };
    ordToCol.set(c.ordinal, r);
    return r;
  });

  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? sql.params : [];
  const rows = db()
    .prepare(
      `SELECT i.number, i.state, m.planned_month, m.planned_week
       FROM issues i LEFT JOIN roadmap_meta m ON m.issue_number = i.number
       WHERE (m.planned_month IS NOT NULL OR m.planned_week IS NOT NULL)${scope}`,
    )
    .all(...params) as PlannedIssueRow[];

  const atRiskSet = new Set(computeAtRisk(mf).map((r) => r.issueNumber));
  const curOrd = currentPeriodOrdinal(granularity);

  for (const r of rows) {
    const ord = issuePeriodOrdinal(granularity, r.planned_month, r.planned_week);
    if (ord === null) continue;
    const col = ordToCol.get(ord);
    if (col) {
      col.planned++;
      if (r.state === "closed") col.done++;
      else if (atRiskSet.has(r.number)) col.atRisk++;
    }
  }

  const overdueOpen = rows.filter((r) => {
    if (r.state !== "open") return false;
    const ord = issuePeriodOrdinal(granularity, r.planned_month, r.planned_week);
    return ord !== null && ord < curOrd;
  }).length;

  return { granularity, periods, overdueOpen };
}

export function computeAtRisk(
  mf: MasterFilter = getMasterFilter(),
  asOf?: string,
): RiskItem[] {
  const { flow, todoStaleDays } = loadThresholds();
  const issues = loadIssues(mf, asOf);
  const joins = loadJoins(asOf);
  const nowMs = asOf ? Date.parse(asOf) : Date.now();
  const now = nowMs;
  const asOfDate = asOf ? new Date(asOf) : new Date();
  const monthKey = currentMonthKey(asOfDate);
  const weekKey = currentWeekKey(asOfDate);
  const granularity = loadGranularity();
  const periodNoun = granularity === "week" ? "week" : granularity === "quarter" ? "quarter" : "month";

  interface Candidate extends RiskItem {
    sortDays: number;
  }
  const out: Candidate[] = [];

  for (const i of issues) {
    const state = flowFor(i, joins, flow, asOf ? nowMs : undefined);

    // 1. overdue — planned commitment is in the past. Highest severity.
    let overdueLabel: string | null = null;
    if (i.planned_month && i.planned_month < monthKey) overdueLabel = i.planned_month;
    else if (i.planned_week && i.planned_week < weekKey) overdueLabel = i.planned_week;
    if (overdueLabel) {
      const daysLate = daysSince(i.updated_at, now);
      out.push({
        issueNumber: i.number,
        title: i.title,
        reason: `slipped from ${overdueLabel}`,
        severity: 3,
        kind: "reactive",
        category: "overdue",
        sortDays: daysLate + 1000,
      });
      continue;
    }

    const hasPlan = i.planned_month !== null || i.planned_week !== null;
    const hasCommitment = hasPlan || i.is_todo === 1;
    const stale = daysSince(i.updated_at, now);

    // 2a. stalled or cold flow state — only flag if the team committed to it
    // (planned for a period, or in TODO). Backlog items are by definition not
    // part of the roadmap and shouldn't be reported as risks.
    if ((state === "stalled" || state === "cold") && hasCommitment) {
      const noAssignee = !i.assignee;
      // Due-this-period & not moving is more urgent than a stall with runway.
      const d = periodsUntilDue(granularity, i.planned_month, i.planned_week, asOfDate);
      const dueNow = d === 0;
      // Can we actually see whether this is moving? With no linked PR and no
      // timeline events, "stalled" is just absence of data — an active PR that
      // simply isn't referenced reads identically. Don't cry critical on that;
      // flag it as low-signal so the genuinely-stuck items stand out.
      const hasPr = (joins.pullsByIssue.get(i.number)?.length ?? 0) > 0;
      const hasEvents = (joins.eventsByIssue.get(i.number)?.length ?? 0) > 0;
      const blind = !hasPr && !hasEvents;
      if (blind) {
        let reason = noAssignee ? `quiet ${stale}d, no PR · no assignee` : `quiet ${stale}d, no PR linked`;
        if (dueNow) reason += `, due this ${periodNoun}`;
        out.push({
          issueNumber: i.number,
          title: i.title,
          reason,
          severity: 1,
          kind: "reactive",
          category: "low-signal",
          sortDays: stale + (dueNow ? 200 : 100),
        });
        continue;
      }
      let reason = noAssignee ? `${state} ${stale}d, no assignee` : `${state} ${stale}d`;
      if (dueNow) reason += `, due this ${periodNoun}`;
      out.push({
        issueNumber: i.number,
        title: i.title,
        reason,
        severity: dueNow ? 3 : 2,
        kind: "reactive",
        category: "stalled-flow",
        sortDays: stale + (dueNow ? 700 : 500),
      });
      continue;
    }

    // 2b. has a plan but no assignee
    if (hasPlan && !i.assignee) {
      const planLabel = i.planned_month
        ? shortMonthLabel(i.planned_month)
        : i.planned_week ?? "";
      out.push({
        issueNumber: i.number,
        title: i.title,
        reason: `committed for ${planLabel}, no movement`,
        severity: 2,
        kind: "reactive",
        category: "no-assignee",
        sortDays: stale + 250,
      });
      continue;
    }

    // 3. todo-stale
    if (i.is_todo === 1 && i.app_updated_at) {
      const todoDays = daysSince(i.app_updated_at, now);
      if (todoDays >= todoStaleDays) {
        out.push({
          issueNumber: i.number,
          title: i.title,
          reason: `in TODO ${todoDays}d`,
          severity: 1,
          kind: "reactive",
          category: "todo-stale",
          sortDays: todoDays,
        });
        continue;
      }
    }
  }

  // Predictive detectors run alongside reactive ones. Same RiskItem shape.
  // approximate: predictive detectors read current pull/review/check state and
  // can't be replayed historically, so we skip them when asOf is set.
  if (!asOf) {
    const reactiveStalledNumbers = new Set(
      out.filter((i) => i.category === "stalled-flow").map((i) => i.issueNumber),
    );
    const pt = loadPredictiveThresholds();
    const currentUser = getKv("currentUser");
    const predictive = detectAllPredictive(mf, pt, { reactiveStalledNumbers, currentUser });

    // Dedupe predictive items if the same (issue, category) already exists.
    const seen = new Set(out.map((c) => `${c.issueNumber}:${c.category}`));
    for (const p of predictive) {
      const k = `${p.issueNumber}:${p.category}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...p, sortDays: 0 });
    }
  }

  // Customer-signal boost: any reactive item whose issue has ≥1 linked insight
  // bumps severity by 1 (capped at 3) and gets a " · customer signal" suffix on
  // the reason. Predictive detectors stay as-is for Phase 1.
  const insightIssues = loadIssueNumbersWithInsights();
  if (insightIssues.size > 0) {
    for (const c of out) {
      if (c.kind !== "reactive") continue;
      if (!insightIssues.has(c.issueNumber)) continue;
      const bumped = Math.min(3, c.severity + 1) as 1 | 2 | 3;
      c.severity = bumped;
      if (!c.reason.includes("customer signal")) c.reason = `${c.reason} · customer signal`;
    }
  }

  // Effort modifier. Confirmed effort:* labels adjust severity (foundation +1,
  // lightning -1, capped 1..3); AI estimates are noisy so they only nudge order
  // within a severity band, never change severity. Effort is carried on the item
  // so the UI can chip it and the AI read can prioritise by it.
  const labelEffortByNum = new Map<number, EffortRating>();
  for (const i of issues) {
    try {
      const parsed = JSON.parse(i.labels) as unknown;
      if (Array.isArray(parsed)) {
        const e = effortFromLabels(parsed.filter((x): x is string => typeof x === "string"));
        if (e) labelEffortByNum.set(i.number, e);
      }
    } catch {
      /* skip */
    }
  }
  const estEffortByNum = asOf
    ? new Map<number, EffortRating>()
    : loadEstimateEffort(out.map((c) => c.issueNumber));
  for (const c of out) {
    const lbl = labelEffortByNum.get(c.issueNumber);
    if (lbl) {
      c.effort = lbl;
      c.effortSource = "label";
      if (lbl === "foundation") c.severity = Math.min(3, c.severity + 1) as 1 | 2 | 3;
      else if (lbl === "lightning") c.severity = Math.max(1, c.severity - 1) as 1 | 2 | 3;
    } else {
      const est = estEffortByNum.get(c.issueNumber);
      if (est) {
        c.effort = est;
        c.effortSource = "estimate";
        if (est === "foundation") c.sortDays += 5;
        else if (est === "lightning") c.sortDays -= 5;
      }
    }
  }

  out.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    // Within same severity: reactive before preventative.
    const ar = a.kind === "reactive" ? 0 : 1;
    const br = b.kind === "reactive" ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.sortDays - a.sortDays;
  });

  return out.slice(0, 50).map((c) => ({
    issueNumber: c.issueNumber,
    title: c.title,
    reason: c.reason,
    severity: c.severity,
    kind: c.kind,
    category: c.category,
    effort: c.effort ?? null,
    effortSource: c.effortSource ?? null,
  }));
}

interface PredictiveThresholdRow {
  predict_pr_stale_days: number;
  predict_pr_min_age: number;
  predict_review_wait_days: number;
  predict_promise_confidence_min: number;
  predict_reply_overdue_hours: number;
}
function loadPredictiveThresholds(): PredictiveThresholds {
  const r = db()
    .prepare(
      "SELECT predict_pr_stale_days, predict_pr_min_age, predict_review_wait_days, predict_promise_confidence_min, predict_reply_overdue_hours FROM workspace_config WHERE id = 1",
    )
    .get() as PredictiveThresholdRow | undefined;
  return {
    prStaleDays: r?.predict_pr_stale_days ?? 3,
    prMinAgeForStale: r?.predict_pr_min_age ?? 7,
    reviewWaitDays: r?.predict_review_wait_days ?? 2,
    promiseConfidenceMin: (r?.predict_promise_confidence_min ?? 60) / 100,
    replyOverdueHours: r?.predict_reply_overdue_hours ?? 24,
  };
}

// Returns YYYY-MM-DD in UTC.
export function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function upsertSnapshot(): {
  snapshotDate: string;
  confidence: number | null;
  sampleSize: number;
  atRiskCount: number;
} {
  const mf = getMasterFilter();
  const { confidence, sampleSize } = computeConfidence(mf);
  const atRisk = computeAtRisk(mf);
  const onTime = computeScheduleHealth(mf).onTime;
  const date = utcDateKey();
  const computedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO health_snapshots(snapshot_date, confidence, sample_size, at_risk_json, computed_at, on_time)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(snapshot_date) DO UPDATE SET
         confidence=excluded.confidence,
         sample_size=excluded.sample_size,
         at_risk_json=excluded.at_risk_json,
         computed_at=excluded.computed_at,
         on_time=excluded.on_time`,
    )
    .run(date, confidence, sampleSize, JSON.stringify(atRisk), computedAt, onTime);
  return { snapshotDate: date, confidence, sampleSize, atRiskCount: atRisk.length };
}
