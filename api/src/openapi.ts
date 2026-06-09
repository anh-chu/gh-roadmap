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
      description:
        "No auth. Intended for localhost agent use. GitHub-backed writes mutate the configured GitHub repo. App-only planning fields stay in SQLite.",
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
    ],
    paths: {
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
        patch: op("config", "updateConfig", "Update workspace config.", {
          requestBody: body({ $ref: "#/components/schemas/WorkspaceConfigPatch" }),
          responses: ok({ $ref: "#/components/schemas/WorkspaceConfig" }),
          "x-side-effects": true,
        }),
      },

      "/api/issues": {
        get: op("issues", "listIssues", "List scoped issues with roadmap metadata.", {
          responses: ok(arrayOf("#/components/schemas/Issue")),
        }),
        post: op("issues", "createIssue", "Create GitHub issue, then mirror it locally.", {
          requestBody: body({ $ref: "#/components/schemas/IssueCreate" }),
          responses: ok({ $ref: "#/components/schemas/Issue" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/issues/{num}": {
        patch: op("issues", "updateIssue", "Update GitHub-owned issue fields.", {
          parameters: [numberParam],
          requestBody: body({ $ref: "#/components/schemas/IssuePatch" }),
          responses: ok({ $ref: "#/components/schemas/Issue" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/issues/{num}/roadmap": {
        patch: op("issues", "updateIssueRoadmap", "Update app-only planning metadata for one issue.", {
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
          responses: ok({ $ref: "#/components/schemas/Comment" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/comments/{id}": {
        patch: op("comments", "updateComment", "Update GitHub comment body.", {
          parameters: [idParam],
          requestBody: body({ $ref: "#/components/schemas/CommentPatch" }),
          responses: ok({ $ref: "#/components/schemas/Comment" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
        delete: op("comments", "deleteComment", "Delete GitHub comment.", {
          parameters: [idParam],
          responses: ok({ $ref: "#/components/schemas/Ok" }),
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
      "/api/insights/drafts/{id}/publish": postAction("insights", "publishInsightDraft", "Publish draft as GitHub PR.", true),
      "/api/insights/drafts/{id}/merge": postAction("insights", "mergeInsightDraftPr", "Merge draft PR through GitHub.", true),
      "/api/insights/drafts/{id}/close-pr": postAction("insights", "closeInsightDraftPr", "Close draft PR without publishing signal.", true),
      "/api/insights/drafts/{id}/regenerate": postAction("insights", "regenerateInsightDraft", "Regenerate draft extraction/body with AI.", true, true),
      "/api/insights/drafts/{id}/discard": postAction("insights", "discardInsightDraft", "Discard draft inbox item.", true),
      "/api/insight-ops": {
        get: op("insights", "listInsightOps", "List pending insight operations.", { responses: ok(arrayOf("#/components/schemas/InsightOp")) }),
      },
      "/api/insights/{slug}/mark-delete": {
        post: op("insights", "markInsightDelete", "Create operation to delete mirrored insight via PR.", {
          parameters: [slugParam],
          responses: ok({ $ref: "#/components/schemas/InsightOp" }),
          "x-side-effects": true,
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
          responses: ok({ $ref: "#/components/schemas/InsightOp" }),
          "x-side-effects": true,
          "x-github-write": true,
        }),
      },
      "/api/insight-ops/{id}/merge": postAction("insights", "mergeInsightOp", "Merge pending insight operation PR.", true),
      "/api/insight-ops/{id}/close": postAction("insights", "closeInsightOp", "Close pending insight operation PR.", true),

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
          responses: ok({ type: "object", additionalProperties: true }),
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

function postAction(tag: string, operationId: string, summary: string, sideEffects = true, aiCall = false) {
  return {
    post: op(tag, operationId, summary, {
      parameters: [idParam],
      responses: ok({ type: "object", additionalProperties: true }),
      ...(sideEffects ? { "x-side-effects": true } : {}),
      ...(aiCall ? { "x-ai-call": true } : {}),
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
      labels: { type: "array", items: { type: "string" } }, updatedAt: { type: "string" },
      plannedMonth: nullableString, plannedWeek: nullableString, roadmapNotes: nullableString,
      position: { type: ["integer", "null"] }, isTodo: { type: "boolean" },
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
  HealthSnapshot: { type: "object", additionalProperties: true },
  MetaResponse: { type: "object", additionalProperties: true },
  CatalogResponse: { type: "object", properties: { labels: { type: "array", items: { type: "string" } }, milestones: { type: "array", items: { type: "string" } } }, required: ["labels", "milestones"] },
  WorkspaceConfig: { type: "object", additionalProperties: true },
  WorkspaceConfigPatch: { type: "object", additionalProperties: true },
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
