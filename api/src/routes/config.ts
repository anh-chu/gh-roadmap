import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import type { BucketingField, RangeGranularity, WorkspaceConfig } from "../../../shared/types.js";

const VALID_FIELDS: readonly BucketingField[] = ["none", "label", "assignee", "milestone"];
const VALID_GRANULARITIES: readonly RangeGranularity[] = ["week", "month", "quarter"];
const LABEL_VALUE_RE = /^[a-zA-Z0-9-]{1,32}$/;
// Matches GitHub label conventions: alphanumeric + : _ - (allow colon for `pod:mht` style).
const MASTER_LABEL_RE = /^[a-zA-Z0-9:_-]{1,32}$/;
const MAX_MASTER_LIST = 20;

type ConfigRow = {
  bucketing_field: BucketingField;
  bucketing_value: string;
  master_filter_include: string;
  master_filter_exclude: string;
  range_granularity: RangeGranularity;
  range_count: number;
  range_offset: number;
  todo_stale_days: number;
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
  pin_meta_cols: number;
  predict_pr_stale_days: number;
  predict_pr_min_age: number;
  predict_review_wait_days: number;
  predict_promise_confidence_min: number;
  predict_reply_overdue_hours: number;
  ai_model_summary: string | null;
  ai_model_progress: string | null;
  ai_model_extract: string | null;
  updated_at: string;
};

const MAX_MODEL_LEN = 256;

