import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import {
  aiDisabledReason,
  aiModel,
  analyzeProgress,
  isAiEnabled,
  summarizeIssue,
  type IssueSummaryComment,
  type IssueSummaryInput,
  type IssueSummaryPull,
  type ProgressInput,
} from "../ai.js";
import {
  computeAtRisk,
  computeConfidence,
  computeRoadmapTimeline,
  computeScheduleHealth,
} from "../health.js";
import { getMasterFilter, passesMasterFilter } from "../masterFilter.js";
import {
  computeFlowState,
  type FlowInput,
  type FlowThresholdsResolved,
} from "../flow.js";
import type { AiProgress, AiSummary, EffortRating, FlowState } from "../../../shared/types.js";

interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  assignee: string | null;
  labels: string;
}

interface CommentRow {
  author: string | null;
  body: string;
  created_at: string;
  id: number;
}

interface PullLinkRow {
  number: number;
  state: "open" | "closed";
  merged: number;
  linked_issues: string;
}

interface SummaryCacheRow {
  summary: string;
  model: string;
  source_hash: string;
  generated_at: string;
  effort: string | null;
}

const VALID_EFFORT = new Set<string>(["lightning", "incremental", "foundation"]);
function coerceEffort(v: string | null): EffortRating | null {
  return v && VALID_EFFORT.has(v) ? (v as EffortRating) : null;
}

interface InsightRow {
  content: string;
  model: string;
  generated_at: string;
}

function disabled(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: aiDisabledReason() });
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function loadIssueForSummary(num: number): {
  issue: IssueRow;
  labels: string[];
  comments: CommentRow[];
  pulls: PullLinkRow[];
  lastCommentId: number | null;
} | null {
  const issue = db()
    .prepare("SELECT number, title, body, state, assignee, labels FROM issues WHERE number = ?")
    .get(num) as IssueRow | undefined;
  if (!issue) return null;
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(issue.labels) as unknown;
    if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  if (!passesMasterFilter(labels, getMasterFilter())) return null;
  const comments = db()
    .prepare(
      "SELECT id, author, body, created_at FROM comments WHERE issue_number = ? ORDER BY created_at ASC",
    )
    .all(num) as CommentRow[];
  const allPulls = db()
    .prepare("SELECT number, state, merged, linked_issues FROM pulls")
    .all() as PullLinkRow[];
  const pulls = allPulls.filter((p) => {
    try {
      const linked = JSON.parse(p.linked_issues) as unknown;
      return Array.isArray(linked) && linked.includes(num);
    } catch {
      return false;
    }
  });
  const lastCommentId = comments.length > 0 ? comments[comments.length - 1]?.id ?? null : null;
  return { issue, labels, comments, pulls, lastCommentId };
}

function computeSourceHash(
  issue: IssueRow,
  labels: string[],
  commentCount: number,
  lastCommentId: number | null,
): string {
  const labelsSorted = [...labels].sort().join(",");
  const key = `${issue.title}|${issue.body ?? ""}|${labelsSorted}|${issue.assignee ?? ""}|${issue.state}|${commentCount}|${lastCommentId ?? ""}`;
  return sha256(key);
}

function buildSummaryInput(
  issue: IssueRow,
  labels: string[],
  comments: CommentRow[],
  pulls: PullLinkRow[],
): IssueSummaryInput {
  const summaryComments: IssueSummaryComment[] = comments.map((c) => ({
    author: c.author,
    createdAt: c.created_at,
    body: c.body,
  }));
  const summaryPulls: IssueSummaryPull[] = pulls.map((p) => ({
    number: p.number,
    state: p.state,
    merged: !!p.merged,
  }));
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels,
    assignee: issue.assignee,
    state: issue.state,
    comments: summaryComments,
    pulls: summaryPulls,
  };
}

