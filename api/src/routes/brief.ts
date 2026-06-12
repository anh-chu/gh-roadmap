import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { computeAtRisk, computeConfidence, computeScheduleHealth } from "../health.js";
import { getMasterFilter, masterFilterSql, type MasterFilter } from "../masterFilter.js";
import { computeFlowState, type FlowInput, type FlowThresholdsResolved } from "../flow.js";
import type {
  BriefAtRiskSeverity,
  BriefChangeRef,
  BriefChanges,
  BriefFlowMix,
  BriefSnapshot,
  FlowState,
  RiskItem,
} from "../../../shared/types.js";

interface ThresholdRow {
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
  range_granularity: "week" | "month" | "quarter";
}

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
}

interface PullJoinRow {
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

function loadThresholds(workspaceId: number): { flow: FlowThresholdsResolved; granularity: "week" | "month" | "quarter" } {
  const t = db()
    .prepare(
      "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days, range_granularity FROM workspace_config WHERE id = ?",
    )
    .get(workspaceId) as ThresholdRow | undefined;
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
    granularity: t?.range_granularity ?? "month",
  };
}

function loadScopedIssues(workspaceId: number, mf: MasterFilter, openOnly: boolean): IssueRow[] {
  const sql = masterFilterSql(mf);
  const scope = sql ? ` AND ${sql.sql}` : "";
  const params = sql ? sql.params : [];
  const stateClause = openOnly ? "i.state = 'open'" : "1=1";
  return db()
    .prepare(
      `SELECT i.number, i.title, i.state, i.assignee, i.created_at, i.updated_at, i.closed_at,
              m.planned_month, m.planned_week, m.is_todo, m.app_updated_at
       FROM issues i
       LEFT JOIN roadmap_meta m ON m.issue_number = i.number AND m.workspace_id = ?
       WHERE ${stateClause}${scope}`,
    )
    .all(workspaceId, ...params) as IssueRow[];
}

interface JoinedData {
  pullsByIssue: Map<number, PullJoinRow[]>;
  reviewsByPull: Map<number, ReviewRow[]>;
  checksByPull: Map<number, CheckRow>;
  commentsByIssue: Map<number, CommentAgg>;
  eventsByIssue: Map<number, EventRow[]>;
}