function normaliseModel(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "ai model must be string or null" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_MODEL_LEN) return { ok: false, error: `ai model exceeds ${MAX_MODEL_LEN} chars` };
  return { ok: true, value: trimmed };
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readConfig(workspaceId: number): WorkspaceConfig {
  const row = db()
    .prepare(
      "SELECT bucketing_field, bucketing_value, master_filter_include, master_filter_exclude, range_granularity, range_count, range_offset, todo_stale_days, flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days, pin_meta_cols, predict_pr_stale_days, predict_pr_min_age, predict_review_wait_days, predict_promise_confidence_min, predict_reply_overdue_hours, ai_model_summary, ai_model_progress, ai_model_extract, updated_at FROM workspace_config WHERE id = ?",
    )
    .get(workspaceId) as ConfigRow | undefined;
  if (!row) {
    return {
      bucketingField: "label",
      bucketingValue: "area",
      masterFilterInclude: [],
      masterFilterExclude: [],
      rangeGranularity: "month",
      rangeCount: 3,
      rangeOffset: 0,
      todoStaleDays: 14,
      flowShippingHours: 24,
      flowReviewDays: 3,
      flowCodeDays: 3,
      flowDiscussionDays: 5,
      flowStallDays: 14,
      flowColdDays: 60,
      flowFreshDays: 7,
      pinMetaCols: true,
      predictPrStaleDays: 3,
      predictPrMinAge: 7,
      predictReviewWaitDays: 2,
      predictPromiseConfidenceMin: 60,
      predictReplyOverdueHours: 24,
      aiModelSummary: null,
      aiModelProgress: null,
      aiModelExtract: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    bucketingField: row.bucketing_field,
    bucketingValue: row.bucketing_value,
    masterFilterInclude: parseList(row.master_filter_include),
    masterFilterExclude: parseList(row.master_filter_exclude),
    rangeGranularity: row.range_granularity,
    rangeCount: row.range_count,
    rangeOffset: row.range_offset,
    todoStaleDays: row.todo_stale_days,
    flowShippingHours: row.flow_shipping_hours,
    flowReviewDays: row.flow_review_days,
    flowCodeDays: row.flow_code_days,
    flowDiscussionDays: row.flow_discussion_days,
    flowStallDays: row.flow_stall_days,
    flowColdDays: row.flow_cold_days,
    flowFreshDays: row.flow_fresh_days,
    pinMetaCols: row.pin_meta_cols !== 0,
    predictPrStaleDays: row.predict_pr_stale_days,
    predictPrMinAge: row.predict_pr_min_age,
    predictReviewWaitDays: row.predict_review_wait_days,
    predictPromiseConfidenceMin: row.predict_promise_confidence_min,
    predictReplyOverdueHours: row.predict_reply_overdue_hours,
    aiModelSummary: row.ai_model_summary ?? null,
    aiModelProgress: row.ai_model_progress ?? null,
    aiModelExtract: row.ai_model_extract ?? null,
    updatedAt: row.updated_at,
  };
}

interface IntRange { min: number; max: number; }
type ThresholdKey =
  | "todoStaleDays"
  | "flowShippingHours" | "flowReviewDays" | "flowCodeDays" | "flowDiscussionDays"
  | "flowStallDays" | "flowColdDays" | "flowFreshDays"
  | "predictPrStaleDays" | "predictPrMinAge" | "predictReviewWaitDays"
  | "predictPromiseConfidenceMin" | "predictReplyOverdueHours";
const THRESHOLD_RANGES: Record<ThresholdKey, IntRange> = {
  todoStaleDays: { min: 1, max: 90 },
  flowShippingHours: { min: 1, max: 365 },
  flowReviewDays: { min: 1, max: 365 },
  flowCodeDays: { min: 1, max: 365 },
  flowDiscussionDays: { min: 1, max: 365 },
  flowStallDays: { min: 1, max: 365 },
  flowColdDays: { min: 1, max: 365 },
  flowFreshDays: { min: 1, max: 365 },
  predictPrStaleDays: { min: 1, max: 90 },
  predictPrMinAge: { min: 1, max: 90 },
  predictReviewWaitDays: { min: 1, max: 90 },
  predictPromiseConfidenceMin: { min: 0, max: 100 },
  predictReplyOverdueHours: { min: 1, max: 90 },
};

function validateMasterList(list: unknown, name: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(list)) return { ok: false, error: `${name} must be an array` };
  if (list.length > MAX_MASTER_LIST) return { ok: false, error: `${name} max ${MAX_MASTER_LIST} entries` };
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || v.length === 0) return { ok: false, error: `${name} entries must be non-empty strings` };
    if (!MASTER_LABEL_RE.test(v)) return { ok: false, error: `${name} entry "${v}" invalid (1-32 alphanumeric + :_-)` };
    out.push(v);
  }
  return { ok: true, value: out };
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/config", async (req) => readConfig(req.workspaceId));

  app.patch<{
    Body: {
      bucketingField?: string;
      bucketingValue?: string;
      masterFilterInclude?: string[];
      masterFilterExclude?: string[];
      rangeGranularity?: string;
      rangeCount?: number;
      rangeOffset?: number;
      todoStaleDays?: number;
      flowShippingHours?: number;
      flowReviewDays?: number;
      flowCodeDays?: number;
      flowDiscussionDays?: number;
      flowStallDays?: number;
      flowColdDays?: number;
      flowFreshDays?: number;
      pinMetaCols?: boolean;
      predictPrStaleDays?: number;
      predictPrMinAge?: number;
      predictReviewWaitDays?: number;
      predictPromiseConfidenceMin?: number;
      predictReplyOverdueHours?: number;
      aiModelSummary?: string | null;
      aiModelProgress?: string | null;
      aiModelExtract?: string | null;
    };
  }>(
    "/api/config",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            bucketingField: { type: "string" },
            bucketingValue: { type: "string" },
            masterFilterInclude: { type: "array", items: { type: "string" } },
            masterFilterExclude: { type: "array", items: { type: "string" } },
            rangeGranularity: { type: "string" },
            rangeCount: { type: "number" },
            rangeOffset: { type: "number" },
            todoStaleDays: { type: "number" },
            flowShippingHours: { type: "number" },
            flowReviewDays: { type: "number" },
            flowCodeDays: { type: "number" },
            flowDiscussionDays: { type: "number" },
            flowStallDays: { type: "number" },
            flowColdDays: { type: "number" },
            flowFreshDays: { type: "number" },
            pinMetaCols: { type: "boolean" },
            predictPrStaleDays: { type: "number" },
            predictPrMinAge: { type: "number" },
            predictReviewWaitDays: { type: "number" },
            predictPromiseConfidenceMin: { type: "number" },
            predictReplyOverdueHours: { type: "number" },
            aiModelSummary: { type: ["string", "null"] },
            aiModelProgress: { type: ["string", "null"] },
            aiModelExtract: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      // Admin-gated: this row defines the whole pod's view (base master filter,
      // bucketing, thresholds) — shared state, not a personal preference.
      if (!req.user?.isAdmin) {
        return reply.code(403).send({ error: "workspace config is admin-only" });
      }
      const workspaceId = req.workspaceId;
      const current = readConfig(workspaceId);
      const nextField = (req.body.bucketingField ?? current.bucketingField) as BucketingField;
      let nextValue = req.body.bucketingValue ?? current.bucketingValue;

      if (!VALID_FIELDS.includes(nextField)) {
        return reply.code(400).send({ error: `bucketingField must be one of ${VALID_FIELDS.join(", ")}` });
      }

      if (nextField === "label") {
        nextValue = nextValue.replace(/:$/, "").trim();
        if (!LABEL_VALUE_RE.test(nextValue)) {
          return reply
            .code(400)
            .send({ error: "bucketingValue must be 1-32 chars, alphanumeric or hyphen" });
        }
      } else {
        nextValue = "";
      }

      let nextInclude = current.masterFilterInclude;
      let nextExclude = current.masterFilterExclude;

      if (req.body.masterFilterInclude !== undefined) {
        const r = validateMasterList(req.body.masterFilterInclude, "masterFilterInclude");
        if (!r.ok) return reply.code(400).send({ error: r.error });
        nextInclude = r.value;
      }
      if (req.body.masterFilterExclude !== undefined) {
        const r = validateMasterList(req.body.masterFilterExclude, "masterFilterExclude");
        if (!r.ok) return reply.code(400).send({ error: r.error });
        nextExclude = r.value;
      }

      let nextGranularity = current.rangeGranularity;
      let nextCount = current.rangeCount;
      let nextOffset = current.rangeOffset;

      if (req.body.rangeGranularity !== undefined) {
        const g = req.body.rangeGranularity as RangeGranularity;
        if (!VALID_GRANULARITIES.includes(g)) {
          return reply.code(400).send({ error: `rangeGranularity must be one of ${VALID_GRANULARITIES.join(", ")}` });
        }
        nextGranularity = g;
      }
      if (req.body.rangeCount !== undefined) {
        const n = req.body.rangeCount;
        if (!Number.isInteger(n) || n < 1 || n > 12) {
          return reply.code(400).send({ error: "rangeCount must be an integer in [1, 12]" });
        }
        nextCount = n;
      }
      if (req.body.rangeOffset !== undefined) {
        const n = req.body.rangeOffset;
        if (!Number.isInteger(n) || n < -6 || n > 6) {
          return reply.code(400).send({ error: "rangeOffset must be an integer in [-6, 6]" });
        }
        nextOffset = n;
      }

      let nextTodoStaleDays = current.todoStaleDays;
      let nextFlowShippingHours = current.flowShippingHours;
      let nextFlowReviewDays = current.flowReviewDays;
      let nextFlowCodeDays = current.flowCodeDays;
      let nextFlowDiscussionDays = current.flowDiscussionDays;
      let nextFlowStallDays = current.flowStallDays;
      let nextFlowColdDays = current.flowColdDays;
      let nextFlowFreshDays = current.flowFreshDays;
      let nextPredictPrStaleDays = current.predictPrStaleDays;
      let nextPredictPrMinAge = current.predictPrMinAge;
      let nextPredictReviewWaitDays = current.predictReviewWaitDays;
      let nextPredictPromiseConfidenceMin = current.predictPromiseConfidenceMin;
      let nextPredictReplyOverdueHours = current.predictReplyOverdueHours;

      const validateInt = (n: unknown, name: keyof typeof THRESHOLD_RANGES): number | string => {
        if (typeof n !== "number" || !Number.isInteger(n)) return `${name} must be an integer`;
        const r = THRESHOLD_RANGES[name];
        if (n < r.min || n > r.max) return `${name} must be in [${r.min}, ${r.max}]`;
        return n;
      };

      const apply = (key: keyof typeof THRESHOLD_RANGES, setter: (v: number) => void): string | null => {
        const raw = (req.body as Record<string, unknown>)[key];
        if (raw === undefined) return null;
        const v = validateInt(raw, key);
        if (typeof v === "string") return v;
        setter(v);
        return null;
      };

      const errs: (string | null)[] = [
        apply("todoStaleDays", (v) => { nextTodoStaleDays = v; }),
        apply("flowShippingHours", (v) => { nextFlowShippingHours = v; }),
        apply("flowReviewDays", (v) => { nextFlowReviewDays = v; }),
        apply("flowCodeDays", (v) => { nextFlowCodeDays = v; }),
        apply("flowDiscussionDays", (v) => { nextFlowDiscussionDays = v; }),
        apply("flowStallDays", (v) => { nextFlowStallDays = v; }),
        apply("flowColdDays", (v) => { nextFlowColdDays = v; }),
        apply("flowFreshDays", (v) => { nextFlowFreshDays = v; }),
        apply("predictPrStaleDays", (v) => { nextPredictPrStaleDays = v; }),
        apply("predictPrMinAge", (v) => { nextPredictPrMinAge = v; }),
        apply("predictReviewWaitDays", (v) => { nextPredictReviewWaitDays = v; }),
        apply("predictPromiseConfidenceMin", (v) => { nextPredictPromiseConfidenceMin = v; }),
        apply("predictReplyOverdueHours", (v) => { nextPredictReplyOverdueHours = v; }),
      ];
      for (const e of errs) if (e) return reply.code(400).send({ error: e });

      let nextPinMetaCols = current.pinMetaCols;
      if (req.body.pinMetaCols !== undefined) {
        nextPinMetaCols = !!req.body.pinMetaCols;
      }

      let nextAiModelSummary = current.aiModelSummary;
      let nextAiModelProgress = current.aiModelProgress;
      let nextAiModelExtract = current.aiModelExtract;
      // AI model selection is an admin-only setting.
      const touchesAi =
        req.body.aiModelSummary !== undefined ||
        req.body.aiModelProgress !== undefined ||
        req.body.aiModelExtract !== undefined;
      if (touchesAi && !req.user?.isAdmin) {
        return reply.code(403).send({ error: "AI model settings are admin-only" });
      }
      if (req.body.aiModelSummary !== undefined) {
        const r = normaliseModel(req.body.aiModelSummary);
        if (!r.ok) return reply.code(400).send({ error: `aiModelSummary: ${r.error}` });
        nextAiModelSummary = r.value;
      }
      if (req.body.aiModelProgress !== undefined) {
        const r = normaliseModel(req.body.aiModelProgress);
        if (!r.ok) return reply.code(400).send({ error: `aiModelProgress: ${r.error}` });
        nextAiModelProgress = r.value;
      }
      if (req.body.aiModelExtract !== undefined) {
        const r = normaliseModel(req.body.aiModelExtract);
        if (!r.ok) return reply.code(400).send({ error: `aiModelExtract: ${r.error}` });
        nextAiModelExtract = r.value;
      }

      const now = new Date().toISOString();
      db()
        .prepare(
          "UPDATE workspace_config SET bucketing_field = ?, bucketing_value = ?, master_filter_include = ?, master_filter_exclude = ?, range_granularity = ?, range_count = ?, range_offset = ?, todo_stale_days = ?, flow_shipping_hours = ?, flow_review_days = ?, flow_code_days = ?, flow_discussion_days = ?, flow_stall_days = ?, flow_cold_days = ?, flow_fresh_days = ?, pin_meta_cols = ?, predict_pr_stale_days = ?, predict_pr_min_age = ?, predict_review_wait_days = ?, predict_promise_confidence_min = ?, predict_reply_overdue_hours = ?, ai_model_summary = ?, ai_model_progress = ?, ai_model_extract = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          nextField,
          nextValue,
          JSON.stringify(nextInclude),
          JSON.stringify(nextExclude),
          nextGranularity,
          nextCount,
          nextOffset,
          nextTodoStaleDays,
          nextFlowShippingHours,
          nextFlowReviewDays,
          nextFlowCodeDays,
          nextFlowDiscussionDays,
          nextFlowStallDays,
          nextFlowColdDays,
          nextFlowFreshDays,
          nextPinMetaCols ? 1 : 0,
          nextPredictPrStaleDays,
          nextPredictPrMinAge,
          nextPredictReviewWaitDays,
          nextPredictPromiseConfidenceMin,
          nextPredictReplyOverdueHours,
          nextAiModelSummary,
          nextAiModelProgress,
          nextAiModelExtract,
          now,
          workspaceId,
        );

      return {
        bucketingField: nextField,
        bucketingValue: nextValue,
        masterFilterInclude: nextInclude,
        masterFilterExclude: nextExclude,
        rangeGranularity: nextGranularity,
        rangeCount: nextCount,
        rangeOffset: nextOffset,
        todoStaleDays: nextTodoStaleDays,
        flowShippingHours: nextFlowShippingHours,
        flowReviewDays: nextFlowReviewDays,
        flowCodeDays: nextFlowCodeDays,
        flowDiscussionDays: nextFlowDiscussionDays,
        flowStallDays: nextFlowStallDays,
        flowColdDays: nextFlowColdDays,
        flowFreshDays: nextFlowFreshDays,
        pinMetaCols: nextPinMetaCols,
        predictPrStaleDays: nextPredictPrStaleDays,
        predictPrMinAge: nextPredictPrMinAge,
        predictReviewWaitDays: nextPredictReviewWaitDays,
        predictPromiseConfidenceMin: nextPredictPromiseConfidenceMin,
        predictReplyOverdueHours: nextPredictReplyOverdueHours,
        aiModelSummary: nextAiModelSummary,
        aiModelProgress: nextAiModelProgress,
        aiModelExtract: nextAiModelExtract,
        updatedAt: now,
      } satisfies WorkspaceConfig;
    },
  );
}