async function generateAndStoreSummary(num: number): Promise<AiSummary | null> {
  const loaded = loadIssueForSummary(num);
  if (!loaded) return null;
  const { issue, labels, comments, pulls, lastCommentId } = loaded;
  const sourceHash = computeSourceHash(issue, labels, comments.length, lastCommentId);
  const input = buildSummaryInput(issue, labels, comments, pulls);
  const { summary, model, effort } = await summarizeIssue(input);
  const generatedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO ai_summaries(issue_number, summary, model, source_hash, generated_at, effort)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(issue_number) DO UPDATE SET
         summary=excluded.summary,
         model=excluded.model,
         source_hash=excluded.source_hash,
         generated_at=excluded.generated_at,
         effort=excluded.effort`,
    )
    .run(num, summary, model, sourceHash, generatedAt, effort);
  return { summary, model, generatedAt, fromCache: false, effort };
}

interface ThresholdRow {
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
}

interface FlowIssueRow {
  number: number;
  state: "open" | "closed";
  created_at: string | null;
  updated_at: string;
  assignee: string | null;
}

interface FlowPullRow {
  number: number;
  state: "open" | "closed";
  merged: number;
  merged_at: string | null;
  is_draft: number;
  last_commit_at: string | null;
  linked_issues: string;
}

interface FlowReviewRow {
  pull_number: number;
  state: string;
  submitted_at: string;
  author: string | null;
}

interface FlowCheckRow {
  pull_number: number;
  status: string | null;
}

interface FlowCommentAgg {
  issue_number: number;
  cnt: number;
  last_at: string | null;
}

interface FlowEventRow {
  issue_number: number;
  event_type: string;
  created_at: string;
}

function confidenceLabel(c: number | null): string {
  if (c === null) return "no plan";
  if (c >= 80) return "on track";
  if (c >= 50) return "mixed";
  return "at risk";
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

function computeFlowDistribution(): Record<string, number> {
  const t = db()
    .prepare(
      "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days FROM workspace_config WHERE id = 1",
    )
    .get() as ThresholdRow | undefined;
  const thresholds: FlowThresholdsResolved = {
    shippingHours: t?.flow_shipping_hours ?? 24,
    reviewActivityDays: t?.flow_review_days ?? 3,
    codeActivityDays: t?.flow_code_days ?? 3,
    discussionDays: t?.flow_discussion_days ?? 5,
    stallDays: t?.flow_stall_days ?? 14,
    coldDays: t?.flow_cold_days ?? 60,
    freshDays: t?.flow_fresh_days ?? 7,
  };

  // Master-filter scoped open issues only — same shape as routes/flow.ts.
  const mf = getMasterFilter();
  const issues = db()
    .prepare(
      `SELECT i.number, i.state, i.created_at, i.updated_at, i.assignee FROM issues i WHERE i.state = 'open'`,
    )
    .all() as FlowIssueRow[];
  // Apply master filter in JS — small set, simpler than building the dynamic SQL twice.
  const labelMap = new Map<number, string[]>();
  const labelRows = db().prepare("SELECT number, labels FROM issues").all() as Array<{
    number: number;
    labels: string;
  }>;
  for (const r of labelRows) {
    try {
      const v = JSON.parse(r.labels) as unknown;
      if (Array.isArray(v)) labelMap.set(r.number, v.filter((x): x is string => typeof x === "string"));
    } catch {
      /* skip */
    }
  }
  const scoped = issues.filter((i) => passesMasterFilter(labelMap.get(i.number) ?? [], mf));

  const pulls = db()
    .prepare(
      "SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls",
    )
    .all() as FlowPullRow[];
  const reviews = db()
    .prepare("SELECT pull_number, state, submitted_at, author FROM pull_reviews")
    .all() as FlowReviewRow[];
  const checks = db().prepare("SELECT pull_number, status FROM pull_checks").all() as FlowCheckRow[];
  const commentAgg = db()
    .prepare(
      "SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments GROUP BY issue_number",
    )
    .all() as FlowCommentAgg[];
  const events = db()
    .prepare("SELECT issue_number, event_type, created_at FROM issue_events")
    .all() as FlowEventRow[];

  const checksByPull = new Map<number, FlowCheckRow>();
  for (const c of checks) checksByPull.set(c.pull_number, c);
  const reviewsByPull = new Map<number, FlowReviewRow[]>();
  for (const r of reviews) {
    const arr = reviewsByPull.get(r.pull_number);
    if (arr) arr.push(r);
    else reviewsByPull.set(r.pull_number, [r]);
  }
  const pullsByIssue = new Map<number, FlowPullRow[]>();
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
  const commentsByIssue = new Map<number, FlowCommentAgg>();
  for (const c of commentAgg) commentsByIssue.set(c.issue_number, c);
  const eventsByIssue = new Map<number, FlowEventRow[]>();
  for (const e of events) {
    const arr = eventsByIssue.get(e.issue_number);
    if (arr) arr.push(e);
    else eventsByIssue.set(e.issue_number, [e]);
  }

  const dist: Record<string, number> = {};
  for (const i of scoped) {
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
        ciStatus: checksByPull.get(p.number)?.status ?? null,
        reviews: (reviewsByPull.get(p.number) ?? []).map((r) => ({
          state: r.state,
          submittedAt: r.submitted_at,
          author: r.author,
        })),
      })),
      events: evs.map((e) => ({ type: e.event_type, createdAt: e.created_at })),
      thresholds,
    };
    const s: FlowState = computeFlowState(input).state;
    dist[s] = (dist[s] ?? 0) + 1;
  }
  return dist;
}

async function generateAndStoreProgress(): Promise<AiProgress> {
  const mf = getMasterFilter();
  const { confidence, sampleSize } = computeConfidence(mf);
  const atRisk = computeAtRisk(mf);
  const flowDistribution = computeFlowDistribution();
  const schedule = computeScheduleHealth(mf);
  const roadmap = computeRoadmapTimeline(mf);
  const input: ProgressInput = {
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    sampleSize,
    atRisk,
    flowDistribution,
    masterFilter: mf,
    currentPeriod: { month: currentMonthKey(), week: currentWeekKey() },
    schedule,
    roadmap,
  };
  const { analysis, model } = await analyzeProgress(input);
  const generatedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO ai_insights(kind, content, model, generated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(kind) DO UPDATE SET
         content=excluded.content,
         model=excluded.model,
         generated_at=excluded.generated_at`,
    )
    .run("progress", analysis, model, generatedAt);
  return { analysis, model, generatedAt, fromCache: false };
}

const PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { num: string } }>(
    "/api/ai/issue-summary/:num",
    async (req, reply): Promise<AiSummary | undefined> => {
      if (!isAiEnabled()) {
        disabled(reply);
        return;
      }
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) {
        reply.code(400).send({ error: "invalid issue number" });
        return;
      }
      const loaded = loadIssueForSummary(num);
      if (!loaded) {
        reply.code(404).send({ error: "issue not in scope" });
        return;
      }
      const { issue, labels, comments, lastCommentId } = loaded;
      const hash = computeSourceHash(issue, labels, comments.length, lastCommentId);
      const cached = db()
        .prepare(
          "SELECT summary, model, source_hash, generated_at, effort FROM ai_summaries WHERE issue_number = ?",
        )
        .get(num) as SummaryCacheRow | undefined;
      if (cached && cached.source_hash === hash) {
        return {
          summary: cached.summary,
          model: cached.model,
          generatedAt: cached.generated_at,
          fromCache: true,
          effort: coerceEffort(cached.effort),
        };
      }
      try {
        const result = await generateAndStoreSummary(num);
        if (!result) {
          reply.code(404).send({ error: "issue not in scope" });
          return;
        }
        return result;
      } catch (err) {
        req.log.error({ err }, "ai summary failed");
        reply.code(503).send({
          error: "ai summary failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );

  app.post<{ Params: { num: string } }>(
    "/api/ai/issue-summary/:num/refresh",
    async (req, reply): Promise<AiSummary | undefined> => {
      if (!isAiEnabled()) {
        disabled(reply);
        return;
      }
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) {
        reply.code(400).send({ error: "invalid issue number" });
        return;
      }
      try {
        const result = await generateAndStoreSummary(num);
        if (!result) {
          reply.code(404).send({ error: "issue not in scope" });
          return;
        }
        return result;
      } catch (err) {
        req.log.error({ err }, "ai summary refresh failed");
        reply.code(503).send({
          error: "ai summary failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );

  app.get(
    "/api/ai/progress",
    async (req, reply): Promise<AiProgress | undefined> => {
      if (!isAiEnabled()) {
        disabled(reply);
        return;
      }
      const cached = db()
        .prepare("SELECT content, model, generated_at FROM ai_insights WHERE kind = 'progress'")
        .get() as InsightRow | undefined;
      if (cached) {
        const age = Date.now() - Date.parse(cached.generated_at);
        if (Number.isFinite(age) && age < PROGRESS_TTL_MS) {
          return {
            analysis: cached.content,
            model: cached.model,
            generatedAt: cached.generated_at,
            fromCache: true,
          };
        }
      }
      try {
        return await generateAndStoreProgress();
      } catch (err) {
        req.log.error({ err }, "ai progress failed");
        reply.code(503).send({
          error: "ai progress failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );

  app.post(
    "/api/ai/progress/refresh",
    async (req, reply): Promise<AiProgress | undefined> => {
      if (!isAiEnabled()) {
        disabled(reply);
        return;
      }
      try {
        return await generateAndStoreProgress();
      } catch (err) {
        req.log.error({ err }, "ai progress refresh failed");
        reply.code(503).send({
          error: "ai progress failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );

  // Touch `aiModel` to keep the import live for tooling; we surface model in returns.
  void aiModel;
}
