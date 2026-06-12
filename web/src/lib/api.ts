// Typed fetch wrappers. All requests go through Vite's dev proxy in dev (server:5173 → api:3000)
// or directly via same-origin in production.
import type {
  Account,
  AccountAiRead,
  AccountDetail,
  AccountProfile,
  AccountProfilePatch,
  AccountIngestRow,
  AccountIngestResult,
  AppUser,
  AuthMe,
  ApiComment,
  ApiInsightAccount,
  ApiInsightDetail,
  ApiInsightDraft,
  ApiInsightListItem,
  ApiInsightOp,
  InsightCapturePayload,
  InsightDraftPatch,
  InsightDraftState,
  InsightMergePayload,
  InsightMergePreview,
  InsightOpState,
  ApiIssue,
  ApiPull,
  AiProgress,
  AiSummary,
  BriefChanges,
  BriefSnapshot,
  FlowResultMap,
  BucketingField,
  HealthHistorical,
  HealthLive,
  HealthSnapshotSummary,
  IssuePatchBody,
  CatalogResponse,
  MetaResponse,
  ProjectFull,
  ProjectItem,
  ProjectSummary,
  RepoFile,
  PmActionsResponse,
  Pull,
  RangeGranularity,
  RoadmapPatchBody,
  SyncResult,
  Workspace,
  WorkspaceConfig,
} from "../../../shared/types";
import { pullFromApi } from "../../../shared/types";

export interface IssueCreatePayload {
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string | null;
}

// GitHub write-identity gate (layer 3). The server is the ONLY gate: write buttons stay
// live everywhere, and a 409 github_not_linked / github_reauth_required from any write
// raises one app-level Connect prompt here — no per-action wiring, no disabled states.
export type GithubConnectReason = "github_not_linked" | "github_reauth_required";
let githubConnectHandler: ((reason: GithubConnectReason) => void) | null = null;
export function setGithubConnectHandler(fn: ((reason: GithubConnectReason) => void) | null): void {
  githubConnectHandler = fn;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = "";
    let errCode = "";
    try {
      const body = (await r.clone().json()) as { error?: string; detail?: string };
      errCode = body.error ?? "";
      detail = body.detail ? ` — ${body.detail}` : body.error ? ` — ${body.error}` : "";
    } catch { /* non-JSON body */ }
    if (r.status === 409 && (errCode === "github_not_linked" || errCode === "github_reauth_required")) {
      githubConnectHandler?.(errCode);
      throw new Error("GitHub account connection required");
    }
    throw new Error(`${r.status} ${r.statusText}${detail}`);
  }
  return (await r.json()) as T;
}

export async function fetchIssues(): Promise<ApiIssue[]> {
  const r = await fetch("/api/issues");
  return jsonOrThrow<ApiIssue[]>(r);
}

export async function fetchMeta(): Promise<MetaResponse> {
  const r = await fetch("/api/meta");
  return jsonOrThrow<MetaResponse>(r);
}