function loadJoins(): JoinedData {
  const pulls = db()
    .prepare(`SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls`)
    .all() as PullJoinRow[];
  const reviews = db()
    .prepare(`SELECT pull_number, state, submitted_at, author FROM pull_reviews`)
    .all() as ReviewRow[];
  const checks = db().prepare(`SELECT pull_number, status FROM pull_checks`).all() as CheckRow[];
  const commentAgg = db()
    .prepare(
      `SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments GROUP BY issue_number`,
    )
    .all() as CommentAgg[];
  const events = db()
    .prepare(`SELECT issue_number, event_type, created_at FROM issue_events`)
    .all() as EventRow[];

  const checksByPull = new Map<number, CheckRow>();
  for (const c of checks) checksByPull.set(c.pull_number, c);
  const reviewsByPull = new Map<number, ReviewRow[]>();
  for (const r of reviews) {
    const arr = reviewsByPull.get(r.pull_number);
    if (arr) arr.push(r);
    else reviewsByPull.set(r.pull_number, [r]);
  }
  const pullsByIssue = new Map<number, PullJoinRow[]>();
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

function flowFor(issue: IssueRow, joins: JoinedData, thresholds: FlowThresholdsResolved): FlowState {
  const linkedPulls = joins.pullsByIssue.get(issue.number) ?? [];
  const comment = joins.commentsByIssue.get(issue.number);
  const evs = joins.eventsByIssue.get(issue.number) ?? [];
  const input: FlowInput = {
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
function currentQuarterKey(d = new Date()): string {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function severitiesFromAtRisk(items: RiskItem[]): BriefAtRiskSeverity {
  const out: BriefAtRiskSeverity = { critical: 0, high: 0, medium: 0 };
  for (const r of items) {
    if (r.severity === 3) out.critical++;
    else if (r.severity === 2) out.high++;
    else if (r.severity === 1) out.medium++;
  }
  return out;
}

function emptyFlowMix(): BriefFlowMix {
  return {
    shipping: 0,
    "in-review": 0,
    "in-code": 0,
    discussing: 0,
    stalled: 0,
    cold: 0,
    fresh: 0,
    closed: 0,
  };
}

function confidenceLabel(c: number | null): BriefSnapshot["confidenceLabel"] {
  if (c === null) return "no plan";
  if (c >= 80) return "on track";
  if (c >= 50) return "mixed";
  return "at risk";
}

function buildSnapshot(workspaceId: number): BriefSnapshot {
  const mf = getMasterFilter(workspaceId);
  const { flow, granularity } = loadThresholds(workspaceId);
  const { confidence, sampleSize } = computeConfidence(workspaceId, mf);
  const schedule = computeScheduleHealth(workspaceId, mf);
  const atRiskItems = computeAtRisk(workspaceId, mf);

  const openIssues = loadScopedIssues(workspaceId, mf, true);
  const allScoped = loadScopedIssues(workspaceId, mf, false);
  const joins = loadJoins();

  // Flow mix over open scoped issues.
  const flowMix = emptyFlowMix();
  for (const i of openIssues) {
    const s = flowFor(i, joins, flow);
    flowMix[s] = (flowMix[s] ?? 0) + 1;
  }

  // Current period bucket.
  const monthKey = currentMonthKey();
  const weekKey = currentWeekKey();
  const quarterKey = currentQuarterKey();

  function inCurrentPeriod(issue: IssueRow): boolean {
    if (granularity === "week") return issue.planned_week === weekKey;
    if (granularity === "quarter") {
      // planned_month is YYYY-MM; map to quarter.
      if (!issue.planned_month) return false;
      const m = Number(issue.planned_month.slice(5, 7));
      if (!Number.isFinite(m)) return false;
      const q = Math.floor((m - 1) / 3) + 1;
      const y = issue.planned_month.slice(0, 4);
      return `${y}-Q${q}` === quarterKey;
    }
    return issue.planned_month === monthKey;
  }

  // Period closed_at window (UTC) for "done".
  function inCurrentPeriodClosed(closedAt: string | null): boolean {
    if (!closedAt) return false;
    const t = Date.parse(closedAt);
    if (!Number.isFinite(t)) return false;
    const d = new Date(t);
    if (granularity === "week") return currentWeekKey(d) === weekKey;
    if (granularity === "quarter") return currentQuarterKey(d) === quarterKey;
    return currentMonthKey(d) === monthKey;
  }

  let done = 0;
  let active = 0;
  let stalled = 0;
  let total = 0;
  const activeStates: FlowState[] = ["shipping", "in-review", "in-code", "discussing", "fresh"];
  const stalledStates: FlowState[] = ["stalled", "cold"];
  for (const i of allScoped) {
    const closedThisPeriod = i.state === "closed" && inCurrentPeriodClosed(i.closed_at);
    const plannedThisPeriod = inCurrentPeriod(i);
    // Account for work planned for this period AND anything closed this period —
    // the latter captures items finished early (planned later) or late (planned
    // earlier) against their roadmap slot, which the plan-only gate dropped.
    if (!plannedThisPeriod && !closedThisPeriod) continue;
    total++;
    if (i.state === "closed") {
      if (closedThisPeriod) done++;
      continue;
    }
    const s = flowFor(i, joins, flow);
    if (activeStates.includes(s)) active++;
    else if (stalledStates.includes(s)) stalled++;
  }

  // Queue counts (master-filter scoped).
  let todo = 0;
  let backlog = 0;
  for (const i of openIssues) {
    if (i.is_todo === 1) todo++;
    else if (!i.planned_month && !i.planned_week) backlog++;
  }

  return {
    asOf: new Date().toISOString(),
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    onTime: schedule.onTime,
    scheduleStatus: schedule.status,
    sampleSize,
    atRisk: severitiesFromAtRisk(atRiskItems),
    atRiskFoundation: atRiskItems.filter((i) => i.effort === "foundation").length,
    flowMix,
    currentPeriod: { done, active, stalled, total },
    queue: { todo, backlog },
    crossPodRefs: [],
  };
}

function readPodLastSeen(workspaceId: number): string | null {
  const r = db()
    .prepare("SELECT pod_last_seen_at FROM workspace_config WHERE id = ?")
    .get(workspaceId) as { pod_last_seen_at: string | null } | undefined;
  return r?.pod_last_seen_at ?? null;
}

function setPodLastSeen(workspaceId: number, iso: string): void {
  db()
    .prepare("UPDATE workspace_config SET pod_last_seen_at = ? WHERE id = ?")
    .run(iso, workspaceId);
}

// Parse health_snapshots at_risk_json for a date, falling back to nearest ≤ date.
function loadAtRiskNumbersOnOrBefore(workspaceId: number, dateKey: string): Set<number> {
  interface Row { snapshot_date: string; at_risk_json: string }
  const row = db()
    .prepare(
      `SELECT snapshot_date, at_risk_json FROM health_snapshots
       WHERE workspace_id = ? AND snapshot_date <= ?
       ORDER BY snapshot_date DESC LIMIT 1`,
    )
    .get(workspaceId, dateKey) as Row | undefined;
  if (!row) return new Set();
  try {
    const arr = JSON.parse(row.at_risk_json) as unknown;
    if (!Array.isArray(arr)) return new Set();
    const out = new Set<number>();
    for (const x of arr) {
      if (x && typeof x === "object") {
        const n = (x as { issueNumber?: unknown }).issueNumber;
        if (typeof n === "number") out.add(n);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function buildChanges(workspaceId: number): BriefChanges {
  const mf = getMasterFilter(workspaceId);
  const since = readPodLastSeen(workspaceId);
  const emptyTotals = {
    enteredAtRisk: 0,
    exitedAtRisk: 0,
    resolved: 0,
    newActivity: 0,
    prsMerged: 0,
    newIssues: 0,
  };
  if (!since) {
    return {
      since: null,
      cappedAt: null,
      enteredAtRisk: [],
      exitedAtRisk: [],
      resolved: [],
      newActivity: [],
      prsMerged: [],
      newIssues: [],
      totals: emptyTotals,
    };
  }

  const sinceMs = Date.parse(since);
  const now = Date.now();
  let cappedAt: string | null = null;
  let effectiveSince = since;
  if (Number.isFinite(sinceMs) && now - sinceMs > SEVEN_DAYS_MS) {
    cappedAt = since;
    effectiveSince = new Date(now - SEVEN_DAYS_MS).toISOString();
  }
  const sinceDateKey = effectiveSince.slice(0, 10);

  // Today's at-risk issue numbers, master-filter scoped (computeAtRisk respects mf).
  const todayAtRisk = computeAtRisk(workspaceId, mf);
  const todayAtRiskMap = new Map<number, RiskItem>();
  for (const r of todayAtRisk) todayAtRiskMap.set(r.issueNumber, r);

  // Baseline at-risk numbers from snapshot ≤ since date.
  const baselineSet = loadAtRiskNumbersOnOrBefore(workspaceId, sinceDateKey);

  // Title lookup for entered/exited (need master-filter scope to derive titles).
  const allScoped = loadScopedIssues(workspaceId, mf, false);
  const titleByNum = new Map<number, string>();
  for (const i of allScoped) titleByNum.set(i.number, i.title);

  const todaySet = new Set(todayAtRiskMap.keys());
  const enteredNums = [...todaySet].filter((n) => !baselineSet.has(n));
  const exitedNums = [...baselineSet].filter((n) => !todaySet.has(n));

  const enteredAtRisk: BriefChangeRef[] = [];
  for (const n of enteredNums) {
    const ri = todayAtRiskMap.get(n);
    const title = ri?.title ?? titleByNum.get(n);
    if (!title) continue;
    const ref: BriefChangeRef = { num: n, title };
    if (ri?.reason) ref.reason = ri.reason;
    enteredAtRisk.push(ref);
  }

  const exitedAtRisk: BriefChangeRef[] = [];
  for (const n of exitedNums) {
    const title = titleByNum.get(n);
    if (!title) continue;
    exitedAtRisk.push({ num: n, title });
  }

  // Resolved: closed_at > effectiveSince.
  const mfSql = masterFilterSql(mf);
  const mfScope = mfSql ? ` AND ${mfSql.sql}` : "";
  const mfParams = mfSql ? mfSql.params : [];

  const resolvedRows = db()
    .prepare(
      `SELECT i.number, i.title, i.closed_at FROM issues i
       WHERE i.state = 'closed' AND i.closed_at IS NOT NULL AND i.closed_at > ?${mfScope}
       ORDER BY i.closed_at DESC`,
    )
    .all(effectiveSince, ...mfParams) as Array<{ number: number; title: string; closed_at: string }>;
  const resolved = resolvedRows.map((r) => ({ num: r.number, title: r.title, closedAt: r.closed_at }));

  // Pod assignees = distinct assignees on master-filter scoped OPEN issues.
  const openScoped = loadScopedIssues(workspaceId, mf, true);
  const podAssignees = new Set<string>();
  for (const i of openScoped) if (i.assignee) podAssignees.add(i.assignee);

  // New activity: comments since, author NOT in pod, grouped by issue.
  const commentRows = db()
    .prepare(
      `SELECT c.issue_number, c.author, c.created_at, i.title
       FROM comments c
       JOIN issues i ON i.number = c.issue_number
       WHERE c.created_at > ?${mfScope}
       ORDER BY c.created_at DESC`,
    )
    .all(effectiveSince, ...mfParams) as Array<{
      issue_number: number;
      author: string | null;
      created_at: string;
      title: string;
    }>;
  const activityByIssue = new Map<
    number,
    { num: number; title: string; lastActor: string; commentCount: number; lastAt: string }
  >();
  for (const row of commentRows) {
    if (!row.author || podAssignees.has(row.author)) continue;
    const existing = activityByIssue.get(row.issue_number);
    if (existing) {
      existing.commentCount++;
    } else {
      activityByIssue.set(row.issue_number, {
        num: row.issue_number,
        title: row.title,
        lastActor: row.author,
        commentCount: 1,
        lastAt: row.created_at,
      });
    }
  }
  const newActivity = [...activityByIssue.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((v) => ({ num: v.num, title: v.title, lastActor: v.lastActor, commentCount: v.commentCount }));

  // PRs merged since. Master-filter scope via linked issues.
  const prRows = db()
    .prepare(
      `SELECT number, title, merged_at, linked_issues FROM pulls
       WHERE merged = 1 AND merged_at IS NOT NULL AND merged_at > ?
       ORDER BY merged_at DESC`,
    )
    .all(effectiveSince) as Array<{ number: number; title: string; merged_at: string; linked_issues: string }>;
  const scopedNums = new Set(allScoped.map((i) => i.number));
  const prsMerged = prRows
    .map((p) => {
      let linked: number[] = [];
      try {
        const parsed = JSON.parse(p.linked_issues) as unknown;
        if (Array.isArray(parsed)) linked = parsed.filter((x): x is number => typeof x === "number");
      } catch {
        /* skip */
      }
      if (linked.length > 0) {
        const filtered = linked.filter((n) => scopedNums.has(n));
        if (filtered.length === 0) return null;
        return { prNum: p.number, title: p.title, linkedIssues: filtered };
      }
      // No linked issues → keep (master filter cannot scope it out).
      return { prNum: p.number, title: p.title, linkedIssues: linked };
    })
    .filter((x): x is { prNum: number; title: string; linkedIssues: number[] } => x !== null);

  // New issues: created_at > effectiveSince.
  const newIssueRows = db()
    .prepare(
      `SELECT i.number, i.title, i.raw FROM issues i
       WHERE i.created_at IS NOT NULL AND i.created_at > ?${mfScope}
       ORDER BY i.created_at DESC`,
    )
    .all(effectiveSince, ...mfParams) as Array<{ number: number; title: string; raw: string }>;
  const newIssues = newIssueRows.map((r) => {
    let author = "";
    try {
      const parsed = JSON.parse(r.raw) as { user?: { login?: unknown } };
      const login = parsed?.user?.login;
      if (typeof login === "string") author = login;
    } catch {
      /* skip */
    }
    return { num: r.number, title: r.title, author };
  });

  const totals = {
    enteredAtRisk: enteredAtRisk.length,
    exitedAtRisk: exitedAtRisk.length,
    resolved: resolved.length,
    newActivity: newActivity.length,
    prsMerged: prsMerged.length,
    newIssues: newIssues.length,
  };

  const CAP = 10;
  return {
    since,
    cappedAt,
    enteredAtRisk: enteredAtRisk.slice(0, CAP),
    exitedAtRisk: exitedAtRisk.slice(0, CAP),
    resolved: resolved.slice(0, CAP),
    newActivity: newActivity.slice(0, CAP),
    prsMerged: prsMerged.slice(0, CAP),
    newIssues: newIssues.slice(0, CAP),
    totals,
  };
}

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/brief/snapshot", async (req): Promise<BriefSnapshot> => buildSnapshot(req.workspaceId));

  app.get("/api/brief/changes", async (req): Promise<BriefChanges> => buildChanges(req.workspaceId));

  app.post("/api/brief/mark-seen", async (req): Promise<{ podLastSeenAt: string }> => {
    const now = new Date().toISOString();
    setPodLastSeen(req.workspaceId, now);
    return { podLastSeenAt: now };
  });
}
