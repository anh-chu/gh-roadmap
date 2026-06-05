import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccountsForIssues } from "./insights.js";
import { db } from "./db.js";
import type { RoadmapTimeline } from "./health.js";
import type { EffortRating, RiskItem, ScheduleHealth } from "../../shared/types.js";

export type AiTask = "summary" | "progress" | "extract";

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
const MERGE_INSIGHTS_SYSTEM = loadPrompt("merge-insights.md");
const ACCOUNT_READ_SYSTEM = loadPrompt("account-read.md");

let _client: OpenAI | null = null;
let _disabledReason: string | null = null;

type TaskModelRow = {
  ai_model_summary: string | null;
  ai_model_progress: string | null;
  ai_model_extract: string | null;
};

function readTaskModels(): TaskModelRow {
  try {
    const row = db()
      .prepare(
        "SELECT ai_model_summary, ai_model_progress, ai_model_extract FROM workspace_config WHERE id = 1",
      )
      .get() as TaskModelRow | undefined;
    return row ?? { ai_model_summary: null, ai_model_progress: null, ai_model_extract: null };
  } catch {
    // DB not initialised yet — treat as no overrides.
    return { ai_model_summary: null, ai_model_progress: null, ai_model_extract: null };
  }
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function checkConfig(): string | null {
  const base = process.env.AI_BASE_URL;
  if (!base) return "AI not configured — set AI_BASE_URL";
  const envModel = nonEmpty(process.env.AI_MODEL);
  const row = readTaskModels();
  const anyOverride =
    nonEmpty(row.ai_model_summary) || nonEmpty(row.ai_model_progress) || nonEmpty(row.ai_model_extract);
  if (!envModel && !anyOverride) return "AI not configured — set AI_MODEL or a per-task override";
  return null;
}

// Re-evaluate on every call: env is stable but per-task DB overrides change at runtime,
// so a previously-disabled state may flip to enabled once a user sets an override.
function currentReason(): string | null {
  const reason = checkConfig();
  if (reason !== _disabledReason) {
    _disabledReason = reason;
    if (reason) {
      // eslint-disable-next-line no-console
      console.warn(`[ai] disabled: ${reason}`);
    }
  }
  return reason;
}

export function isAiEnabled(): boolean {
  return currentReason() === null;
}

export function aiDisabledReason(): string {
  return currentReason() ?? "AI disabled";
}

function client(): OpenAI {
  if (!isAiEnabled()) throw new Error(aiDisabledReason());
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

export function aiModelFor(task: AiTask): string {
  const row = readTaskModels();
  const override =
    task === "summary"
      ? nonEmpty(row.ai_model_summary)
      : task === "progress"
        ? nonEmpty(row.ai_model_progress)
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
  const tasks: AiTask[] = ["summary", "progress", "extract"];
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

async function callChat(system: string, user: string, model: string): Promise<string> {
  const resp = await client().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = resp.choices[0]?.message?.content ?? "";
  return cleanMarkdown(text).trim();
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
): Promise<{ summary: string; model: string; effort: EffortRating | null }> {
  const model = aiModelFor("summary");
  const raw = await callChat(SUMMARY_SYSTEM, buildIssueUserText(input), model);
  const { summary, effort } = splitEffort(raw);
  return { summary, model, effort };
}

export async function analyzeProgress(
  input: ProgressInput,
): Promise<{ analysis: string; model: string }> {
  const model = aiModelFor("progress");
  const analysis = await callChat(PROGRESS_SYSTEM, buildProgressUserText(input), model);
  return { analysis, model };
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
): Promise<{ content: string; model: string }> {
  const model = aiModelFor("summary");
  const content = await callChat(ACCOUNT_READ_SYSTEM, buildAccountReadUserText(input), model);
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
): Promise<{ extracted: ExtractedInsight; model: string }> {
  const model = aiModelFor("extract");
  const user = buildExtractUserText(captured);
  // Try with response_format first; fall back to plain text if server rejects it.
  let text = "";
  try {
    const resp = await client().chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_INSIGHT_SYSTEM },
        { role: "user", content: user },
      ],
    });
    text = resp.choices[0]?.message?.content ?? "";
  } catch {
    const resp = await client().chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACT_INSIGHT_SYSTEM },
        { role: "user", content: user },
      ],
    });
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
): Promise<{ merged: MergedInsight; model: string }> {
  const model = aiModelFor("extract");
  const user = buildMergeUserText(input);
  let text = "";
  try {
    const resp = await client().chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MERGE_INSIGHTS_SYSTEM },
        { role: "user", content: user },
      ],
    });
    text = resp.choices[0]?.message?.content ?? "";
  } catch {
    const resp = await client().chat.completions.create({
      model,
      messages: [
        { role: "system", content: MERGE_INSIGHTS_SYSTEM },
        { role: "user", content: user },
      ],
    });
    text = resp.choices[0]?.message?.content ?? "";
  }
  return { merged: parseMergedJson(text), model };
}
