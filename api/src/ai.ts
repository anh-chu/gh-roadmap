import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccountsForIssues } from "./insights.js";
import { db } from "./db.js";
import { defaultWorkspaceId } from "./workspace.js";
import type { RoadmapTimeline } from "./health.js";
import type { EffortRating, PmActionItem, RiskItem, ScheduleHealth } from "../../shared/types.js";

export type AiTask = "summary" | "progress" | "extract" | "release";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve prompts dir relative to source so it works in both `tsx` (dev) and
// the compiled dist (api/dist/api/src/ai.js → ../../../api/src/prompts).
function loadPrompt(name: string): string {
  const candidates = [
    resolve(__dirname, "prompts", name),
    resolve(__dirname, "..", "..", "..", "src", "prompts", name),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error(`prompt not found: ${name}`);
}

const SUMMARY_SYSTEM = loadPrompt("summarize.md");
const PROGRESS_SYSTEM = loadPrompt("progress.md");
const EXTRACT_INSIGHT_SYSTEM = loadPrompt("extract-insight.md");
const PM_ACTIONS_SYSTEM = loadPrompt("pm-actions.md");
const MERGE_INSIGHTS_SYSTEM = loadPrompt("merge-insights.md");
const ACCOUNT_READ_SYSTEM = loadPrompt("account-read.md");
const RELEASE_NOTES_SYSTEM = loadPrompt("release-notes.md");

let _client: OpenAI | null = null;
let _disabledReason: string | null = null;

type TaskModelRow = {
  ai_model_summary: string | null;
  ai_model_progress: string | null;
  ai_model_extract: string | null;
  ai_model_release: string | null;
};

function readTaskModels(workspaceId: number = defaultWorkspaceId()): TaskModelRow {
  const empty: TaskModelRow = {
    ai_model_summary: null,
    ai_model_progress: null,
    ai_model_extract: null,
    ai_model_release: null,
  };
  try {
    const row = db()
      .prepare(
        "SELECT ai_model_summary, ai_model_progress, ai_model_extract, ai_model_release FROM workspace_config WHERE id = ?",
      )
      .get(workspaceId) as TaskModelRow | undefined;
    return row ?? empty;
  } catch {
    // DB not initialised yet — treat as no overrides.
    return empty;
  }
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function checkConfig(workspaceId?: number): string | null {
  const base = process.env.AI_BASE_URL;
  if (!base) return "AI not configured — set AI_BASE_URL";
  const envModel = nonEmpty(process.env.AI_MODEL);
  const row = readTaskModels(workspaceId);
  const anyOverride =
    nonEmpty(row.ai_model_summary) || nonEmpty(row.ai_model_progress) || nonEmpty(row.ai_model_extract);
  if (!envModel && !anyOverride) return "AI not configured — set AI_MODEL or a per-task override";
  return null;
}

// Re-evaluate on every call: env is stable but per-task DB overrides change at runtime,
// so a previously-disabled state may flip to enabled once a user sets an override.
function currentReason(workspaceId?: number): string | null {
  const reason = checkConfig(workspaceId);
  if (reason !== _disabledReason) {
    _disabledReason = reason;
    if (reason) {
      // eslint-disable-next-line no-console
      console.warn(`[ai] disabled: ${reason}`);
    }
  }
  return reason;
}

export function isAiEnabled(workspaceId?: number): boolean {
  return currentReason(workspaceId) === null;
}

export function aiDisabledReason(workspaceId?: number): string {
  return currentReason(workspaceId) ?? "AI disabled";
}

function client(workspaceId?: number): OpenAI {
  if (!isAiEnabled(workspaceId)) throw new Error(aiDisabledReason(workspaceId));
  if (_client === null) {
    _client = new OpenAI({
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY ?? "sk-local",
    });
  }
  return _client;
}

export function aiModel(): string {
  return process.env.AI_MODEL ?? "";
}

// List model ids from the OpenAI-compatible endpoint (GET /v1/models). Gated only on
// AI_BASE_URL, NOT isAiEnabled — the model picker is exactly what you use when no model is
// configured yet, so the stricter gate would lock you out of the list you need.
export async function listModels(): Promise<string[]> {
  const base = process.env.AI_BASE_URL;
  if (!base) throw new Error("AI not configured — set AI_BASE_URL");
  if (_client === null) {
    _client = new OpenAI({ baseURL: base, apiKey: process.env.AI_API_KEY ?? "sk-local" });
  }
  const page = await _client.models.list();
  const ids = page.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

// ─────────────── COST CONTROLS (max_tokens cap · rate limit · daily budget) ───────────────
// All admin-configured in workspace_config; 0 = disabled/unlimited. Enforced at the single
// chat chokepoint (runChat) so every AI surface inherits the limits. Breaches throw — routes
// already catch AI-fn errors and map them to 503, which is the agreed "hard stop" behaviour.

export interface AiLimits {
  maxTokensPerRequest: number;
  rateLimitRpm: number;
  dailyTokenBudget: number;
}

function readLimits(workspaceId: number): AiLimits {
  try {
    const row = db()
      .prepare(
        "SELECT ai_max_tokens_per_request, ai_rate_limit_rpm, ai_daily_token_budget FROM workspace_config WHERE id = ?",
      )
      .get(workspaceId) as
      | { ai_max_tokens_per_request: number; ai_rate_limit_rpm: number; ai_daily_token_budget: number }
      | undefined;
    return {
      maxTokensPerRequest: row?.ai_max_tokens_per_request ?? 0,
      rateLimitRpm: row?.ai_rate_limit_rpm ?? 0,
      dailyTokenBudget: row?.ai_daily_token_budget ?? 0,
    };
  } catch {
    // DB not initialised yet — treat as no limits.
    return { maxTokensPerRequest: 0, rateLimitRpm: 0, dailyTokenBudget: 0 };
  }
}

// Start of the current UTC day in epoch ms — the daily budget window boundary.
function utcDayStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Start of the current UTC month in epoch ms — used for the monthly usage readout.
function utcMonthStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// Token usage since UTC midnight for a workspace. Exported for the /api/meta usage meter.
export function aiTokensUsedToday(workspaceId: number): number {
  try {
    const row = db()
      .prepare("SELECT COALESCE(SUM(total_tokens), 0) AS s FROM ai_usage WHERE workspace_id = ? AND ts >= ?")
      .get(workspaceId, utcDayStartMs()) as { s: number } | undefined;
    return row?.s ?? 0;
  } catch {
    return 0;
  }
}

// Token usage since the start of the UTC month. Exported for the /api/meta usage meter.
export function aiTokensUsedThisMonth(workspaceId: number): number {
  try {
    const row = db()
      .prepare("SELECT COALESCE(SUM(total_tokens), 0) AS s FROM ai_usage WHERE workspace_id = ? AND ts >= ?")
      .get(workspaceId, utcMonthStartMs()) as { s: number } | undefined;
    return row?.s ?? 0;
  } catch {
    return 0;
  }
}

// Successful AI requests in the trailing 60s. Exported for the /api/meta usage meter.
export function aiRequestsLastMinute(workspaceId: number): number {
  try {
    const row = db()
      .prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND ts >= ?")
      .get(workspaceId, Date.now() - 60_000) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function aiLimits(workspaceId: number = defaultWorkspaceId()): AiLimits {
  return readLimits(workspaceId);
}

// Throws if the per-minute rate limit or daily token budget is exhausted. Returns the limits
// so the caller (runChat) can reuse them for the max_tokens cap without a second DB read.
function enforceLimits(workspaceId: number): AiLimits {
  const limits = readLimits(workspaceId);
  if (limits.rateLimitRpm > 0) {
    const n = aiRequestsLastMinute(workspaceId);
    if (n >= limits.rateLimitRpm) {
      throw new Error(`AI rate limit reached (${limits.rateLimitRpm} requests/min) \u2014 retry shortly`);
    }
  }
  if (limits.dailyTokenBudget > 0) {
    const used = aiTokensUsedToday(workspaceId);
    if (used >= limits.dailyTokenBudget) {
      throw new Error(
        `AI daily token budget exhausted (${used}/${limits.dailyTokenBudget} tokens) \u2014 resets at UTC midnight`,
      );
    }
  }
  return limits;
}

function recordUsage(
  workspaceId: number,
  task: AiTask,
  model: string,
  usage: OpenAI.CompletionUsage | undefined | null,
): void {
  try {
    const pt = usage?.prompt_tokens ?? 0;
    const ct = usage?.completion_tokens ?? 0;
    const tt = usage?.total_tokens ?? pt + ct;
    db()
      .prepare(
        "INSERT INTO ai_usage (workspace_id, ts, task, model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(workspaceId, Date.now(), task, model, pt, ct, tt);
  } catch {
    // Usage logging must never break an otherwise-successful AI call.
  }
}

type ChatParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">;

// Single chokepoint for every chat completion: enforce limits → inject max_tokens cap →
// call the model → record token usage. Throws (before any spend) when a budget/rate cap is hit.
async function runChat(
  task: AiTask,
  model: string,
  params: ChatParams,
  workspaceId?: number,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const wsId = workspaceId ?? defaultWorkspaceId();
  const limits = enforceLimits(wsId);
  const payload = { model, ...params } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  if (limits.maxTokensPerRequest > 0) payload.max_tokens = limits.maxTokensPerRequest;
  const resp = await client(workspaceId).chat.completions.create(payload);
  recordUsage(wsId, task, model, resp.usage);
  return resp;
}

export function aiModelFor(task: AiTask, workspaceId?: number): string {
  const row = readTaskModels(workspaceId);
  const override =
    task === "summary"
      ? nonEmpty(row.ai_model_summary)
      : task === "progress"
        ? nonEmpty(row.ai_model_progress)
        : task === "release"
          ? nonEmpty(row.ai_model_release)
          : nonEmpty(row.ai_model_extract);
  const envDefault = nonEmpty(process.env.AI_MODEL);
  const resolved = override ?? envDefault;
  if (!resolved) {
    throw new Error(
      `AI model unset for task "${task}" — configure AI_MODEL env or set a per-task override in workspace config`,
    );
  }
  return resolved;
}

export function logResolvedModels(log: (msg: string, meta?: Record<string, unknown>) => void): void {
  const tasks: AiTask[] = ["summary", "progress", "extract", "release"];
  const resolved: Record<string, string> = {};
  for (const t of tasks) {
    try {
      resolved[t] = aiModelFor(t);
    } catch {
      resolved[t] = "(unset)";
    }
  }
  log("[ai] resolved models per task", resolved);
}

export interface IssueSummaryComment {
  author: string | null;
  createdAt: string;
  body: string;
}

export interface IssueSummaryPull {
  number: number;
  state: string;
  merged: boolean;
}

export interface IssueSummaryInput {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  assignee: string | null;
  state: string;
  comments: IssueSummaryComment[];
  pulls: IssueSummaryPull[];
}

export interface ProgressInput {
  confidence: number | null; // momentum (flow-only)
  confidenceLabel: string;
  sampleSize: number;
  atRisk: RiskItem[];
  flowDistribution: Record<string, number>;
  masterFilter: { include: string[]; exclude: string[] };
  currentPeriod: { month: string; week: string };
  schedule: ScheduleHealth;
  closedThisMonth: number;
  closedLastMonth: number;
  roadmap: RoadmapTimeline;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + " [truncated]" : s;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const days = Math.max(0, Math.round((Date.now() - t) / 86400000));
  return `${days}d ago`;
}

function buildIssueUserText(input: IssueSummaryInput): string {
  const lines: string[] = [];
  lines.push(`Title: ${input.title}`);
  lines.push(`State: ${input.state}`);
  lines.push(`Assignee: ${input.assignee ?? "unassigned"}`);
  lines.push(`Labels: ${input.labels.join(", ") || "(none)"}`);
  lines.push(`Comment count: ${input.comments.length}`);
  lines.push("");
  lines.push("Body:");
  lines.push(truncate(input.body, 4000) || "(empty)");
  if (input.pulls.length > 0) {
    lines.push("");
    lines.push("Linked PRs:");
    for (const p of input.pulls) {
      lines.push(`#${p.number} ${p.merged ? "merged" : p.state}`);
    }
  }
  const last5 = input.comments.slice(-5);
  if (last5.length > 0) {
    lines.push("");
    lines.push("Last comments:");
    for (const c of last5) {
      lines.push(`@${c.author ?? "unknown"} (${relTime(c.createdAt)}): ${truncate(c.body, 300)}`);
    }
  }
  return lines.join("\n");
}

function buildProgressUserText(input: ProgressInput): string {
  const lines: string[] = [];
  const conf =
    input.confidence === null ? "no plan" : `${input.confidence}% (${input.confidenceLabel})`;
  lines.push(`Momentum (flow-only): ${conf}`);
  const sched = input.schedule;
  const onTime = sched.onTime === null ? "—" : `${sched.onTime}%`;
  lines.push(
    `Schedule: on-time ${onTime} · status ${sched.status} · committed ${sched.committed} · overdue ${sched.overdue} · due-now-not-moving ${sched.dueSoonAtRisk}`,
  );
  lines.push(`Closed issues: this month ${input.closedThisMonth} · last month ${input.closedLastMonth}`);
  lines.push(`Sample size: ${input.sampleSize}`);
  lines.push(
    `Master filter: include=[${input.masterFilter.include.join(", ")}] exclude=[${input.masterFilter.exclude.join(", ")}]`,
  );
  lines.push(`Current period: month=${input.currentPeriod.month} week=${input.currentPeriod.week}`);
  const flowParts = Object.keys(input.flowDistribution)
    .sort()
    .map((k) => `${k} ${input.flowDistribution[k]}`);
  lines.push(`Flow mix: ${flowParts.join(" · ") || "(empty)"}`);
  lines.push("");
  lines.push(
    `Roadmap timeline (${input.roadmap.granularity}) — ${input.roadmap.overdueOpen} open item(s) overdue:`,
  );
  for (const p of input.roadmap.periods) {
    lines.push(
      `  ${p.label}${p.isCurrent ? " (current)" : ""}: ${p.planned} planned · ${p.done} done · ${p.atRisk} at risk`,
    );
  }
  lines.push("");
  lines.push(`At-risk (${input.atRisk.length}):`);
  const top = input.atRisk.slice(0, 50);
  const nums = top.map((r) => r.issueNumber);
  const accountsByIssue = loadAccountsForIssues(nums);
  for (const r of top) {
    // Map internal severity (1=low … 3=high) to human labels the model uses.
    const sev = r.severity === 3 ? "critical" : r.severity === 2 ? "high" : "medium";
    const accounts = accountsByIssue.get(r.issueNumber);
    const acctSuffix = accounts && accounts.length > 0 ? ` · accounts: ${accounts.join(", ")}` : "";
    const effSuffix = r.effort
      ? ` · effort: ${r.effort}${r.effortSource === "estimate" ? " (est)" : ""}`
      : "";
    lines.push(`[${sev}] #${r.issueNumber} ${r.title} — ${r.reason}${effSuffix}${acctSuffix}`);
  }
  return lines.join("\n");
}

async function callChat(
  task: AiTask,
  system: string,
  user: string,
  model: string,
  workspaceId?: number,
): Promise<string> {
  const resp = await runChat(
    task,
    model,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    workspaceId,
  );
  const text = resp.choices[0]?.message?.content ?? "";
  const cleaned = cleanMarkdown(text).trim();
  if (!cleaned) {
    throw new Error(`AI returned empty response (model: ${model})`);
  }
  return cleaned;
}

// Models occasionally bold things we explicitly don't want bolded
// (issue references in particular). Strip those marks before saving.
function cleanMarkdown(s: string): string {
  // **#42** → #42 (issue refs should not be bold; our IssueRef chip styles them)
  let out = s.replace(/\*\*(#\d+)\*\*/g, "$1");
  // **#42 (Xray parity)** → #42 (Xray parity) — bold wrapping a whole bullet/phrase that starts with #NNN
  out = out.replace(/\*\*(#\d+[^*]*?)\*\*/g, "$1");
  return out;
}

const EFFORT_TAG_RE = /\[effort:\s*(lightning|incremental|foundation)\s*\]\s*$/i;

// The summary prompt appends a trailing `[effort: …]` line; split it off the prose.
function splitEffort(text: string): { summary: string; effort: EffortRating | null } {
  const m = EFFORT_TAG_RE.exec(text);
  if (!m || m.index === undefined || !m[1]) return { summary: text.trim(), effort: null };
  return { summary: text.slice(0, m.index).trim(), effort: m[1].toLowerCase() as EffortRating };
}

export async function summarizeIssue(
  input: IssueSummaryInput,
  workspaceId?: number,
): Promise<{ summary: string; model: string; effort: EffortRating | null }> {
  const model = aiModelFor("summary", workspaceId);
  const raw = await callChat("summary", SUMMARY_SYSTEM, buildIssueUserText(input), model, workspaceId);
  const { summary, effort } = splitEffort(raw);
  return { summary, model, effort };
}

export async function analyzeProgress(
  input: ProgressInput,
  workspaceId?: number,
): Promise<{ analysis: string; model: string }> {
  const model = aiModelFor("progress", workspaceId);
  const analysis = await callChat("progress", PROGRESS_SYSTEM, buildProgressUserText(input), model, workspaceId);
  return { analysis, model };
}

// ─────────────── PM ACTIONS (rank + phrase) ───────────────

// The AI half of the hybrid: it reorders the deterministic candidates by PM priority,
// drops clear false positives, and rewrites each `action` line. It cannot add issues —
// `applyRanking` keeps only candidates that actually exist, so a hallucinated number is ignored.
export interface PmActionRank {
  issueNumber: number;
  action: string;
}

function buildPmActionsUserText(candidates: PmActionItem[]): string {
  const lines: string[] = ["Candidates:"];
  for (const c of candidates) {
    lines.push(`[${c.category}] #${c.issueNumber} ${c.title} — ${c.reason}`);
  }
  return lines.join("\n");
}

function parsePmActionsJson(text: string): PmActionRank[] {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = trimmed.indexOf("{");
  if (first > 0) trimmed = trimmed.slice(first);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const items = (parsed as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const out: PmActionRank[] = [];
  for (const x of items) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const n = typeof o.issue === "number" ? o.issue : Number(o.issue);
    const action = typeof o.action === "string" ? o.action.trim() : "";
    if (Number.isInteger(n) && n > 0 && action) out.push({ issueNumber: n, action });
  }
  return out;
}

// Apply the AI ranking to the live candidate set: keep only ranked issues that are still
// real candidates, in the AI's order, with the AI's action text. Returns the reordered items.
export function applyPmActionRanking(
  candidates: PmActionItem[],
  ranking: PmActionRank[],
): PmActionItem[] {
  const byNum = new Map(candidates.map((c) => [c.issueNumber, c]));
  const out: PmActionItem[] = [];
  const seen = new Set<number>();
  for (const r of ranking) {
    const c = byNum.get(r.issueNumber);
    if (!c || seen.has(r.issueNumber)) continue;
    seen.add(r.issueNumber);
    out.push({ ...c, action: r.action });
  }
  return out;
}

export async function rankPmActions(
  candidates: PmActionItem[],
  workspaceId?: number,
): Promise<{ ranking: PmActionRank[]; model: string }> {
  const model = aiModelFor("progress", workspaceId);
  const user = buildPmActionsUserText(candidates);
  let text = "";
  try {
    const resp = await runChat(
      "progress",
      model,
      {
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PM_ACTIONS_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  } catch {
    const resp = await runChat(
      "progress",
      model,
      {
        messages: [
          { role: "system", content: PM_ACTIONS_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  }
  return { ranking: parsePmActionsJson(text), model };
}

// ─────────────── ACCOUNT READ ───────────────

export interface AccountReadSignal {
  date: string | null;
  type: string | null;
  confidence: string | null;
  title: string;
  excerpt: string;
}

export interface AccountReadInput {
  displayName: string;
  signals: AccountReadSignal[];
  caresAboutIssues: number[];
}

function buildAccountReadUserText(input: AccountReadInput): string {
  const lines: string[] = [];
  lines.push(`Account: ${input.displayName}`);
  lines.push(`Signal count: ${input.signals.length}`);
  if (input.caresAboutIssues.length > 0) {
    lines.push(`Referenced issues: ${input.caresAboutIssues.map((n) => `#${n}`).join(", ")}`);
  }
  lines.push("");
  lines.push("Signals (newest first):");
  for (const s of input.signals) {
    const datePart = s.date ?? "no date";
    const typePart = s.type ?? "unknown";
    const confPart = s.confidence ?? "unknown";
    lines.push(`[${datePart}] [${typePart}] [${confPart}] ${s.title}`);
    if (s.excerpt) lines.push(`  ${truncate(s.excerpt, 400)}`);
  }
  return lines.join("\n");
}

// Uses "summary" model for account-read — avoids schema changes, same quality tier.
export async function accountRead(
  input: AccountReadInput,
  workspaceId?: number,
): Promise<{ content: string; model: string }> {
  const model = aiModelFor("summary", workspaceId);
  const content = await callChat("summary", ACCOUNT_READ_SYSTEM, buildAccountReadUserText(input), model, workspaceId);
  return { content, model };
}

// ─────────────── MILESTONE RELEASE NOTES ───────────────

export interface ReleaseNotesIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: "open" | "closed";
  mergedPrs: string[]; // titles of merged PRs linked to this issue — concrete "what shipped"
}

export interface ReleaseNotesInput {
  milestone: string;
  dueOn: string | null;
  issues: ReleaseNotesIssue[]; // full milestone scope: shipped (closed) + in-progress (open)
}

function buildReleaseNotesUserText(input: ReleaseNotesInput): string {
  const lines: string[] = [];
  lines.push(`Milestone: ${input.milestone}`);
  if (input.dueOn) lines.push(`Due: ${input.dueOn.slice(0, 10)}`);
  const shipped = input.issues.filter((i) => i.state === "closed").length;
  lines.push(`Shipped: ${shipped}, in progress: ${input.issues.length - shipped}`);
  lines.push("");
  for (const i of input.issues) {
    const labelPart = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
    const stateTag = i.state === "closed" ? "shipped" : "in progress";
    lines.push(`#${i.number} ${i.title}${labelPart} (${stateTag})`);
    if (i.body) lines.push(`  ${truncate(i.body, 2000)}`);
    if (i.mergedPrs.length > 0) {
      lines.push(`  Shipped via: ${i.mergedPrs.map((t) => `"${t}"`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

// Has its own task model override (ai_model_release); falls back to AI_MODEL env.
export async function releaseNotes(
  input: ReleaseNotesInput,
  workspaceId?: number,
): Promise<{ content: string; model: string }> {
  const model = aiModelFor("release", workspaceId);
  const content = await callChat("release", RELEASE_NOTES_SYSTEM, buildReleaseNotesUserText(input), model, workspaceId);
  return { content, model };
}

// ─────────────── INSIGHT EXTRACTION ───────────────

export interface CapturedInsight {
  rawText: string;
  sourceType: string;
  sourceUrl: string | null;
  hint: string | null;
}

export interface ExtractedInsight {
  title: string | null;
  type: string | null;
  confidence: string | null;
  accounts: string[];
  relatedIssueHints: string[];
  keyQuotes: string[];
  bodyDraft: string | null;
}

const EMPTY_EXTRACTED: ExtractedInsight = {
  title: null,
  type: null,
  confidence: null,
  accounts: [],
  relatedIssueHints: [],
  keyQuotes: [],
  bodyDraft: null,
};

const VALID_TYPES = new Set(["customer", "data", "competitive", "support", "survey", "market"]);
const VALID_CONFIDENCE = new Set(["verified", "likely", "rumor"]);

function strArrField(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t) out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
}

function parseExtractedJson(text: string): ExtractedInsight {
  let trimmed = text.trim();
  // Tolerate a code fence even though the prompt forbids it.
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // Defensive: if model emitted prose before JSON, slice from first `{`.
  const first = trimmed.indexOf("{");
  if (first > 0) trimmed = trimmed.slice(first);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ...EMPTY_EXTRACTED };
  }
  if (!parsed || typeof parsed !== "object") return { ...EMPTY_EXTRACTED };
  const o = parsed as Record<string, unknown>;
  const titleRaw = typeof o.title === "string" ? o.title.trim() : "";
  const typeRaw = typeof o.type === "string" ? o.type.trim().toLowerCase() : "";
  const confRaw = typeof o.confidence === "string" ? o.confidence.trim().toLowerCase() : "";
  const bodyRaw = typeof o.body_draft === "string" ? o.body_draft : null;
  return {
    title: titleRaw || null,
    type: VALID_TYPES.has(typeRaw) ? typeRaw : null,
    confidence: VALID_CONFIDENCE.has(confRaw) ? confRaw : null,
    accounts: strArrField(o.accounts, 20),
    relatedIssueHints: strArrField(o.related_issue_hints, 5),
    keyQuotes: strArrField(o.key_quotes, 5),
    bodyDraft: bodyRaw ? cleanMarkdown(bodyRaw).trim() : null,
  };
}

function buildExtractUserText(c: CapturedInsight): string {
  const lines: string[] = [];
  lines.push(`Source type: ${c.sourceType}`);
  if (c.sourceUrl) lines.push(`Source URL: ${c.sourceUrl}`);
  if (c.hint) lines.push(`Hint: ${c.hint}`);
  lines.push("");
  lines.push("--- RAW ---");
  lines.push(truncate(c.rawText, 8000));
  return lines.join("\n");
}

export async function extractInsight(
  captured: CapturedInsight,
  workspaceId?: number,
): Promise<{ extracted: ExtractedInsight; model: string }> {
  const model = aiModelFor("extract", workspaceId);
  const user = buildExtractUserText(captured);
  let text = "";
  try {
    const resp = await runChat(
      "extract",
      model,
      {
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_INSIGHT_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  } catch {
    const resp = await runChat(
      "extract",
      model,
      {
        messages: [
          { role: "system", content: EXTRACT_INSIGHT_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  }
  const extracted = parseExtractedJson(text);
  return { extracted, model };
}

// ─────────────── MERGE SYNTHESIS ───────────────

export interface MergeInsightSource {
  title: string;
  type: string | null;
  confidence: string | null;
  date: string | null;
  body: string;
  accounts: string[];
  relatedIssues: number[];
  isDraft: boolean;
}

export interface MergeSynthesisInput {
  survivor: MergeInsightSource;
  victims: MergeInsightSource[];
}

export interface MergedInsight {
  title: string | null;
  type: string | null;
  confidence: string | null;
  accounts: string[];
  relatedIssues: number[];
  body: string | null;
}

function intArrField(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    if (Number.isInteger(n) && n > 0) out.push(n);
    if (out.length >= max) break;
  }
  return [...new Set(out)];
}

function parseMergedJson(text: string): MergedInsight {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = trimmed.indexOf("{");
  if (first > 0) trimmed = trimmed.slice(first);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { title: null, type: null, confidence: null, accounts: [], relatedIssues: [], body: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { title: null, type: null, confidence: null, accounts: [], relatedIssues: [], body: null };
  }
  const o = parsed as Record<string, unknown>;
  const titleRaw = typeof o.title === "string" ? o.title.trim() : "";
  const typeRaw = typeof o.type === "string" ? o.type.trim().toLowerCase() : "";
  const confRaw = typeof o.confidence === "string" ? o.confidence.trim().toLowerCase() : "";
  const bodyRaw = typeof o.body === "string" ? o.body : null;
  return {
    title: titleRaw || null,
    type: VALID_TYPES.has(typeRaw) ? typeRaw : null,
    confidence: VALID_CONFIDENCE.has(confRaw) ? confRaw : null,
    accounts: strArrField(o.accounts, 30),
    relatedIssues: intArrField(o.related_issues, 50),
    body: bodyRaw ? cleanMarkdown(bodyRaw).trim() : null,
  };
}

function describeSource(s: MergeInsightSource, label: string): string {
  const lines: string[] = [];
  lines.push(`### ${label}${s.isDraft ? " (draft)" : ""}: ${s.title}`);
  if (s.type) lines.push(`Type: ${s.type}`);
  if (s.confidence) lines.push(`Confidence: ${s.confidence}`);
  if (s.date) lines.push(`Date: ${s.date}`);
  if (s.accounts.length > 0) lines.push(`Accounts: ${s.accounts.join(", ")}`);
  if (s.relatedIssues.length > 0) lines.push(`Related issues: ${s.relatedIssues.map((n) => `#${n}`).join(", ")}`);
  lines.push("Body:");
  lines.push(truncate(s.body, 4000) || "(empty)");
  return lines.join("\n");
}

function buildMergeUserText(input: MergeSynthesisInput): string {
  const parts: string[] = [];
  parts.push(describeSource(input.survivor, "SURVIVOR (keep)"));
  input.victims.forEach((v, i) => {
    parts.push("");
    parts.push(describeSource(v, `VICTIM ${i + 1} (fold in)`));
  });
  return parts.join("\n");
}

export async function synthesizeMerge(
  input: MergeSynthesisInput,
  workspaceId?: number,
): Promise<{ merged: MergedInsight; model: string }> {
  const model = aiModelFor("extract", workspaceId);
  const user = buildMergeUserText(input);
  let text = "";
  try {
    const resp = await runChat(
      "extract",
      model,
      {
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: MERGE_INSIGHTS_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  } catch {
    const resp = await runChat(
      "extract",
      model,
      {
        messages: [
          { role: "system", content: MERGE_INSIGHTS_SYSTEM },
          { role: "user", content: user },
        ],
      },
      workspaceId,
    );
    text = resp.choices[0]?.message?.content ?? "";
  }
  return { merged: parseMergedJson(text), model };
}