export async function fetchAuthMe(): Promise<AuthMe> {
  const r = await fetch("/api/auth/me");
  return jsonOrThrow<AuthMe>(r);
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

// Disconnect the caller's linked GitHub account (write-identity layer 3).
export async function unlinkGithub(): Promise<void> {
  const r = await fetch("/api/github/unlink", { method: "POST" });
  await jsonOrThrow<{ ok: boolean }>(r);
}

// Role management (admin-only — the Users panel in the header).
export async function fetchUsers(): Promise<AppUser[]> {
  const r = await fetch("/api/users");
  return jsonOrThrow<AppUser[]>(r);
}

export async function patchUserRole(email: string, role: AppUser["role"]): Promise<{ email: string; role: string }> {
  const r = await fetch(`/api/users/${encodeURIComponent(email)}/role`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  return jsonOrThrow<{ email: string; role: string }>(r);
}

// Pre-provision a user (admin-only) before they have signed in.
export async function createUser(email: string, role: AppUser["role"]): Promise<AppUser> {
  const r = await fetch("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  return jsonOrThrow<AppUser>(r);
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  const r = await fetch("/api/catalog");
  return jsonOrThrow<CatalogResponse>(r);
}

export async function postSync(): Promise<SyncResult> {
  const r = await fetch("/api/sync", { method: "POST" });
  return jsonOrThrow<SyncResult>(r);
}

export interface ImportResult {
  imported: Record<string, number>;
  skipped: string[];
}

// Full-DB restore. The file is whatever GET /api/export produced. Replace-all per table.
export async function importData(payload: unknown): Promise<ImportResult> {
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<ImportResult>(r);
}

export async function patchIssue(num: number, body: IssuePatchBody): Promise<ApiIssue> {
  const r = await fetch(`/api/issues/${num}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOrThrow<ApiIssue>(r);
}

export async function patchRoadmap(num: number, body: RoadmapPatchBody): Promise<void> {
  const r = await fetch(`/api/issues/${num}/roadmap`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
}

export async function postComment(num: number, body: string): Promise<ApiComment> {
  const r = await fetch(`/api/issues/${num}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return jsonOrThrow<ApiComment>(r);
}

export async function getComments(num: number): Promise<ApiComment[]> {
  const r = await fetch(`/api/issues/${num}/comments`);
  return jsonOrThrow<ApiComment[]>(r);
}

export async function patchComment(id: number, body: string): Promise<ApiComment> {
  const r = await fetch(`/api/comments/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return jsonOrThrow<ApiComment>(r);
}

export async function deleteComment(id: number): Promise<void> {
  const r = await fetch(`/api/comments/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
}

export async function getConfig(): Promise<WorkspaceConfig> {
  const r = await fetch("/api/config");
  return jsonOrThrow<WorkspaceConfig>(r);
}

export async function patchConfig(payload: {
  bucketingField?: BucketingField;
  bucketingValue?: string;
  masterFilterInclude?: string[];
  masterFilterExclude?: string[];
  rangeGranularity?: RangeGranularity;
  rangeCount?: number;
  rangeOffset?: number;
  todoStaleDays?: number;
  pinMetaCols?: boolean;
  aiModelSummary?: string | null;
  aiModelProgress?: string | null;
  aiModelExtract?: string | null;
}): Promise<WorkspaceConfig> {
  const r = await fetch("/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<WorkspaceConfig>(r);
}

export async function fetchWorkspaces(): Promise<{ workspaces: Workspace[]; activeId: number }> {
  const r = await fetch("/api/workspaces");
  return jsonOrThrow<{ workspaces: Workspace[]; activeId: number }>(r);
}

export async function setActiveWorkspace(id: number): Promise<Workspace> {
  const r = await fetch("/api/workspaces/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return jsonOrThrow<Workspace>(r);
}

export async function createWorkspace(slug: string, name: string): Promise<Workspace> {
  const r = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, name }),
  });
  return jsonOrThrow<Workspace>(r);
}

export async function patchWorkspace(id: number, patch: { name?: string; archived?: boolean }): Promise<Workspace> {
  const r = await fetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<Workspace>(r);
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const r = await fetch("/api/projects");
  return jsonOrThrow<ProjectSummary[]>(r);
}

export async function fetchProject(num: number): Promise<ProjectFull> {
  const r = await fetch(`/api/projects/${num}`);
  return jsonOrThrow<ProjectFull>(r);
}

export async function refreshProject(num: number): Promise<ProjectFull> {
  const r = await fetch(`/api/projects/${num}/refresh`, { method: "POST" });
  return jsonOrThrow<ProjectFull>(r);
}

export async function patchProjectItemStatus(
  num: number,
  itemId: string,
  statusOptionId: string | null,
): Promise<ProjectItem> {
  const r = await fetch(`/api/projects/${num}/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statusOptionId }),
  });
  return jsonOrThrow<ProjectItem>(r);
}

// Roadmap meta-column write: set the pinned board's Status for an issue by name.
// Server resolves the option id; off-board issues are added to the board first
// (response flags it via addedToBoard).
export async function patchIssueProjectStatus(
  issueNum: number,
  statusName: string | null,
): Promise<{ itemId: string; statusOptionId: string | null; statusLabel: string | null; addedToBoard: boolean }> {
  const r = await fetch(`/api/projects/pinned/issues/${issueNum}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statusName }),
  });
  return jsonOrThrow(r);
}

export async function fetchFlow(): Promise<FlowResultMap> {
  const r = await fetch("/api/flow");
  return jsonOrThrow<FlowResultMap>(r);
}

export async function fetchHealth(): Promise<HealthLive> {
  const r = await fetch("/api/health");
  return jsonOrThrow<HealthLive>(r);
}

export async function fetchHealthHistory(days = 30): Promise<HealthSnapshotSummary[]> {
  const r = await fetch(`/api/health/history?days=${days}`);
  return jsonOrThrow<HealthSnapshotSummary[]>(r);
}

export async function fetchHealthSnapshot(date: string): Promise<HealthHistorical> {
  const r = await fetch(`/api/health/snapshot/${date}`);
  return jsonOrThrow<HealthHistorical>(r);
}

