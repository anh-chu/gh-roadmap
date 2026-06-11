// Shared between api/ and web/. Mirrors what the API serialises in routes/issues.ts.

export type IssueState = "open" | "closed";

export interface ApiIssue {
  number: number;
  title: string;
  body: string | null;
  state: IssueState;
  assignee: string | null;
  milestone: string | null;
  milestoneDue: string | null;
  labels: string[];
  updatedAt: string;
  plannedMonth: string | null;
  plannedWeek: string | null;
  roadmapNotes: string | null;
  position: number | null;
  isTodo: boolean;
}

export interface ApiComment {
  id: number;
  issue_number: number;
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

// A file read from the issues repo for in-app (read-only) viewing.
export interface RepoFile {
  path: string;
  ref: string | null;
  content: string;
  sha: string;
  size: number;
  htmlUrl: string | null;
}

export type BucketingField = "none" | "label" | "assignee" | "milestone";

export type RangeGranularity = "week" | "month" | "quarter";

export interface MasterFilter {
  include: string[];
  exclude: string[];
}

export interface WorkspaceConfig {
  bucketingField: BucketingField;
  bucketingValue: string;
  masterFilterInclude: string[];
  masterFilterExclude: string[];
  rangeGranularity: RangeGranularity;
  rangeCount: number;
  rangeOffset: number;
  todoStaleDays: number;
  flowShippingHours: number;
  flowReviewDays: number;
  flowCodeDays: number;
  flowDiscussionDays: number;
  flowStallDays: number;
  flowColdDays: number;
  flowFreshDays: number;
  pinMetaCols: boolean;
  predictPrStaleDays: number;
  predictPrMinAge: number;
  predictReviewWaitDays: number;
  predictPromiseConfidenceMin: number; // stored as percent 0..100
  predictReplyOverdueHours: number;
  aiModelSummary: string | null;
  aiModelProgress: string | null;
  aiModelExtract: string | null;
  updatedAt: string;
}

export interface BucketsInfo {
  field: BucketingField;
  value: string;
  options: string[];
}

// App-level authority (layer 2): viewer = read-only, editor = all app writes,
// admin = editor + role management + AI settings + data export/import.
export type Role = "viewer" | "editor" | "admin";

export interface AuthUser {
  email: string;
  name: string;
  picture: string | null;
  role: Role;
  isAdmin: boolean;
}

// A row in the users table (role management — admin Users panel).
export interface AppUser {
  email: string;
  name: string | null;
  role: Role;
  // true when the email is in ADMIN_EMAILS — immutable bootstrap admin, role can't be edited in-app.
  envAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthMe {
  // false when GOOGLE_CLIENT_ID/SECRET are unset — app runs in single-user localhost mode.
  authEnabled: boolean;
  // null when auth is enabled but the request has no valid session (show login screen).
  user: AuthUser | null;
}

export interface MetaResponse {
  rateLimitRemaining: number;
  rateLimitLimit: number;
  rateLimitReset: number;
  lastSyncAt: string | null;
  openCount: number;
  closedCount: number;
  buckets: BucketsInfo;
  // Webhook events whose processed_at falls on the local DB "today".
  webhookEventsToday: number;
  // 8-element series: count of open issues at the end of each of the last 8 weeks (oldest first).
  openHistoryWeekly: number[];
  // Closed-issue counts for the current and previous calendar month (UTC).
  closedThisMonth: number;
  closedLastMonth: number;
  // GitHub login of the token's user. Null when sync is unconfigured or lookup failed.
  currentUser: string | null;
  // AI_MODEL env default — used as fallback when per-task config is unset. Null when env is unset.
  aiEnvDefault: string | null;
  // Deprecated: kept one release as alias of buckets.options when field='label'+value='area'.
  // Remove once frontend transition lands.
  areas: string[];
  // "owner/repo" of the issues repo, for building GitHub web links. Null when sync unconfigured.
  repoSlug: string | null;
}

// Full repo label + milestone catalog (all repo values, not just in-use).
export interface CatalogResponse {
  labels: string[];
  milestones: string[];
}

export interface IssuePatchBody {
  title?: string;
  body?: string;
  state?: IssueState;
  labels?: string[];
  assignee?: string | null;
  milestone?: string | null;
  // Optimistic-concurrency guard for body edits on a shared instance. When set,
  // the server rejects the body write with 409 if the stored body no longer
  // matches what the editor loaded (someone else edited it first).
  baseBody?: string | null;
}

export interface RoadmapPatchBody {
  plannedMonth?: string | null;
  plannedWeek?: string | null;
  roadmapNotes?: string | null;
  position?: number | null;
  isTodo?: boolean;
}

// UI view-model — derived from ApiIssue with area extracted from labels.
export interface Issue {
  num: number;
  title: string;
  body: string | null;
  area: string;
  month: string | null;
  week: string | null;
  state: IssueState;
  assignee: string;
  milestone: string | null;
  milestoneDue: string | null;
  comments: number;
  labels: string[];
  updatedAt: string;
  isTodo: boolean;
  effort: EffortRating | null; // from an `effort:*` label, else null
}

export interface ApiPull {
  number: number;
  title: string;
  state: IssueState;
  merged: boolean;
  mergedAt: string | null;
  author: string | null;
  createdAt: string | null;
  updatedAt: string;
  closedAt: string | null;
  linkedIssues: number[];
}

export interface Pull {
  number: number;
  title: string;
  state: IssueState;
  merged: boolean;
  mergedAt: string | null;
  author: string | null;
  updatedAt: string;
  linkedIssues: number[];
}

export function pullFromApi(p: ApiPull): Pull {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    merged: p.merged,
    mergedAt: p.mergedAt,
    author: p.author,
    updatedAt: p.updatedAt,
    linkedIssues: Array.isArray(p.linkedIssues) ? p.linkedIssues : [],
  };
}

// ─────────────── FLOW STATE ───────────────

export type FlowState =
  | "shipping"
  | "in-review"
  | "in-code"
  | "discussing"
  | "stalled"
  | "cold"
  | "fresh"
  | "closed";

export interface FlowResult {
  state: FlowState;
  score: number;
  signals: string[];
}

export type FlowResultMap = Record<number, FlowResult>;

export type FlowRuleCategory =
  | "flow-shipping"
  | "flow-in-review"
  | "flow-in-code"
  | "flow-discussing"
  | "flow-stalled"
  | "flow-cold"
  | "flow-fresh";

export interface FlowRuleThreshold {
  key: FlowThresholdKey;
  label: string;
  min: number;
  max: number;
  value: number;
}

export interface FlowRule {
  category: FlowRuleCategory;
  label: string;
  description: string;
  thresholds: FlowRuleThreshold[];
  example: string;
}

export type FlowThresholdKey =
  | "flowShippingHours"
  | "flowReviewDays"
  | "flowCodeDays"
  | "flowDiscussionDays"
  | "flowStallDays"
  | "flowColdDays"
  | "flowFreshDays";

export interface FlowThresholds {
  flowShippingHours: number;
  flowReviewDays: number;
  flowCodeDays: number;
  flowDiscussionDays: number;
  flowStallDays: number;
  flowColdDays: number;
  flowFreshDays: number;
}

export interface ProjectStatusOption {
  id: string;
  name: string;
}

export interface ProjectSummary {
  number: number;
  title: string;
  statusOptions: ProjectStatusOption[];
  itemCount: number;
}

export interface ProjectItem {
  itemId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  contentNumber: number | null;
  contentRepo: string | null;
  contentTitle: string;
  statusOptionId: string | null;
  statusLabel: string | null;
  assignees: string[];
}

export interface ProjectFull {
  number: number;
  title: string;
  statusFieldId: string | null;
  statusOptions: ProjectStatusOption[];
  items: ProjectItem[];
  lastSyncedAt: string;
}

// ─────────────── HEALTH DASHBOARD ───────────────

export interface RiskItem {
  issueNumber: number;
  title: string;
  reason: string;
  severity: 1 | 2 | 3;
  kind: "reactive" | "preventative";
  category: string;
  // Rough size. A confirmed effort:* label adjusts severity; an AI estimate only
  // nudges ordering. Optional so historical snapshots / predictive items can omit it.
  effort?: EffortRating | null;
  effortSource?: "label" | "estimate" | null;
}

// Schedule (timeline) health — derived from planned dates, distinct from the
// flow-only "momentum" confidence number.
export type ScheduleStatus = "on-track" | "watch" | "at-risk" | "off-track" | "no-plan";

export interface ScheduleHealth {
  onTime: number | null; // % of committed open work projected to land on/before its date; null when nothing committed
  status: ScheduleStatus;
  committed: number; // open issues with a planned period
  overdue: number; // committed & past their planned period
  dueSoonAtRisk: number; // due this period & not moving
}

export interface HealthLive {
  asOf: "now";
  confidence: number | null; // momentum (flow-only), over judgeable issues only
  sampleSize: number; // planned issues with real flow signal (the momentum denominator)
  noSignal: number; // planned issues excluded from momentum — no PR/event/comment to judge
  atRisk: RiskItem[];
  schedule: ScheduleHealth;
}

export interface HealthSnapshotSummary {
  date: string;
  confidence: number | null;
  onTime: number | null; // schedule adherence % for that day (null on pre-migration rows)
  sampleSize: number;
  atRiskCount: number;
}

export interface HealthHistorical {
  asOf: string;
  confidence: number | null;
  sampleSize: number;
  noSignal?: number;
  atRisk: RiskItem[];
  schedule: ScheduleHealth;
}

// ─────────────── AI ───────────────

// Rough size/effort, reusing the repo's `effort:*` label taxonomy.
export type EffortRating = "lightning" | "incremental" | "foundation";

export interface AiSummary {
  summary: string;
  model: string;
  generatedAt: string;
  fromCache: boolean;
  effort: EffortRating | null; // AI-estimated; a human effort:* label takes precedence in the UI
}

export interface AiProgress {
  analysis: string;
  model: string;
  generatedAt: string;
  fromCache: boolean;
}

// ─────────────── PM ACTIONS (what needs the PM) ───────────────

// Distinct axis from at-risk: at-risk = work is in trouble (nudge eng);
// pm-action = PM craft work this item owes (spec depth, release artifacts, a call).
export type PmActionCategory = "thin-spec" | "pre-release" | "post-release" | "decision-owed";

export interface PmActionItem {
  issueNumber: number;
  title: string;
  category: PmActionCategory;
  reason: string; // deterministic evidence ("body 40 chars, no acceptance criteria")
  action: string; // the suggested next step; AI may refine, detector supplies a default
}

// Hybrid surface: detectors produce candidates (auditable, never invented); when AI is
// configured it reorders by PM priority and rewrites `action`, and may drop false positives
// (it can subtract, never add). `aiRanked` is false when AI is off — raw detector output.
export interface PmActionsResponse {
  items: PmActionItem[];
  aiRanked: boolean;
  model: string | null;
  generatedAt: string | null;
}

// ─────────────── MORNING BRIEF ───────────────

export type BriefAtRiskSeverity = { critical: number; high: number; medium: number };
export type BriefFlowMix = Record<FlowState, number>;
export type BriefPeriod = { done: number; active: number; stalled: number; total: number };

export interface BriefSnapshot {
  asOf: string;
  confidence: number | null; // momentum (flow-only)
  confidenceLabel: "on track" | "mixed" | "at risk" | "no plan";
  onTime: number | null; // schedule adherence %
  scheduleStatus: ScheduleStatus;
  sampleSize: number;
  atRisk: BriefAtRiskSeverity;
  atRiskFoundation: number; // count of at-risk items sized "foundation" (label or estimate)
  flowMix: BriefFlowMix;
  currentPeriod: BriefPeriod;
  queue: { todo: number; backlog: number };
  crossPodRefs: Array<{ scope: string; count: number }>;
}

export interface BriefChangeRef { num: number; title: string; reason?: string }
export interface BriefActivityRef { num: number; title: string; lastActor: string; commentCount: number }
export interface BriefPullRef { prNum: number; title: string; linkedIssues: number[] }
export interface BriefIssueRef { num: number; title: string; author: string }

export interface BriefChanges {
  since: string | null;
  cappedAt: string | null;
  enteredAtRisk: BriefChangeRef[];
  exitedAtRisk: BriefChangeRef[];
  resolved: Array<{ num: number; title: string; closedAt: string }>;
  newActivity: BriefActivityRef[];
  prsMerged: BriefPullRef[];
  newIssues: BriefIssueRef[];
  totals: {
    enteredAtRisk: number;
    exitedAtRisk: number;
    resolved: number;
    newActivity: number;
    prsMerged: number;
    newIssues: number;
  };
}

// ─────────────── INSIGHTS ───────────────

export interface ApiInsightAccountRef {
  slug: string;
  name: string;
}

export interface ApiInsightListItem {
  path: string;
  slug: string;
  title: string;
  type: string | null;
  date: string | null;
  owner: string | null;
  confidence: string | null;
  excerpt: string;
  accounts: ApiInsightAccountRef[];
  linkedIssues: number[];
  updatedAt: string;
}

export interface ApiInsightDetail extends ApiInsightListItem {
  bodyMarkdown: string;
  sources: string[];
}

export interface ApiInsightAccount {
  slug: string;
  name: string;
  insightCount: number;
  latestDate: string | null;
}

export type InsightDraftState = "pending" | "published" | "merged" | "discarded";
export type InsightDupKind = "exact" | "similar";

export interface ApiInsightDraft {
  id: number;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  sourceUrl: string | null;
  rawText: string;
  hint: string | null;
  title: string | null;
  type: string | null;
  date: string | null;
  owner: string | null;
  confidence: string | null;
  accounts: string[];
  relatedIssues: number[];
  keyQuotes: string[];
  bodyDraft: string | null;
  state: InsightDraftState;
  prUrl: string | null;
  prNumber: number | null;
  publishedPath: string | null;
  discardedAt: string | null;
  // Dedup flag, computed once at capture. null = no likely duplicate found.
  dupOf: number | null;
  dupKind: InsightDupKind | null;
  dupScore: number | null;
}

export interface InsightCapturePayload {
  sourceType: string;
  sourceUrl?: string;
  rawText: string;
  hint?: string;
}

export interface InsightDraftPatch {
  title?: string | null;
  type?: string | null;
  date?: string | null;
  owner?: string | null;
  confidence?: string | null;
  accounts?: string[];
  relatedIssues?: number[];
  keyQuotes?: string[];
  bodyDraft?: string | null;
}

// ─────────────── INSIGHT OPS (retire / consolidate) ───────────────

export type InsightOpKind = "delete" | "merge";
export type InsightOpState = "open" | "merged" | "closed";

export interface ApiInsightOp {
  id: number;
  kind: InsightOpKind;
  targetPath: string; // delete: file removed; merge: survivor file
  victimPaths: string[]; // merge: other insight files deleted
  victimDraftIds: number[]; // merge: drafts folded in
  prUrl: string | null;
  prNumber: number | null;
  state: InsightOpState;
  createdAt: string;
  updatedAt: string;
}

export interface InsightMergePayload {
  survivorSlug: string;
  victimPaths?: string[];
  victimDraftIds?: number[];
  // Edited consolidated content from the merge preview. When present, the PR uses these
  // verbatim; when absent, the server falls back to a mechanical stitch.
  title?: string;
  type?: string;
  confidence?: string;
  accounts?: string[];
  relatedIssues?: number[];
  body?: string;
}

// AI-synthesized (or mechanically-stitched) consolidated content, shown in the merge
// preview for the PM to edit before opening the PR. Not persisted server-side.
export interface InsightMergePreview {
  title: string | null;
  type: string | null;
  confidence: string | null;
  accounts: string[];
  relatedIssues: number[];
  body: string | null;
}

// ─────────────── ACCOUNTS (Insights v2) ───────────────

// Provenance: where an account came from. 'signal' = derived from insights only,
// 'crm' = ingested CRM profile with no signal yet, 'both' = has profile + signals.
export type AccountSource = "signal" | "crm" | "both";

// Structured mini-CRM profile. All fields optional — hydrated by ingest or manual entry.
// `updatedAt` is null until a profile is written (also the index-visibility marker server-side).
export interface AccountProfile {
  arr: number | null;
  renewalDate: string | null;
  owner: string | null;
  tier: string | null;
  segment: string | null;
  region: string | null;
  industry: string | null;
  website: string | null;
  domain: string | null;
  salesforceId: string | null;
  notes: string | null;
  updatedAt: string | null;
}

// Editable subset for PATCH /api/accounts/:slug/profile and ingest rows. Any field present
// is written; an explicit null clears it. `displayName` only meaningful on ingest (create/rename).
export type AccountProfilePatch = Partial<Omit<AccountProfile, "updatedAt">>;

// One row for bulk JSON ingest. Identified by `slug` (preferred) or `name` (slugified server-side).
export interface AccountIngestRow extends AccountProfilePatch {
  slug?: string;
  name?: string;
  displayName?: string;
}

export interface AccountIngestResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface Account {
  slug: string;
  displayName: string;
  signalCount: number;
  caresAboutCount: number;
  latestDate: string | null;
  source: AccountSource;
  // Profile summary surfaced in the list row (full profile in AccountDetail).
  arr: number | null;
  tier: string | null;
  owner: string | null;
  renewalDate: string | null;
}

export interface AccountTimelineItem {
  path: string;
  slug: string;
  title: string;
  type: string | null;
  date: string | null;
  confidence: string | null;
  excerpt: string;
  linkedIssues: number[];
}

export interface AccountCaresAboutIssue {
  issueNumber: number;
  signalCount: number;
}

export interface AccountAiRead {
  content: string;
  model: string;
  generatedAt: string;
  fromCache: boolean;
}

export interface AccountDetail {
  slug: string;
  displayName: string;
  source: AccountSource;
  profile: AccountProfile;
  timeline: AccountTimelineItem[];
  caresAbout: AccountCaresAboutIssue[];
  aiRead: AccountAiRead | null;
}

// ─────────────── MANUAL SYNC ───────────────

export interface SyncResult {
  ok: true;
  lastSyncAt: string | null;
  github: { issues: number; comments: number; pulls: number; reviews: number; events: number };
  insights: { scanned: number; added: number; updated: number; removed: number; skipped: number };
}

const EFFORT_RATINGS: readonly EffortRating[] = ["lightning", "incremental", "foundation"];

export function effortFromLabels(labels: string[]): EffortRating | null {
  for (const l of labels) {
    if (l.startsWith("effort:")) {
      const v = l.slice("effort:".length).toLowerCase();
      if ((EFFORT_RATINGS as readonly string[]).includes(v)) return v as EffortRating;
    }
  }
  return null;
}

export function fromApi(r: ApiIssue): Issue {
  const labels = Array.isArray(r.labels) ? r.labels : [];
  const areaLabel = labels.find((l) => l.startsWith("area:"));
  return {
    num: r.number,
    title: r.title,
    body: r.body ?? null,
    area: areaLabel ? areaLabel.slice("area:".length) : "unassigned",
    month: r.plannedMonth ?? null,
    week: r.plannedWeek ?? null,
    state: r.state,
    assignee: r.assignee ?? "unassigned",
    milestone: r.milestone ?? null,
    milestoneDue: r.milestoneDue ?? null,
    comments: 0,
    labels,
    updatedAt: r.updatedAt,
    isTodo: !!r.isTodo,
    effort: effortFromLabels(labels),
  };
}
