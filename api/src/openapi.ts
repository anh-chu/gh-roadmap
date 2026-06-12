type JsonSchema = Record<string, unknown>;
type OpenApiDoc = Record<string, unknown>;

const json = (schema: JsonSchema, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});

const body = (schema: JsonSchema, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const csvBody = () => ({
  required: true,
  content: { "application/json": { schema: { type: "object", required: ["csv"], properties: { csv: { type: "string" } }, additionalProperties: false } } },
});

const param = (name: string, description: string, schema: JsonSchema = { type: "string" }) => ({
  name,
  in: "path",
  required: true,
  description,
  schema,
});

const query = (name: string, description: string, schema: JsonSchema = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

const ok = (schema: JsonSchema = { type: "object", additionalProperties: true }) => ({
  "200": json(schema),
  "400": json({ $ref: "#/components/schemas/Error" }, "Bad request"),
  "404": json({ $ref: "#/components/schemas/Error" }, "Not found"),
  "502": json({ $ref: "#/components/schemas/Error" }, "Upstream error"),
});

// Responses for user-initiated GitHub writes (x-github-write). When per-user GitHub OAuth is
// enabled, these can 409: { error: "github_not_linked" } (caller has no linked GitHub account)
// or { error: "github_reauth_required" } (stored token was revoked — relink via /api/github/login).
const okGh = (schema: JsonSchema = { type: "object", additionalProperties: true }) => ({
  ...ok(schema),
  "409": json(
    { $ref: "#/components/schemas/Error" },
    "GitHub identity required (only when GitHub OAuth is enabled): error is github_not_linked or github_reauth_required — connect via GET /api/github/login and retry",
  ),
});

const numberParam = param("num", "GitHub issue or project number", { type: "integer" });
const idParam = param("id", "Numeric identifier", { type: "integer" });
const slugParam = param("slug", "Stable slug", { type: "string" });

const op = (
  tag: string,
  operationId: string,
  summary: string,
  options: Record<string, unknown> = {},
) => ({
  tags: [tag],
  operationId,
  summary,
  responses: ok(),
  ...options,
});

const arrayOf = (ref: string): JsonSchema => ({ type: "array", items: { $ref: ref } });

const stringEnum = (values: string[]): JsonSchema => ({ type: "string", enum: values });
const nullableString: JsonSchema = { type: ["string", "null"] };
const nullableNumber: JsonSchema = { type: ["number", "null"] };

export function buildOpenApiDoc(baseUrl: string): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: {
      title: "gh-roadmap API",
      version: "0.2.0",
      summary: "Local PM roadmap API for issues, planning metadata, insights, accounts, AI reads, health, and sync actions.",
      description: [
        "Auth is optional. When GOOGLE_CLIENT_ID/SECRET are unset the app runs single-user on localhost with no auth. When set, every `/api/*` endpoint (except `/api/auth/*`) requires a Google session cookie and returns 401 otherwise; admin-only endpoints (data export/import, AI model settings, user roles) return 403 for non-admins. Roles: viewer / editor / admin — viewers get 403 on any non-GET/HEAD endpoint except /api/auth/*, /api/insights/capture, and /api/workspaces/active.",
        "",
        "**Scoping.** GET reads are filtered by the active workspace's master filter (label include/exclude lists, default `include: [pod:mht]`). Write endpoints are intentionally NOT filtered. The active workspace (pod) is a preference carried in the `rm_workspace` cookie — set via `POST /api/workspaces/active`; falls back to the first non-archived workspace.",
        "",
        "**Field ownership.** `title`, `body`, `state`, `assignee`, `labels`, `milestone`, and comments are mirrored to/from GitHub — `PATCH /api/issues/{num}` writes them to the real repo. `plannedMonth` (format `YYYY-MM`), `plannedWeek` (format `YYYY-Www`, ISO week), `isTodo`, `roadmapNotes`, and `position` are app-only planning fields kept in SQLite and NEVER written back to GitHub — set them via `PATCH /api/issues/{num}/roadmap`.",
        "",
        "**Operation flags.** `x-side-effects`: mutates state. `x-github-write`: mutates the real GitHub repo (issues / comments / PRs), not just the local DB — use deliberately. When per-user GitHub OAuth is enabled (GITHUB_OAUTH_CLIENT_ID/SECRET set), these writes act as the caller's linked GitHub account and return `409 { error: \"github_not_linked\" }` (no account linked) or `409 { error: \"github_reauth_required\" }` (token revoked) until the caller connects via `GET /api/github/login`. When OAuth is unset, all writes use the service token. `x-ai-call`: invokes the configured AI model (returns 503 when AI is unset).",
        "",
        "**Insight flow.** `POST /api/insights/capture` creates a draft in the inbox; the PM reviews it; publishing opens a PR on the product repo; merged insights appear on the next sync.",
      ].join("\n"),
    },
    servers: [{ url: baseUrl }],
    security: [],
    tags: [
      { name: "issues", description: "GitHub issues plus app-only roadmap fields." },
      { name: "comments", description: "GitHub issue comments." },
      { name: "accounts", description: "Customer/account index and mini-CRM profile." },
      { name: "insights", description: "Customer insight mirror, draft inbox, and PR publishing actions." },
      { name: "ai", description: "AI summaries and regenerations." },
      { name: "progress", description: "PM health, brief, flow, and progress reads." },
      { name: "projects", description: "GitHub Projects v2 board mirror." },
      { name: "config", description: "Workspace configuration and catalogs." },
      { name: "sync", description: "Manual reconciliation actions." },
      { name: "data", description: "Full-workspace export / import (backup and restore)." },
      { name: "auth", description: "Google OAuth login / session (only active when auth is enabled)." },
    ],
    paths: {
      "/api/auth/me": {
        get: op("auth", "getAuthMe", "Current session: whether auth is enabled and the signed-in user (null if logged out).", {
          responses: ok({ $ref: "#/components/schemas/AuthMe" }),
        }),
      },
      "/api/auth/login": {
        get: op("auth", "authLogin", "Redirect to Google consent. No-op redirect to / when auth is disabled.", {
          responses: { "302": { description: "Redirect to Google OAuth (or / when disabled)" } },
        }),
      },
      "/api/auth/callback": {
        get: op("auth", "authCallback", "Google OAuth callback — sets the session cookie and redirects to /.", {
          responses: { "302": { description: "Redirect to / (with ?auth_error=… on failure)" } },
        }),
      },
      "/api/auth/logout": {
        post: op("auth", "authLogout", "Clear the session cookie.", {
          "x-side-effects": true,
          responses: ok({ type: "object", properties: { ok: { type: "boolean" } } }),
        }),
      },
      "/api/github/login": {
        get: op("auth", "githubLogin", "Redirect to GitHub consent to link the caller's GitHub account (per-user write identity). No-op redirect to / when GitHub OAuth is disabled.", {
          responses: { "302": { description: "Redirect to GitHub OAuth (or / when disabled)" } },
        }),
      },
      "/api/github/callback": {
        get: op("auth", "githubCallback", "GitHub OAuth callback — validates scope + repo access, stores the encrypted token, and redirects to /.", {
          responses: { "302": { description: "Redirect to / (with ?github_error=… on failure)" } },
        }),
      },
      "/api/github/unlink": {
        post: op("auth", "githubUnlink", "Disconnect the caller's linked GitHub account. Subsequent GitHub writes return 409 github_not_linked until relinked.", {
          "x-side-effects": true,
          responses: ok({ type: "object", properties: { ok: { type: "boolean" } } }),
        }),
      },
      "/api/users": {
        get: op("auth", "listUsers", "List signed-in users and their roles (admin-only). Roles: viewer (read-only), editor (all app writes), admin (editor + roles + AI settings + export/import). ADMIN_EMAILS is the immutable bootstrap-admin list.", {
          responses: ok({ type: "array", items: { $ref: "#/components/schemas/AppUser" } }),
        }),
        post: op("auth", "createUser", "Pre-provision a user before their first sign-in (admin-only). Upserts by lowercase email with the given role; login later preserves the pre-set role. Rejected for ADMIN_EMAILS members (immutable bootstrap admins).", {
          "x-side-effects": true,
          requestBody: body({
            type: "object",
            required: ["email", "role"],
            properties: {
              email: { type: "string" },
              role: { type: "string", enum: ["viewer", "editor", "admin"] },
            },
            additionalProperties: false,
          }),
          responses: { "201": { description: "Created/updated user", content: { "application/json": { schema: { $ref: "#/components/schemas/AppUser" } } } } },
        }),
      },
      "/api/users/{email}/role": {
        patch: op("auth", "setUserRole", "Set a user's role (admin-only). Rejected for ADMIN_EMAILS members (immutable bootstrap admins) and for demoting the last admin.", {
          "x-side-effects": true,
          parameters: [{ name: "email", in: "path", required: true, schema: { type: "string" } }],
          requestBody: body({
            type: "object",
            required: ["role"],
            properties: { role: { type: "string", enum: ["viewer", "editor", "admin"] } },
            additionalProperties: false,
          }),
          responses: ok({ type: "object", properties: { email: { type: "string" }, role: { type: "string" } } }),
        }),
      },
      "/api/openapi.json": {
        get: op("config", "getOpenApiJson", "Read this OpenAPI definition as JSON.", {
          responses: ok({ type: "object", additionalProperties: true }),
        }),
      },
      "/api/openapi.yaml": {
        get: op("config", "getOpenApiYaml", "Read this OpenAPI definition as YAML.", {
          responses: { "200": { description: "OpenAPI YAML", content: { "application/yaml": { schema: { type: "string" } } } } },
        }),
      },
      "/api/openapi": {
        get: op("config", "redirectOpenApi", "Redirect to /api/openapi.json.", {
          responses: { "302": { description: "Redirect to JSON OpenAPI definition" } },
        }),
      },
      "/api/meta": {
        get: op("config", "getMeta", "Read app status, GitHub rate limit, counts, current user, and repo catalog hints.", {
          responses: ok({ $ref: "#/components/schemas/MetaResponse" }),
        }),
      },
      "/api/catalog": {
        get: op("config", "getCatalog", "Read full GitHub label and milestone catalog.", {
          responses: ok({ $ref: "#/components/schemas/CatalogResponse" }),
        }),
      },
      "/api/config": {
        get: op("config", "getConfig", "Read workspace config.", { responses: ok({ $ref: "#/components/schemas/WorkspaceConfig" }) }),
        patch: op("config", "updateConfig", "Update workspace config (admin only).", {
          description: "Admin-only: the config row defines the whole pod's view (base master filter, bucketing, thresholds). Non-admins receive 403.",
          requestBody: body({ $ref: "#/components/schemas/WorkspaceConfigPatch" }),
          responses: ok({ $ref: "#/components/schemas/WorkspaceConfig" }),
          "x-side-effects": true,
        }),
      },
      "/api/workspaces": {
        get: op("config", "listWorkspaces", "List all workspaces (pods, archived included) and the caller's active workspace id.", {
          description: "archivedAt is null for live pods. The switcher UI shows only live pods; archived pods are unarchivable from the admin manage popover.",
          responses: ok({
            type: "object",
            properties: {
              workspaces: arrayOf("#/components/schemas/Workspace"),
              activeId: { type: "integer" },
            },
          }),
        }),
        post: op("config", "createWorkspace", "Create a workspace (pod). Admin only.", {
          description: "Slug must match [a-z0-9-]+ and be unique (409 on duplicate). The new pod gets default config with master filter include ['pod:<slug>'].",
          requestBody: body({
            type: "object",
            required: ["slug", "name"],
            additionalProperties: false,
            properties: { slug: { type: "string" }, name: { type: "string" } },
          }),
          responses: ok({ $ref: "#/components/schemas/Workspace" }),
          "x-side-effects": true,
        }),
      },
      "/api/workspaces/{id}": {
        patch: op("config", "updateWorkspace", "Rename and/or archive/unarchive a workspace (pod). Admin only.", {
          description: "archived: true sets archivedAt to now; false clears it. Archiving the last live pod is rejected with 409 (there must always be ≥1 live pod). No delete — archive only.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: body({
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" }, archived: { type: "boolean" } },
          }),
          responses: ok({ $ref: "#/components/schemas/Workspace" }),
          "x-side-effects": true,
        }),
      },
      "/api/workspaces/active": {
        post: op("config", "setActiveWorkspace", "Switch the caller's active workspace (pod).", {
          description: "Self-scoped preference write: sets the rm_workspace cookie. Open to any signed-in user (including viewers). 404 if the workspace does not exist or is archived.",
          requestBody: body({
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: { id: { type: "integer" } },
          }),
          responses: ok({ $ref: "#/components/schemas/Workspace" }),
          "x-side-effects": true,
        }),
      },

      "/api/issues": {
        get: op("issues", "listIssues", "List scoped issues with roadmap metadata.", {
          responses: ok(arrayOf("#/components/schemas/Issue")),
        }),
        post: op("issues", "createIssue", "Create GitHub issue, then mirror it locally.", {
          description: "Creates the issue on the real GitHub repo, then mirrors it into SQLite. New issues carry no planning metadata until you PATCH .../roadmap.",
          requestBody: body({ $ref: "#/components/schemas/IssueCreate" }),
          responses: okGh({ $ref: "#/components/schemas/Issue" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/issues/{num}": {
        patch: op("issues", "updateIssue", "Update GitHub-owned issue fields.", {
          description: "Writes title / body / state / assignee / labels / milestone to the real GitHub repo. For app-only planning fields (plannedMonth, plannedWeek, isTodo, roadmapNotes, position) use PATCH /api/issues/{num}/roadmap instead.",
          parameters: [numberParam],
          requestBody: body({ $ref: "#/components/schemas/IssuePatch" }),
          responses: okGh({ $ref: "#/components/schemas/Issue" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/issues/{num}/roadmap": {
        patch: op("issues", "updateIssueRoadmap", "Update app-only planning metadata for one issue.", {
          description: "App-only planning fields, stored in SQLite and never written to GitHub. plannedMonth is YYYY-MM; plannedWeek is YYYY-Www (ISO week). Send only the fields you want to change.",
          parameters: [numberParam],
          requestBody: body({ $ref: "#/components/schemas/RoadmapPatch" }),
          responses: ok({ $ref: "#/components/schemas/RoadmapUpdate" }),
          "x-side-effects": true,
        }),
      },
      "/api/issues/{num}/comments": {
        get: op("comments", "listIssueComments", "List comments for one issue.", {
          parameters: [numberParam],
          responses: ok(arrayOf("#/components/schemas/Comment")),
        }),
        post: op("comments", "createIssueComment", "Create GitHub comment on one issue.", {
          parameters: [numberParam],
          requestBody: body({ $ref: "#/components/schemas/CommentPatch" }),
          responses: okGh({ $ref: "#/components/schemas/Comment" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/comments/{id}": {
        patch: op("comments", "updateComment", "Update GitHub comment body.", {
          parameters: [idParam],
          requestBody: body({ $ref: "#/components/schemas/CommentPatch" }),
          responses: okGh({ $ref: "#/components/schemas/Comment" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
        delete: op("comments", "deleteComment", "Delete GitHub comment.", {
          parameters: [idParam],
          responses: okGh({ $ref: "#/components/schemas/Ok" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },

      "/api/pulls": {
        get: op("progress", "listPulls", "List mirrored PRs and linked issues.", {
          responses: ok(arrayOf("#/components/schemas/Pull")),
        }),
      },
      "/api/flow": {
        get: op("progress", "getFlow", "Read per-issue flow states.", {
          responses: ok({ type: "object", additionalProperties: { $ref: "#/components/schemas/FlowResult" } }),
        }),
      },
      "/api/flow/rules": {
        get: op("progress", "getFlowRules", "Read flow-state rule descriptions and thresholds.", {
          responses: ok(arrayOf("#/components/schemas/FlowRule")),
        }),
      },
      "/api/health": {
        get: op("progress", "getHealth", "Read live schedule, momentum, and at-risk summary.", {
          responses: ok({ $ref: "#/components/schemas/HealthLive" }),
        }),
      },
      "/api/health/history": {
        get: op("progress", "getHealthHistory", "Read daily health history.", {
          parameters: [query("days", "Number of days to return", { type: "integer", minimum: 1, maximum: 365 })],
          responses: ok(arrayOf("#/components/schemas/HealthSnapshot")),
        }),
      },
      "/api/health/backfill": {
        post: op("progress", "backfillHealth", "Backfill daily health snapshots.", {
          parameters: [query("days", "Number of days to backfill", { type: "integer", minimum: 1, maximum: 365 })],
          responses: ok({ type: "object", additionalProperties: true }),
          "x-side-effects": true,
        }),
      },
      "/api/health/snapshot/{date}": {
        get: op("progress", "getHealthSnapshot", "Read one health snapshot by UTC date.", {
          parameters: [param("date", "UTC date, YYYY-MM-DD", { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })],
          responses: ok({ $ref: "#/components/schemas/HealthSnapshot" }),
        }),
      },
      "/api/brief/snapshot": {
        get: op("progress", "getBriefSnapshot", "Read morning brief snapshot.", { responses: ok({ type: "object", additionalProperties: true }) }),
      },
      "/api/brief/changes": {
        get: op("progress", "getBriefChanges", "Read changes since last seen.", { responses: ok({ type: "object", additionalProperties: true }) }),
      },
      "/api/brief/mark-seen": {
        post: op("progress", "markBriefSeen", "Mark brief as seen now.", {
          responses: ok({ type: "object", properties: { podLastSeenAt: { type: "string", format: "date-time" } }, required: ["podLastSeenAt"] }),
          "x-side-effects": true,
        }),
      },

      "/api/accounts": {
        get: op("accounts", "listAccounts", "List accounts with signal/profile summary.", { responses: ok(arrayOf("#/components/schemas/Account")) }),
        post: op("accounts", "createAccount", "Create one CRM-profile account.", {
          requestBody: body({ $ref: "#/components/schemas/AccountIngestRow" }),
          responses: ok({ $ref: "#/components/schemas/AccountCreateResult" }),
          "x-side-effects": true,
        }),
      },
      "/api/accounts/{slug}": {
        get: op("accounts", "getAccount", "Read account detail, profile, timeline, cares-about issues, and AI read cache.", {
          parameters: [slugParam],
          responses: ok({ $ref: "#/components/schemas/AccountDetail" }),
        }),
      },
      "/api/accounts/{slug}/profile": {
        patch: op("accounts", "updateAccountProfile", "Patch account mini-CRM profile fields.", {
          parameters: [slugParam],
          requestBody: body({ $ref: "#/components/schemas/AccountProfilePatch" }),
          responses: ok({ $ref: "#/components/schemas/AccountProfile" }),
          "x-side-effects": true,
        }),
      },
      "/api/accounts/ingest": {
        post: op("accounts", "ingestAccounts", "Bulk upsert accounts from JSON rows.", {
          requestBody: body({ type: "object", required: ["accounts"], properties: { accounts: { type: "array", items: { $ref: "#/components/schemas/AccountIngestRow" } } }, additionalProperties: false }),
          responses: ok({ $ref: "#/components/schemas/AccountIngestResult" }),
          "x-side-effects": true,
        }),
      },
      "/api/accounts/ingest/csv": {
        post: op("accounts", "ingestAccountsCsv", "Bulk upsert accounts from pasted CSV.", {
          requestBody: csvBody(),
          responses: ok({ $ref: "#/components/schemas/AccountIngestResult" }),
          "x-side-effects": true,
        }),
      },
      "/api/accounts/{slug}/regenerate": {
        post: op("accounts", "regenerateAccountRead", "Regenerate account AI read.", {
          parameters: [slugParam],
          responses: ok({ $ref: "#/components/schemas/AccountAiRead" }),
          "x-side-effects": true,
          "x-ai-call": true,
        }),
      },

      "/api/insights": {
        get: op("insights", "listInsights", "List mirrored insights with filters.", {
          parameters: [
            query("type", "Comma-separated insight types"),
            query("confidence", "Comma-separated confidence values"),
            query("account", "Account slug"),
            query("dateFrom", "Earliest date, YYYY-MM-DD"),
            query("dateTo", "Latest date, YYYY-MM-DD"),
            query("search", "Title/excerpt search"),
            query("limit", "Max rows", { type: "integer", minimum: 1, maximum: 500 }),
            query("offset", "Offset", { type: "integer", minimum: 0 }),
          ],
          responses: ok(arrayOf("#/components/schemas/InsightListItem")),
        }),
      },
      "/api/insights/{slug}": {
        get: op("insights", "getInsight", "Read one mirrored insight body and links.", {
          parameters: [slugParam],
          responses: ok({ $ref: "#/components/schemas/InsightDetail" }),
        }),
      },
      "/api/issues/{num}/insights": {
        get: op("insights", "listIssueInsights", "List insights linked to one issue.", {
          parameters: [numberParam],
          responses: ok(arrayOf("#/components/schemas/InsightListItem")),
        }),
      },
      "/api/repo-file": {
        get: op("issues", "getRepoFile", "Read one file from the issues repo for in-app viewing.", {
          description: "Read-only view of a single file in the issues repo (GITHUB_OWNER/GITHUB_REPO), used to surface files referenced in an issue body. GitHub is the source of truth — nothing is cached. 404 if missing/a directory; 422 if too large (>1MB) or binary.",
          parameters: [
            { ...query("path", "Repo-relative file path, e.g. src/db.ts"), required: true },
            query("ref", "Branch, tag, or commit SHA. Defaults to the repo default branch."),
          ],
          responses: ok({ $ref: "#/components/schemas/RepoFile" }),
        }),
      },
      "/api/export": {
        get: op("data", "exportData", "Export the entire workspace database as one JSON file.", {
          description:
            "Dumps every user table (GitHub mirror, AI caches, and the app-only planning layer) as `{version, exportedAt, tables}`. Column-agnostic snapshot for backup or moving the workspace to another machine. Served with a download Content-Disposition.",
          responses: ok({
            type: "object",
            properties: {
              version: { type: "integer" },
              exportedAt: { type: "string", format: "date-time" },
              tables: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } },
            },
          }),
        }),
      },
      "/api/import": {
        post: op("data", "importData", "Restore the workspace from an export file (replace-all).", {
          description:
            "Replace-all restore: each table present in the file is wiped and reloaded in one transaction. Unknown tables/columns are skipped; missing columns fall back to schema defaults. Legacy pre-multi-pod backups are accepted: workspace_config rows without slug get slug 'mht' / name 'MHT', and roadmap_meta / health_snapshots rows without workspace_id are filed under workspace 1. On any error the whole import rolls back. Body is the object produced by GET /api/export.",
          requestBody: body({
            type: "object",
            required: ["tables"],
            properties: {
              version: { type: "integer" },
              tables: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } },
            },
          }),
          responses: ok({
            type: "object",
            properties: {
              imported: { type: "object", additionalProperties: { type: "integer" } },
              skipped: { type: "array", items: { type: "string" } },
            },
          }),
          "x-side-effects": true,
        }),
      },
      "/api/insight-accounts": {
        get: op("insights", "listInsightAccounts", "List accounts referenced by insights.", {
          responses: ok(arrayOf("#/components/schemas/InsightAccount")),
        }),
      },
      "/api/issue-insight-counts": {
        get: op("insights", "getIssueInsightCounts", "Map issue number to linked insight/account counts.", {
          responses: ok({ type: "object", additionalProperties: { type: "integer" } }),
        }),
      },
      "/api/insights/capture": {
        post: op("insights", "captureInsight", "Capture raw customer signal, extract fields, and create draft inbox item.", {
          requestBody: body({ $ref: "#/components/schemas/InsightCapture" }),
          responses: ok({ $ref: "#/components/schemas/InsightDraft" }),
          "x-side-effects": true,
          "x-ai-call": true,
        }),
      },
      "/api/insights/drafts": {
        get: op("insights", "listInsightDrafts", "List insight draft inbox items.", { responses: ok(arrayOf("#/components/schemas/InsightDraft")) }),
      },
      "/api/insights/drafts/{id}": {
        get: op("insights", "getInsightDraft", "Read one insight draft.", { parameters: [idParam], responses: ok({ $ref: "#/components/schemas/InsightDraft" }) }),
        patch: op("insights", "updateInsightDraft", "Patch editable insight draft fields.", {
          parameters: [idParam],
          requestBody: body({ $ref: "#/components/schemas/InsightDraftPatch" }),
          responses: ok({ $ref: "#/components/schemas/InsightDraft" }),
          "x-side-effects": true,
        }),
      },
      "/api/insights/drafts/{id}/publish": postAction("insights", "publishInsightDraft", "Publish draft as GitHub PR.", true, false, true),
      "/api/insights/drafts/{id}/merge": postAction("insights", "mergeInsightDraftPr", "Merge draft PR through GitHub.", true, false, true),
      "/api/insights/drafts/{id}/close-pr": postAction("insights", "closeInsightDraftPr", "Close draft PR without publishing signal.", true, false, true),
      "/api/insights/drafts/{id}/regenerate": postAction("insights", "regenerateInsightDraft", "Regenerate draft extraction/body with AI.", true, true),
      "/api/insights/drafts/{id}/discard": postAction("insights", "discardInsightDraft", "Discard draft inbox item.", true),
      "/api/insight-ops": {
        get: op("insights", "listInsightOps", "List pending insight operations.", { responses: ok(arrayOf("#/components/schemas/InsightOp")) }),
      },
      "/api/insights/{slug}/mark-delete": {
        post: op("insights", "markInsightDelete", "Create operation to delete mirrored insight via PR.", {
          parameters: [slugParam],
          responses: okGh({ $ref: "#/components/schemas/InsightOp" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/insights/merge/prepare": {
        post: op("insights", "prepareInsightMerge", "Preview merge of duplicate insights/drafts.", {
          requestBody: body({ $ref: "#/components/schemas/InsightMergePrepare" }),
          responses: ok({ $ref: "#/components/schemas/InsightMergePreview" }),
          "x-side-effects": true,
          "x-ai-call": true,
        }),
      },
      "/api/insights/merge": {
        post: op("insights", "mergeInsights", "Open a PR that folds duplicate insights/drafts into a survivor insight.", {
          requestBody: body({ $ref: "#/components/schemas/InsightMergeExecute" }),
          responses: okGh({ $ref: "#/components/schemas/InsightOp" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/insight-ops/{id}/merge": postAction("insights", "mergeInsightOp", "Merge pending insight operation PR.", true, false, true),
      "/api/insight-ops/{id}/close": postAction("insights", "closeInsightOp", "Close pending insight operation PR.", true, false, true),

      "/api/ai/issue-summary/{num}": {
        get: op("ai", "getIssueSummary", "Read cached or freshly generated issue summary.", { parameters: [numberParam], responses: ok({ $ref: "#/components/schemas/AiBlock" }) }),
      },
      "/api/ai/issue-summary/{num}/refresh": {
        post: op("ai", "refreshIssueSummary", "Force-regenerate issue summary.", {
          parameters: [numberParam],
          responses: ok({ $ref: "#/components/schemas/AiBlock" }),
          "x-side-effects": true,
          "x-ai-call": true,
        }),
      },
      "/api/ai/progress": {
        get: op("ai", "getAiProgress", "Read cached or freshly generated Progress AI read.", { responses: ok({ $ref: "#/components/schemas/AiBlock" }) }),
      },
      "/api/ai/progress/refresh": {
        post: op("ai", "refreshAiProgress", "Force-regenerate Progress AI read.", { responses: ok({ $ref: "#/components/schemas/AiBlock" }), "x-side-effects": true, "x-ai-call": true }),
      },

      "/api/pm-actions": {
        get: op("pmActions", "getPmActions", "List items needing PM craft work (spec depth, release artifacts, a decision). Deterministic detectors; AI-ranked when configured, raw detector output otherwise.", { responses: ok({ $ref: "#/components/schemas/PmActionsResponse" }) }),
      },
      "/api/pm-actions/refresh": {
        post: op("pmActions", "refreshPmActions", "Force-regenerate the AI ranking of PM actions. 503 when AI is unconfigured.", { responses: ok({ $ref: "#/components/schemas/PmActionsResponse" }), "x-side-effects": true, "x-ai-call": true }),
      },

      "/api/projects": {
        get: op("projects", "listProjects", "List configured GitHub Projects v2 boards.", { responses: ok(arrayOf("#/components/schemas/Project")) }),
      },
      "/api/projects/{num}": {
        get: op("projects", "getProject", "Read one GitHub Project v2 board snapshot.", { parameters: [numberParam], responses: ok({ type: "object", additionalProperties: true }) }),
      },
      "/api/projects/{num}/refresh": {
        post: op("projects", "refreshProject", "Refresh one GitHub Project v2 board mirror.", {
          parameters: [numberParam],
          responses: ok({ type: "object", additionalProperties: true }),
          "x-side-effects": true,
        }),
      },
      "/api/projects/{num}/items/{itemId}": {
        patch: op("projects", "updateProjectItem", "Move/update a GitHub Project v2 item.", {
          parameters: [numberParam, param("itemId", "Project item id")],
          requestBody: body({ type: "object", required: ["statusOptionId"], properties: { statusOptionId: nullableString }, additionalProperties: false }),
          responses: okGh({ type: "object", additionalProperties: true }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/projects/pinned/issues/{issueNum}/status": {
        patch: op("projects", "setIssueProjectStatus", "Set the pinned board's Status for an issue by status name (null clears it). Side effect: an issue not yet on the board is first added via addProjectV2ItemById — a real shared mutation flagged in the response as addedToBoard.", {
          parameters: [param("issueNum", "Issue number")],
          requestBody: body({ type: "object", required: ["statusName"], properties: { statusName: nullableString }, additionalProperties: false }),
          responses: okGh({ type: "object", additionalProperties: true }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/sync": {
        post: op("sync", "runSync", "Run manual GitHub and insights reconciliation.", {
          requestBody: body({ type: "object", additionalProperties: true }, false),
          responses: ok({ type: "object", additionalProperties: true }),
          "x-side-effects": true,
        }),
      },
    },
    components: {
      schemas: components,
    },
  };
}

function postAction(tag: string, operationId: string, summary: string, sideEffects = true, aiCall = false, ghWrite = false) {
  return {
    post: op(tag, operationId, summary, {
      parameters: [idParam],
      responses: ghWrite ? okGh({ type: "object", additionalProperties: true }) : ok({ type: "object", additionalProperties: true }),
      ...(sideEffects ? { "x-side-effects": true } : {}),
      ...(aiCall ? { "x-ai-call": true } : {}),
      ...(ghWrite ? { "x-github-write": true } : {}),
    }),
  };
}

const components: Record<string, JsonSchema> = {
  Error: {
    type: "object",
    properties: { error: { type: "string" }, detail: {} },
    required: ["error"],
    additionalProperties: true,
  },
  Ok: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: true },
  Issue: {
    type: "object",
    required: ["number", "title", "state", "labels", "updatedAt", "isTodo"],
    properties: {
      number: { type: "integer" }, title: { type: "string" }, body: nullableString,
      state: stringEnum(["open", "closed"]), assignee: nullableString, milestone: nullableString,
      milestoneDue: { ...nullableString, description: "GitHub milestone due_on (ISO date-time), read-only mirror" },
      labels: { type: "array", items: { type: "string" } }, updatedAt: { type: "string" },
      plannedMonth: nullableString, plannedWeek: nullableString, roadmapNotes: nullableString,
      position: { type: ["integer", "null"] }, isTodo: { type: "boolean" },
      projectStatus: { ...nullableString, description: "Status label on the pinned GitHub Project (GITHUB_PROJECT_NUMBER); null when off-board or no project pinned" },
      projectItemId: { ...nullableString, description: "Pinned-project item id (used for project status writes); null when off-board" },
    },
    additionalProperties: false,
  },
  RepoFile: {
    type: "object",
    required: ["path", "content", "sha", "size"],
    properties: {
      path: { type: "string" }, ref: nullableString, content: { type: "string" },
      sha: { type: "string" }, size: { type: "integer" }, htmlUrl: nullableString,
    },
    additionalProperties: false,
  },
  IssueCreate: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string", minLength: 1 }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignee: nullableString },
    additionalProperties: false,
  },
  IssuePatch: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" }, state: stringEnum(["open", "closed"]), labels: { type: "array", items: { type: "string" } }, assignee: nullableString, milestone: nullableString },
    additionalProperties: false,
  },
  RoadmapPatch: {
    type: "object",
    properties: { plannedMonth: nullableString, plannedWeek: nullableString, roadmapNotes: nullableString, position: nullableNumber, isTodo: { type: "boolean" } },
    additionalProperties: false,
  },
  RoadmapUpdate: {
    type: "object",
    properties: { number: { type: "integer" }, planned_month: nullableString, planned_week: nullableString, roadmap_notes: nullableString, position: nullableNumber, isTodo: { type: "boolean" } },
    additionalProperties: true,
  },
  Comment: {
    type: "object",
    properties: { id: { type: "integer" }, issue_number: { type: "integer" }, author: nullableString, body: { type: "string" }, created_at: { type: "string" }, updated_at: { type: "string" } },
    additionalProperties: true,
  },
  CommentPatch: { type: "object", required: ["body"], properties: { body: { type: "string", minLength: 1 } }, additionalProperties: false },
  Pull: { type: "object", additionalProperties: true },
  FlowResult: { type: "object", properties: { state: { type: "string" }, score: { type: "number" }, signals: { type: "array", items: { type: "string" } } }, additionalProperties: true },
  FlowRule: { type: "object", additionalProperties: true },
  HealthLive: { type: "object", additionalProperties: true },
  PmActionItem: {
    type: "object",
    required: ["issueNumber", "title", "category", "reason", "action"],
    properties: {
      issueNumber: { type: "integer" },
      title: { type: "string" },
      category: stringEnum(["thin-spec", "pre-release", "post-release", "decision-owed"]),
      reason: { type: "string" },
      action: { type: "string" },
    },
    additionalProperties: false,
  },
  PmActionsResponse: {
    type: "object",
    required: ["items", "aiRanked", "model", "generatedAt"],
    properties: {
      items: arrayOf("#/components/schemas/PmActionItem"),
      aiRanked: { type: "boolean" },
      model: nullableString,
      generatedAt: nullableString,
    },
    additionalProperties: false,
  },
  HealthSnapshot: { type: "object", additionalProperties: true },
  MetaResponse: { type: "object", additionalProperties: true },
  AuthMe: {
    type: "object",
    properties: {
      authEnabled: { type: "boolean" },
      user: {
        type: ["object", "null"],
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          picture: { type: ["string", "null"] },
          role: { type: "string", enum: ["viewer", "editor", "admin"] },
          isAdmin: { type: "boolean" },
        },
      },
      githubOauthEnabled: { type: "boolean", description: "Per-user GitHub OAuth configured server-side (GITHUB_OAUTH_CLIENT_ID/SECRET set)." },
      githubLinked: { type: "boolean", description: "Signed-in user has a linked GitHub account. Passive status only — never gates UI controls." },
      githubLogin: { type: ["string", "null"], description: "GitHub login of the linked account, null when unlinked." },
    },
    required: ["authEnabled", "user", "githubOauthEnabled", "githubLinked", "githubLogin"],
  },
  AppUser: {
    type: "object",
    properties: {
      email: { type: "string" },
      name: { type: ["string", "null"] },
      role: { type: "string", enum: ["viewer", "editor", "admin"] },
      envAdmin: { type: "boolean", description: "In ADMIN_EMAILS — immutable bootstrap admin, role not editable." },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["email", "name", "role", "envAdmin", "createdAt", "updatedAt"],
  },
  CatalogResponse: { type: "object", properties: { labels: { type: "array", items: { type: "string" } }, milestones: { type: "array", items: { type: "string" } } }, required: ["labels", "milestones"] },
  WorkspaceConfig: { type: "object", additionalProperties: true, description: "Per-pod workspace configuration. Includes `todoStatusName` (default \"To Do\") and `backlogStatusName` (default \"Backlog\") — the pinned GitHub Project Status option names that back the Roadmap board's TODO / Backlog meta columns." },
  WorkspaceConfigPatch: { type: "object", additionalProperties: true, description: "Partial workspace config update (admin only). Accepts `todoStatusName` / `backlogStatusName` (1-64 chars) among the existing fields." },
  Workspace: {
    type: "object",
    properties: {
      id: { type: "integer" },
      slug: { type: "string" },
      name: { type: "string" },
      archivedAt: { type: "string", nullable: true },
    },
    required: ["id", "slug", "name", "archivedAt"],
  },
  Account: { type: "object", additionalProperties: true },
  AccountDetail: { type: "object", additionalProperties: true },
  AccountAiRead: { type: "object", additionalProperties: true },
  AccountProfile: {
    type: "object",
    properties: {
      updatedAt: nullableString, arr: nullableNumber, renewalDate: nullableString, owner: nullableString,
      tier: nullableString, segment: nullableString, region: nullableString, industry: nullableString,
      website: nullableString, domain: nullableString, salesforceId: nullableString, notes: nullableString,
    },
    additionalProperties: false,
  },
  AccountProfilePatch: {
    type: "object",
    properties: {
      arr: nullableNumber, renewalDate: nullableString, owner: nullableString, tier: nullableString,
      segment: nullableString, region: nullableString, industry: nullableString, website: nullableString,
      domain: nullableString, salesforceId: nullableString, notes: nullableString,
    },
    additionalProperties: false,
  },
  AccountCreateResult: {
    type: "object",
    required: ["slug", "created"],
    properties: { slug: { type: "string" }, created: { type: "boolean" } },
    additionalProperties: false,
  },
  AccountIngestRow: {
    type: "object",
    properties: { name: { type: "string" }, displayName: { type: "string" }, slug: { type: "string" }, arr: nullableNumber, renewalDate: nullableString, owner: nullableString, tier: nullableString, segment: nullableString, region: nullableString, industry: nullableString, website: nullableString, domain: nullableString, salesforceId: nullableString, notes: nullableString },
    additionalProperties: true,
  },
  AccountIngestResult: { type: "object", properties: { created: { type: "integer" }, updated: { type: "integer" }, skipped: { type: "integer" }, errors: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  InsightAccount: { type: "object", additionalProperties: true },
  InsightListItem: { type: "object", additionalProperties: true },
  InsightDetail: { type: "object", additionalProperties: true },
  IssueInsightCount: { type: "object", properties: { insightCount: { type: "integer" }, accountCount: { type: "integer" }, accounts: { type: "array", items: { type: "object", additionalProperties: true } } }, additionalProperties: true },
  InsightCapture: {
    type: "object",
    required: ["sourceType", "rawText"],
    properties: {
      sourceType: { type: "string", pattern: "^[a-z0-9-]{1,24}$", description: "Examples: slack, call, email, doc" },
      rawText: { type: "string", minLength: 1, maxLength: 32000 },
      sourceUrl: { type: "string", maxLength: 1024 },
      hint: { type: "string", maxLength: 1024 },
    },
    additionalProperties: false,
  },
  InsightDraft: { type: "object", additionalProperties: true },
  InsightDraftPatch: { type: "object", additionalProperties: true },
  InsightOp: { type: "object", additionalProperties: true },
  InsightMergePrepare: { type: "object", properties: { survivorSlug: { type: "string" }, victimPaths: { type: "array", items: { type: "string" } }, victimDraftIds: { type: "array", items: { type: "integer" } } }, additionalProperties: false },
  InsightMergeExecute: {
    type: "object",
    required: ["body"],
    properties: {
      survivorSlug: { type: "string" },
      victimPaths: { type: "array", items: { type: "string" } },
      victimDraftIds: { type: "array", items: { type: "integer" } },
      title: { type: "string" },
      type: { type: "string" },
      confidence: { type: "string" },
      accounts: { type: "array", items: { type: "string" } },
      relatedIssues: { type: "array", items: { type: "integer" } },
      body: { type: "string", minLength: 1, description: "Synthesized merged Markdown. Run /api/insights/merge/prepare first." },
    },
    additionalProperties: false,
  },
  InsightMergePreview: { type: "object", additionalProperties: true },
  AiBlock: { type: "object", properties: { content: { type: "string" }, model: { type: "string" }, generatedAt: { type: "string" } }, additionalProperties: true },
  Project: { type: "object", additionalProperties: true },
};