export async function fetchPulls(): Promise<Pull[]> {
  const r = await fetch("/api/pulls");
  const list = await jsonOrThrow<ApiPull[]>(r);
  return list.map(pullFromApi);
}

export async function fetchBriefSnapshot(): Promise<BriefSnapshot> {
  const r = await fetch("/api/brief/snapshot");
  return jsonOrThrow<BriefSnapshot>(r);
}

export async function fetchBriefChanges(): Promise<BriefChanges> {
  const r = await fetch("/api/brief/changes");
  return jsonOrThrow<BriefChanges>(r);
}

export async function postBriefMarkSeen(): Promise<{ podLastSeenAt: string }> {
  const r = await fetch("/api/brief/mark-seen", { method: "POST" });
  return jsonOrThrow<{ podLastSeenAt: string }>(r);
}

// Treat 503 as "AI disabled" → null. Other errors throw.
async function jsonOrNullOn503<T>(r: Response): Promise<T | null> {
  if (r.status === 503) return null;
  return jsonOrThrow<T>(r);
}

export async function fetchIssueSummary(num: number): Promise<AiSummary | null> {
  const r = await fetch(`/api/ai/issue-summary/${num}`);
  return jsonOrNullOn503<AiSummary>(r);
}

export async function refreshIssueSummary(num: number): Promise<AiSummary | null> {
  const r = await fetch(`/api/ai/issue-summary/${num}/refresh`, { method: "POST" });
  return jsonOrNullOn503<AiSummary>(r);
}

export async function fetchAiProgress(): Promise<AiProgress | null> {
  const r = await fetch("/api/ai/progress");
  return jsonOrNullOn503<AiProgress>(r);
}

export async function refreshAiProgress(): Promise<AiProgress | null> {
  const r = await fetch("/api/ai/progress/refresh", { method: "POST" });
  return jsonOrNullOn503<AiProgress>(r);
}

export async function fetchPmActions(): Promise<PmActionsResponse> {
  const r = await fetch("/api/pm-actions");
  return jsonOrThrow<PmActionsResponse>(r);
}

// 503 → null only when AI is off mid-refresh; the GET path never 503s.
export async function refreshPmActions(): Promise<PmActionsResponse | null> {
  const r = await fetch("/api/pm-actions/refresh", { method: "POST" });
  return jsonOrNullOn503<PmActionsResponse>(r);
}

// Read one file from the issues repo (read-only viewer). jsonOrThrow surfaces the
// server's status text + error detail, so the viewer can show "not found" / "too large".
export async function fetchRepoFile(path: string, ref?: string | null): Promise<RepoFile> {
  const q = new URLSearchParams({ path });
  if (ref) q.set("ref", ref);
  const r = await fetch(`/api/repo-file?${q.toString()}`);
  return jsonOrThrow<RepoFile>(r);
}

// ─────────────── INSIGHTS ───────────────

export interface InsightFilters {
  type?: string[];
  confidence?: string[];
  account?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export async function fetchInsights(filters: InsightFilters = {}): Promise<ApiInsightListItem[]> {
  const q = new URLSearchParams();
  if (filters.type && filters.type.length > 0) q.set("type", filters.type.join(","));
  if (filters.confidence && filters.confidence.length > 0)
    q.set("confidence", filters.confidence.join(","));
  if (filters.account) q.set("account", filters.account);
  if (filters.dateFrom) q.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) q.set("dateTo", filters.dateTo);
  if (filters.search) q.set("search", filters.search);
  const qs = q.toString();
  const r = await fetch(`/api/insights${qs ? "?" + qs : ""}`);
  return jsonOrThrow<ApiInsightListItem[]>(r);
}

export async function fetchInsight(slug: string): Promise<ApiInsightDetail> {
  const r = await fetch(`/api/insights/${encodeURIComponent(slug)}`);
  return jsonOrThrow<ApiInsightDetail>(r);
}

export async function fetchIssueInsights(num: number): Promise<ApiInsightListItem[]> {
  const r = await fetch(`/api/issues/${num}/insights`);
  return jsonOrThrow<ApiInsightListItem[]>(r);
}

export async function fetchInsightAccounts(): Promise<ApiInsightAccount[]> {
  const r = await fetch("/api/insight-accounts");
  return jsonOrThrow<ApiInsightAccount[]>(r);
}

export async function fetchIssueInsightCounts(): Promise<Record<number, number>> {
  const r = await fetch("/api/issue-insight-counts");
  return jsonOrThrow<Record<number, number>>(r);
}

// ─────────────── INSIGHT DRAFTS (Phase 2a) ───────────────

export async function captureInsight(payload: InsightCapturePayload): Promise<ApiInsightDraft> {
  const r = await fetch("/api/insights/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function fetchInsightDrafts(
  state: InsightDraftState | "all" = "pending",
): Promise<ApiInsightDraft[]> {
  const r = await fetch(`/api/insights/drafts?state=${encodeURIComponent(state)}`);
  return jsonOrThrow<ApiInsightDraft[]>(r);
}

export async function fetchInsightDraft(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}`);
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function patchInsightDraft(
  id: number,
  patch: InsightDraftPatch,
): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function publishInsightDraft(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}/publish`, { method: "POST" });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function mergeInsightDraft(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}/merge`, { method: "POST" });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function closeInsightDraftPr(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}/close-pr`, { method: "POST" });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function regenerateInsightDraft(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}/regenerate`, { method: "POST" });
  return jsonOrThrow<ApiInsightDraft>(r);
}

export async function discardInsightDraft(id: number): Promise<ApiInsightDraft> {
  const r = await fetch(`/api/insights/drafts/${id}/discard`, { method: "POST" });
  return jsonOrThrow<ApiInsightDraft>(r);
}

// ─────────────── INSIGHT OPS (retire / consolidate) ───────────────

export async function fetchInsightOps(state: InsightOpState | "all" = "open"): Promise<ApiInsightOp[]> {
  const r = await fetch(`/api/insight-ops?state=${encodeURIComponent(state)}`);
  return jsonOrThrow<ApiInsightOp[]>(r);
}

export async function markInsightForDeletion(slug: string): Promise<ApiInsightOp> {
  const r = await fetch(`/api/insights/${encodeURIComponent(slug)}/mark-delete`, { method: "POST" });
  return jsonOrThrow<ApiInsightOp>(r);
}

export async function prepareInsightMerge(
  payload: InsightMergePayload,
): Promise<InsightMergePreview> {
  const r = await fetch("/api/insights/merge/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<InsightMergePreview>(r);
}

export async function mergeInsights(payload: InsightMergePayload): Promise<ApiInsightOp> {
  const r = await fetch("/api/insights/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<ApiInsightOp>(r);
}

export async function mergeInsightOp(id: number): Promise<ApiInsightOp> {
  const r = await fetch(`/api/insight-ops/${id}/merge`, { method: "POST" });
  return jsonOrThrow<ApiInsightOp>(r);
}

export async function closeInsightOp(id: number): Promise<ApiInsightOp> {
  const r = await fetch(`/api/insight-ops/${id}/close`, { method: "POST" });
  return jsonOrThrow<ApiInsightOp>(r);
}

export async function createIssue(payload: IssueCreatePayload): Promise<ApiIssue> {
  const r = await fetch("/api/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<ApiIssue>(r);
}

// ─────────────── ACCOUNTS (Insights v2) ───────────────

export async function fetchAccounts(): Promise<Account[]> {
  const r = await fetch("/api/accounts");
  return jsonOrThrow<Account[]>(r);
}

export async function fetchAccount(slug: string): Promise<AccountDetail> {
  const r = await fetch(`/api/accounts/${encodeURIComponent(slug)}`);
  return jsonOrThrow<AccountDetail>(r);
}

export async function regenerateAccountRead(slug: string): Promise<AccountAiRead | null> {
  const r = await fetch(`/api/accounts/${encodeURIComponent(slug)}/regenerate`, { method: "POST" });
  return jsonOrNullOn503<AccountAiRead>(r);
}

export async function patchAccountProfile(
  slug: string,
  patch: AccountProfilePatch,
): Promise<AccountProfile> {
  const r = await fetch(`/api/accounts/${encodeURIComponent(slug)}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<AccountProfile>(r);
}

export async function createAccount(
  row: AccountIngestRow,
): Promise<{ slug: string; created: boolean }> {
  const r = await fetch("/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(row),
  });
  return jsonOrThrow<{ slug: string; created: boolean }>(r);
}

export async function ingestAccounts(accounts: AccountIngestRow[]): Promise<AccountIngestResult> {
  const r = await fetch("/api/accounts/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accounts }),
  });
  return jsonOrThrow<AccountIngestResult>(r);
}

export async function ingestAccountsCsv(csv: string): Promise<AccountIngestResult> {
  const r = await fetch("/api/accounts/ingest/csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv }),
  });
  return jsonOrThrow<AccountIngestResult>(r);
}
