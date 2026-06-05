import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { dump as yamlDump } from "js-yaml";
import { db, getKv } from "../db.js";
import { isInsightsEnabled, reconcileInsights } from "../insights.js";
import {
  extractInsight,
  isAiEnabled,
  synthesizeMerge,
  type CapturedInsight,
  type MergeInsightSource,
} from "../ai.js";
import { closeInsightPr, deleteInsightPr, mergeInsightPr, mergeInsightsPr, publishInsightPr } from "../github.js";
import { detectDuplicate, type DupCandidate } from "../dedup.js";
import type {
  ApiInsightAccount,
  ApiInsightAccountRef,
  ApiInsightDetail,
  ApiInsightDraft,
  ApiInsightListItem,
  ApiInsightOp,
  InsightDraftState,
  InsightDupKind,
  InsightMergePreview,
  InsightOpKind,
  InsightOpState,
} from "../../../shared/types.js";

interface InsightRow {
  path: string;
  slug: string;
  title: string;
  type: string | null;
  date: string | null;
  owner: string | null;
  confidence: string | null;
  sources_json: string;
  body_markdown: string;
  body_excerpt: string;
  updated_at: string;
}

interface IssueLinkRow {
  insight_path: string;
  issue_number: number;
}

interface AccountLinkRow {
  insight_path: string;
  account_slug: string;
  account_name: string;
}

function parseSources(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  return [];
}

function buildAccountMap(paths: string[]): Map<string, ApiInsightAccountRef[]> {
  const out = new Map<string, ApiInsightAccountRef[]>();
  if (paths.length === 0) return out;
  const ph = paths.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT insight_path, account_slug, account_name FROM insight_accounts WHERE insight_path IN (${ph}) ORDER BY account_name`,
    )
    .all(...paths) as AccountLinkRow[];
  for (const r of rows) {
    const arr = out.get(r.insight_path);
    const ref: ApiInsightAccountRef = { slug: r.account_slug, name: r.account_name };
    if (arr) arr.push(ref);
    else out.set(r.insight_path, [ref]);
  }
  return out;
}

function buildIssueMap(paths: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (paths.length === 0) return out;
  const ph = paths.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT insight_path, issue_number FROM insight_issues WHERE insight_path IN (${ph}) ORDER BY issue_number`,
    )
    .all(...paths) as IssueLinkRow[];
  for (const r of rows) {
    const arr = out.get(r.insight_path);
    if (arr) {
      if (!arr.includes(r.issue_number)) arr.push(r.issue_number);
    } else {
      out.set(r.insight_path, [r.issue_number]);
    }
  }
  return out;
}

function rowToListItem(
  r: InsightRow,
  accounts: ApiInsightAccountRef[],
  linkedIssues: number[],
): ApiInsightListItem {
  return {
    path: r.path,
    slug: r.slug,
    title: r.title,
    type: r.type,
    date: r.date,
    owner: r.owner,
    confidence: r.confidence,
    excerpt: r.body_excerpt,
    accounts,
    linkedIssues,
    updatedAt: r.updated_at,
  };
}

function splitCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      type?: string;
      confidence?: string;
      account?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/insights", async (req): Promise<ApiInsightListItem[]> => {
    if (!isInsightsEnabled()) return [];
    const types = splitCsv(req.query.type);
    const confidences = splitCsv(req.query.confidence);
    const account = req.query.account?.trim() ?? "";
    const dateFrom = req.query.dateFrom?.trim() ?? "";
    const dateTo = req.query.dateTo?.trim() ?? "";
    const search = (req.query.search ?? "").trim().toLowerCase();
    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 200;
    const rawOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

    const where: string[] = [];
    const params: unknown[] = [];
    if (types.length > 0) {
      where.push(`type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    if (confidences.length > 0) {
      where.push(`confidence IN (${confidences.map(() => "?").join(",")})`);
      params.push(...confidences);
    }
    if (dateFrom && DATE_RE.test(dateFrom)) {
      where.push(`(date IS NULL OR date >= ?)`);
      params.push(dateFrom);
    }
    if (dateTo && DATE_RE.test(dateTo)) {
      where.push(`(date IS NULL OR date <= ?)`);
      params.push(dateTo);
    }
    if (account) {
      where.push(
        `path IN (SELECT insight_path FROM insight_accounts WHERE account_slug = ?)`,
      );
      params.push(account);
    }

    const sql = `
      SELECT path, slug, title, type, date, owner, confidence, sources_json, body_markdown, body_excerpt, updated_at
      FROM insights
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY (date IS NULL), date DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    const rows = db().prepare(sql).all(...params) as InsightRow[];

    let filtered = rows;
    if (search) {
      filtered = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(search) || r.body_excerpt.toLowerCase().includes(search),
      );
    }
    const paths = filtered.map((r) => r.path);
    const accountMap = buildAccountMap(paths);
    const issueMap = buildIssueMap(paths);
    return filtered.map((r) =>
      rowToListItem(r, accountMap.get(r.path) ?? [], issueMap.get(r.path) ?? []),
    );
  });

  app.get<{ Params: { slug: string } }>(
    "/api/insights/:slug",
    async (req, reply): Promise<ApiInsightDetail | undefined> => {
      if (!isInsightsEnabled()) {
        reply.code(404).send({ error: "insights disabled" });
        return;
      }
      const slug = req.params.slug;
      const row = db()
        .prepare(
          `SELECT path, slug, title, type, date, owner, confidence, sources_json, body_markdown, body_excerpt, updated_at
           FROM insights WHERE slug = ?`,
        )
        .get(slug) as InsightRow | undefined;
      if (!row) {
        reply.code(404).send({ error: "insight not found" });
        return;
      }
      const accountMap = buildAccountMap([row.path]);
      const issueMap = buildIssueMap([row.path]);
      const list = rowToListItem(
        row,
        accountMap.get(row.path) ?? [],
        issueMap.get(row.path) ?? [],
      );
      return {
        ...list,
        bodyMarkdown: row.body_markdown,
        sources: parseSources(row.sources_json),
      };
    },
  );

  app.get<{ Params: { num: string } }>(
    "/api/issues/:num/insights",
    async (req, reply): Promise<ApiInsightListItem[] | undefined> => {
      if (!isInsightsEnabled()) return [];
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) {
        reply.code(400).send({ error: "invalid issue number" });
        return;
      }
      const rows = db()
        .prepare(
          `SELECT i.path, i.slug, i.title, i.type, i.date, i.owner, i.confidence,
                  i.sources_json, i.body_markdown, i.body_excerpt, i.updated_at
           FROM insights i
           JOIN insight_issues ii ON ii.insight_path = i.path
           WHERE ii.issue_number = ?
           ORDER BY (i.date IS NULL), i.date DESC, i.updated_at DESC`,
        )
        .all(num) as InsightRow[];
      const paths = rows.map((r) => r.path);
      const accountMap = buildAccountMap(paths);
      const issueMap = buildIssueMap(paths);
      return rows.map((r) =>
        rowToListItem(r, accountMap.get(r.path) ?? [], issueMap.get(r.path) ?? []),
      );
    },
  );

  app.get("/api/insight-accounts", async (): Promise<ApiInsightAccount[]> => {
    if (!isInsightsEnabled()) return [];
    const rows = db()
      .prepare(
        `SELECT ia.account_slug AS slug,
                MIN(ia.account_name) AS name,
                COUNT(DISTINCT ia.insight_path) AS insightCount,
                MAX(i.date) AS latestDate
         FROM insight_accounts ia
         JOIN insights i ON i.path = ia.insight_path
         GROUP BY ia.account_slug
         ORDER BY insightCount DESC, name ASC`,
      )
      .all() as Array<{ slug: string; name: string; insightCount: number; latestDate: string | null }>;
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      insightCount: r.insightCount,
      latestDate: r.latestDate,
    }));
  });

  // ─────────────── DRAFTS / CAPTURE / PUBLISH (Phase 2a) ───────────────
  registerDraftRoutes(app);

  // ─────────────── OPS: retire / consolidate published insights ───────────────
  registerOpRoutes(app);

  // Counts per issue — used by board cards (📎 N chip).
  app.get("/api/issue-insight-counts", async (): Promise<Record<number, number>> => {
    if (!isInsightsEnabled()) return {};
    const rows = db()
      .prepare(
        `SELECT issue_number AS n, COUNT(DISTINCT insight_path) AS c
         FROM insight_issues
         GROUP BY issue_number`,
      )
      .all() as Array<{ n: number; c: number }>;
    const out: Record<number, number> = {};
    for (const r of rows) out[r.n] = r.c;
    return out;
  });
}

// ─────────────── DRAFT HELPERS ───────────────

const VALID_TYPES = new Set(["customer", "data", "competitive", "support", "survey", "market"]);
const VALID_CONFIDENCE = new Set(["verified", "likely", "rumor"]);
const SOURCE_TYPE_RE = /^[a-z0-9-]{1,24}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DraftRow {
  id: number;
  created_at: string;
  updated_at: string;
  source_type: string;
  source_url: string | null;
  raw_text: string;
  hint: string | null;
  title: string | null;
  type: string | null;
  date: string | null;
  owner: string | null;
  confidence: string | null;
  accounts_json: string;
  related_issues_json: string;
  key_quotes_json: string;
  body_draft: string | null;
  state: string;
  pr_url: string | null;
  pr_number: number | null;
  published_path: string | null;
  discarded_at: string | null;
  dup_of: number | null;
  dup_kind: string | null;
  dup_score: number | null;
}

function jsonArr<T>(s: string, guard: (x: unknown) => x is T): T[] {
  try {
    const v = JSON.parse(s) as unknown;
    if (Array.isArray(v)) return v.filter(guard);
  } catch {
    /* ignore */
  }
  return [];
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isPosInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

function rowToDraft(r: DraftRow): ApiInsightDraft {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    rawText: r.raw_text,
    hint: r.hint,
    title: r.title,
    type: r.type,
    date: r.date,
    owner: r.owner,
    confidence: r.confidence,
    accounts: jsonArr(r.accounts_json, isStr),
    relatedIssues: jsonArr(r.related_issues_json, isPosInt),
    keyQuotes: jsonArr(r.key_quotes_json, isStr),
    bodyDraft: r.body_draft,
    state: (r.state === "published" || r.state === "merged" || r.state === "discarded" ? r.state : "pending") as InsightDraftState,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    publishedPath: r.published_path,
    discardedAt: r.discarded_at,
    dupOf: r.dup_of,
    dupKind: (r.dup_kind === "exact" || r.dup_kind === "similar" ? r.dup_kind : null) as InsightDupKind | null,
    dupScore: r.dup_score,
  };
}

function getDraftRow(id: number): DraftRow | undefined {
  return db().prepare("SELECT * FROM insight_drafts WHERE id = ?").get(id) as DraftRow | undefined;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(title: string, date: string): string {
  const month = ISO_DATE_RE.test(date) ? date.slice(0, 7) : todayUtc().slice(0, 7);
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const joined = `${base}-${month}`.slice(0, 80).replace(/-+$/, "");
  return joined || `insight-${month}`;
}

// Fuzzy match: each hint vs current issue title+body; return up to 5 issue numbers per hint, dedup overall.
function matchIssuesFromHints(hints: string[]): number[] {
  if (hints.length === 0) return [];
  interface IssueLite {
    number: number;
    title: string;
    body: string | null;
  }
  const issues = db()
    .prepare("SELECT number, title, body FROM issues WHERE state = 'open' LIMIT 2000")
    .all() as IssueLite[];
  if (issues.length === 0) return [];
  const seen = new Set<number>();
  for (const hint of hints) {
    const tokens = hint
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    if (tokens.length === 0) continue;
    const scored: Array<{ n: number; score: number }> = [];
    for (const i of issues) {
      const hay = (i.title + " " + (i.body ?? "")).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score++;
      }
      if (score >= Math.max(1, Math.ceil(tokens.length / 2))) {
        scored.push({ n: i.number, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, 5)) seen.add(s.n);
  }
  return [...seen].slice(0, 20);
}

function explainGhPublishError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: string; status?: number };
  const msg = e.message ?? "unknown error";
  if (e.status === 401) return "GitHub returned 401 — token invalid";
  if (e.status === 403) return "GitHub returned 403 — token missing repo write scope";
  if (e.status === 404) return "GitHub returned 404 — repo not found or no access";
  if (e.status === 405) return "PR is not mergeable — resolve conflicts or checks on GitHub first";
  if (e.status === 409) return "PR head changed since publish — refresh and retry";
  if (e.status === 422 && /reference already exists/i.test(msg)) {
    return "Branch already exists — retry to get a fresh suffix";
  }
  return msg;
}

function badRequest(reply: FastifyReply, msg: string): FastifyReply {
  return reply.code(400).send({ error: msg });
}

function registerDraftRoutes(app: FastifyInstance): void {
  // POST /api/insights/capture
  app.post<{ Body: { sourceType?: unknown; sourceUrl?: unknown; rawText?: unknown; hint?: unknown } }>(
    "/api/insights/capture",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const b = req.body ?? {};
      const sourceType = typeof b.sourceType === "string" ? b.sourceType.trim().toLowerCase() : "";
      if (!sourceType || !SOURCE_TYPE_RE.test(sourceType)) {
        badRequest(reply, "sourceType required (lowercase, alnum+hyphen, ≤24 chars)");
        return;
      }
      const rawText = typeof b.rawText === "string" ? b.rawText : "";
      if (!rawText.trim()) {
        badRequest(reply, "rawText required");
        return;
      }
      if (rawText.length > 32000) {
        badRequest(reply, "rawText too long (≤32000 chars)");
        return;
      }
      const sourceUrlRaw = typeof b.sourceUrl === "string" ? b.sourceUrl.trim() : "";
      if (sourceUrlRaw.length > 1024) {
        badRequest(reply, "sourceUrl too long");
        return;
      }
      const hintRaw = typeof b.hint === "string" ? b.hint.trim() : "";
      if (hintRaw.length > 1024) {
        badRequest(reply, "hint too long");
        return;
      }
      const sourceUrl = sourceUrlRaw || null;
      const hint = hintRaw || null;

      const now = new Date().toISOString();
      const captured: CapturedInsight = { rawText, sourceType, sourceUrl, hint };

      let extracted = {
        title: null as string | null,
        type: null as string | null,
        confidence: null as string | null,
        accounts: [] as string[],
        relatedIssueHints: [] as string[],
        keyQuotes: [] as string[],
        bodyDraft: null as string | null,
      };
      if (isAiEnabled()) {
        try {
          const r = await extractInsight(captured);
          extracted = r.extracted;
        } catch (err) {
          req.log.warn({ err }, "insight extraction failed; returning empty fields");
        }
      }

      const relatedIssues = matchIssuesFromHints(extracted.relatedIssueHints);
      const owner = getKv("currentUser");
      const date = todayUtc();

      // Dedup: flag (never block) a likely re-ingest of the same/near-same text.
      // Compare against live drafts only; discarded ones are noise.
      const candidates = db()
        .prepare(
          "SELECT id, source_type, raw_text FROM insight_drafts WHERE state != 'discarded' ORDER BY id LIMIT 500",
        )
        .all() as DupCandidate[];
      const dup = detectDuplicate(rawText, sourceType, candidates);

      const info = db()
        .prepare(
          `INSERT INTO insight_drafts (
             created_at, updated_at, source_type, source_url, raw_text, hint,
             title, type, date, owner, confidence,
             accounts_json, related_issues_json, key_quotes_json, body_draft,
             state, dup_of, dup_kind, dup_score
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          now,
          now,
          sourceType,
          sourceUrl,
          rawText,
          hint,
          extracted.title,
          extracted.type,
          date,
          owner ? `@${owner}` : null,
          extracted.confidence,
          JSON.stringify(extracted.accounts),
          JSON.stringify(relatedIssues),
          JSON.stringify(extracted.keyQuotes),
          extracted.bodyDraft,
          "pending",
          dup?.dupOf ?? null,
          dup?.dupKind ?? null,
          dup?.dupScore ?? null,
        );
      const id = Number(info.lastInsertRowid);
      const row = getDraftRow(id);
      if (!row) {
        reply.code(500).send({ error: "draft created but could not be read back" });
        return;
      }
      return rowToDraft(row);
    },
  );

  // GET /api/insights/drafts?state=...
  app.get<{ Querystring: { state?: string } }>(
    "/api/insights/drafts",
    async (req): Promise<ApiInsightDraft[]> => {
      const q = (req.query.state ?? "pending").toLowerCase();
      let where = "";
      const params: unknown[] = [];
      if (q !== "all") {
        const allowed = new Set(["pending", "published", "merged", "discarded"]);
        const s = allowed.has(q) ? q : "pending";
        where = "WHERE state = ?";
        params.push(s);
      }
      const rows = db()
        .prepare(`SELECT * FROM insight_drafts ${where} ORDER BY created_at DESC LIMIT 500`)
        .all(...params) as DraftRow[];
      return rows.map(rowToDraft);
    },
  );

  // GET /api/insights/drafts/:id
  app.get<{ Params: { id: string } }>(
    "/api/insights/drafts/:id",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      return rowToDraft(row);
    },
  );

  // PATCH /api/insights/drafts/:id
  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/insights/drafts/:id", async (req, reply): Promise<ApiInsightDraft | undefined> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      badRequest(reply, "invalid id");
      return;
    }
    const row = getDraftRow(id);
    if (!row) {
      reply.code(404).send({ error: "draft not found" });
      return;
    }
    if (row.state !== "pending") {
      reply.code(409).send({ error: `cannot edit draft in state '${row.state}'` });
      return;
    }
    const allowed = new Set([
      "title",
      "type",
      "date",
      "owner",
      "confidence",
      "accounts",
      "relatedIssues",
      "keyQuotes",
      "bodyDraft",
    ]);
    const patch = req.body ?? {};
    for (const k of Object.keys(patch)) {
      if (!allowed.has(k)) {
        badRequest(reply, `unknown field: ${k}`);
        return;
      }
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if ("title" in patch) {
      const v = patch.title;
      if (v !== null && typeof v !== "string") return badRequest(reply, "title must be string or null"), undefined;
      updates.push("title = ?");
      params.push(v === null ? null : (v as string).trim() || null);
    }
    if ("type" in patch) {
      const v = patch.type;
      if (v !== null && typeof v !== "string") return badRequest(reply, "type must be string or null"), undefined;
      if (v !== null && !VALID_TYPES.has((v as string).toLowerCase())) {
        return badRequest(reply, "invalid type"), undefined;
      }
      updates.push("type = ?");
      params.push(v === null ? null : (v as string).toLowerCase());
    }
    if ("date" in patch) {
      const v = patch.date;
      if (v !== null && typeof v !== "string") return badRequest(reply, "date must be string or null"), undefined;
      if (v !== null && !ISO_DATE_RE.test(v as string)) return badRequest(reply, "date must be YYYY-MM-DD"), undefined;
      updates.push("date = ?");
      params.push(v);
    }
    if ("owner" in patch) {
      const v = patch.owner;
      if (v !== null && typeof v !== "string") return badRequest(reply, "owner must be string or null"), undefined;
      updates.push("owner = ?");
      params.push(v === null ? null : (v as string).trim() || null);
    }
    if ("confidence" in patch) {
      const v = patch.confidence;
      if (v !== null && typeof v !== "string") return badRequest(reply, "confidence must be string or null"), undefined;
      if (v !== null && !VALID_CONFIDENCE.has((v as string).toLowerCase())) {
        return badRequest(reply, "invalid confidence"), undefined;
      }
      updates.push("confidence = ?");
      params.push(v === null ? null : (v as string).toLowerCase());
    }
    if ("accounts" in patch) {
      const v = patch.accounts;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return badRequest(reply, "accounts must be string[]"), undefined;
      }
      const clean = [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
      updates.push("accounts_json = ?");
      params.push(JSON.stringify(clean));
    }
    if ("relatedIssues" in patch) {
      const v = patch.relatedIssues;
      if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x) && (x as number) > 0)) {
        return badRequest(reply, "relatedIssues must be positive integer[]"), undefined;
      }
      const clean = [...new Set(v as number[])];
      updates.push("related_issues_json = ?");
      params.push(JSON.stringify(clean));
    }
    if ("keyQuotes" in patch) {
      const v = patch.keyQuotes;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return badRequest(reply, "keyQuotes must be string[]"), undefined;
      }
      const clean = (v as string[]).map((s) => s.trim()).filter(Boolean);
      updates.push("key_quotes_json = ?");
      params.push(JSON.stringify(clean));
    }
    if ("bodyDraft" in patch) {
      const v = patch.bodyDraft;
      if (v !== null && typeof v !== "string") return badRequest(reply, "bodyDraft must be string or null"), undefined;
      updates.push("body_draft = ?");
      params.push(v);
    }

    if (updates.length === 0) {
      return rowToDraft(row);
    }
    updates.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    db()
      .prepare(`UPDATE insight_drafts SET ${updates.join(", ")} WHERE id = ?`)
      .run(...params);
    const updated = getDraftRow(id);
    if (!updated) {
      reply.code(500).send({ error: "draft missing after update" });
      return;
    }
    return rowToDraft(updated);
  });

  // POST /api/insights/drafts/:id/publish
  app.post<{ Params: { id: string } }>(
    "/api/insights/drafts/:id/publish",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      if (row.state !== "pending") {
        reply.code(409).send({ error: `cannot publish draft in state '${row.state}'` });
        return;
      }
      const title = (row.title ?? "").trim();
      const type = (row.type ?? "").trim();
      const date = (row.date ?? "").trim();
      const body = (row.body_draft ?? "").trim();
      if (!title || !type || !date || !body) {
        badRequest(reply, "title, type, date, body_draft all required to publish");
        return;
      }
      if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }

      const accounts = jsonArr(row.accounts_json, isStr);
      const relatedIssues = jsonArr(row.related_issues_json, isPosInt);
      const keyQuotes = jsonArr(row.key_quotes_json, isStr);

      const slug = slugify(title, date);
      const filePath = `insights/${slug}.md`;
      const branchName = `insight/${slug}-${randomBytes(2).toString("hex")}`;

      // Compose frontmatter via js-yaml safe dump.
      const fm: Record<string, unknown> = {
        title,
        type,
        date,
        owner: row.owner ?? "@unknown",
        sources: [`${row.source_type}: ${row.source_url ?? "manual paste"}`],
        confidence: row.confidence ?? "likely",
        accounts,
        related_issues: relatedIssues,
      };
      const fmYaml = yamlDump(fm, { lineWidth: 120, noRefs: true });
      const content = `---\n${fmYaml}---\n\n${body}\n`;

      const prBodyLines: string[] = [];
      prBodyLines.push(`Captured via gh-roadmap insights inbox.`);
      prBodyLines.push("");
      prBodyLines.push(`- Source: \`${row.source_type}\`${row.source_url ? ` — ${row.source_url}` : ""}`);
      if (row.hint) prBodyLines.push(`- Hint: ${row.hint}`);
      if (keyQuotes.length > 0) {
        prBodyLines.push("");
        prBodyLines.push("**Key quotes:**");
        for (const q of keyQuotes) prBodyLines.push(`> ${q.replace(/\n/g, " ")}`);
      }

      let prUrl: string;
      let prNumber: number;
      try {
        const r = await publishInsightPr({
          filePath,
          content,
          title,
          branchName,
          prBody: prBodyLines.join("\n"),
        });
        prUrl = r.prUrl;
        prNumber = r.prNumber;
      } catch (err) {
        req.log.error({ err }, "publishInsightPr failed");
        reply.code(502).send({ error: "failed to open PR", detail: explainGhPublishError(err) });
        return;
      }

      const now = new Date().toISOString();
      db()
        .prepare(
          `UPDATE insight_drafts
             SET state='published', pr_url=?, pr_number=?, published_path=?, updated_at=?
             WHERE id=?`,
        )
        .run(prUrl, prNumber, filePath, now, id);
      const updated = getDraftRow(id);
      if (!updated) {
        reply.code(500).send({ error: "draft missing after publish" });
        return;
      }
      return rowToDraft(updated);
    },
  );

  // POST /api/insights/drafts/:id/merge — squash-merge the published PR.
  app.post<{ Params: { id: string } }>(
    "/api/insights/drafts/:id/merge",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      if (row.state !== "published") {
        reply.code(409).send({ error: `cannot merge draft in state '${row.state}'` });
        return;
      }
      if (row.pr_number === null) {
        reply.code(409).send({ error: "draft has no PR number" });
        return;
      }
      if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }

      try {
        await mergeInsightPr(row.pr_number);
      } catch (err) {
        req.log.error({ err }, "mergeInsightPr failed");
        reply.code(502).send({ error: "failed to merge PR", detail: explainGhPublishError(err) });
        return;
      }

      const now = new Date().toISOString();
      db()
        .prepare("UPDATE insight_drafts SET state='merged', updated_at=? WHERE id=?")
        .run(now, id);
      // Pull the just-merged file into the local mirror now, so the insight shows up
      // immediately instead of waiting for the next boot/nightly sync. Best-effort.
      try {
        await reconcileInsights();
      } catch (err) {
        req.log.warn({ err }, "post-merge reconcile failed; next sync will catch up");
      }
      const updated = getDraftRow(id);
      if (!updated) {
        reply.code(500).send({ error: "draft missing after merge" });
        return;
      }
      return rowToDraft(updated);
    },
  );

  // POST /api/insights/drafts/:id/close-pr — abandon a published draft's open PR
  // (close + delete branch on GitHub) and return the draft to 'pending' so the PM
  // can edit/re-publish or discard it. Inverse of publish.
  app.post<{ Params: { id: string } }>(
    "/api/insights/drafts/:id/close-pr",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      if (row.state !== "published") {
        reply.code(409).send({ error: `cannot close PR for draft in state '${row.state}'` });
        return;
      }
      if (row.pr_number === null) {
        reply.code(409).send({ error: "draft has no PR number" });
        return;
      }
      if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }

      try {
        await closeInsightPr(row.pr_number);
      } catch (err) {
        req.log.error({ err }, "closeInsightPr failed");
        reply.code(502).send({ error: "failed to close PR", detail: explainGhPublishError(err) });
        return;
      }

      const now = new Date().toISOString();
      db()
        .prepare(
          `UPDATE insight_drafts
             SET state='pending', pr_url=NULL, pr_number=NULL, published_path=NULL, updated_at=?
             WHERE id=?`,
        )
        .run(now, id);
      const updated = getDraftRow(id);
      if (!updated) {
        reply.code(500).send({ error: "draft missing after close-pr" });
        return;
      }
      return rowToDraft(updated);
    },
  );

  // POST /api/insights/drafts/:id/regenerate
  app.post<{ Params: { id: string } }>(
    "/api/insights/drafts/:id/regenerate",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      if (row.state !== "pending") {
        reply.code(409).send({ error: `cannot regenerate draft in state '${row.state}'` });
        return;
      }
      if (!isAiEnabled()) {
        reply.code(503).send({ error: "AI is disabled" });
        return;
      }

      const captured: CapturedInsight = {
        rawText: row.raw_text,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        hint: row.hint,
      };

      let extracted;
      try {
        const r = await extractInsight(captured);
        extracted = r.extracted;
      } catch (err) {
        req.log.error({ err }, "insight regeneration failed");
        reply.code(502).send({ error: "AI extraction failed" });
        return;
      }

      const relatedIssues = matchIssuesFromHints(extracted.relatedIssueHints);
      const now = new Date().toISOString();
      db()
        .prepare(
          `UPDATE insight_drafts
             SET title=?, type=?, confidence=?,
                 accounts_json=?, related_issues_json=?, key_quotes_json=?,
                 body_draft=?, updated_at=?
             WHERE id=?`,
        )
        .run(
          extracted.title,
          extracted.type,
          extracted.confidence,
          JSON.stringify(extracted.accounts),
          JSON.stringify(relatedIssues),
          JSON.stringify(extracted.keyQuotes),
          extracted.bodyDraft,
          now,
          id,
        );
      const updated = getDraftRow(id);
      if (!updated) {
        reply.code(500).send({ error: "draft missing after regenerate" });
        return;
      }
      return rowToDraft(updated);
    },
  );

  // POST /api/insights/drafts/:id/discard
  app.post<{ Params: { id: string } }>(
    "/api/insights/drafts/:id/discard",
    async (req, reply): Promise<ApiInsightDraft | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getDraftRow(id);
      if (!row) {
        reply.code(404).send({ error: "draft not found" });
        return;
      }
      if (row.state !== "pending") {
        reply.code(409).send({ error: `cannot discard draft in state '${row.state}'` });
        return;
      }
      const now = new Date().toISOString();
      db()
        .prepare(
          `UPDATE insight_drafts SET state='discarded', discarded_at=?, updated_at=? WHERE id=?`,
        )
        .run(now, now, id);
      const updated = getDraftRow(id);
      if (!updated) {
        reply.code(500).send({ error: "draft missing after discard" });
        return;
      }
      return rowToDraft(updated);
    },
  );
}

// ─────────────── OPS HELPERS ───────────────

const INSIGHT_COLS =
  "path, slug, title, type, date, owner, confidence, sources_json, body_markdown, body_excerpt, updated_at";

function getInsightBySlug(slug: string): InsightRow | undefined {
  return db().prepare(`SELECT ${INSIGHT_COLS} FROM insights WHERE slug = ?`).get(slug) as
    | InsightRow
    | undefined;
}

function getInsightByPath(path: string): InsightRow | undefined {
  return db().prepare(`SELECT ${INSIGHT_COLS} FROM insights WHERE path = ?`).get(path) as
    | InsightRow
    | undefined;
}

function relatedIssuesForPath(path: string): number[] {
  const rows = db()
    .prepare(
      "SELECT DISTINCT issue_number AS n FROM insight_issues WHERE insight_path = ? ORDER BY issue_number",
    )
    .all(path) as Array<{ n: number }>;
  return rows.map((r) => r.n);
}

function accountNamesForPath(path: string): string[] {
  const rows = db()
    .prepare("SELECT account_name AS name FROM insight_accounts WHERE insight_path = ? ORDER BY account_name")
    .all(path) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

interface OpRow {
  id: number;
  kind: string;
  target_path: string;
  victim_paths_json: string;
  victim_draft_ids_json: string;
  pr_url: string | null;
  pr_number: number | null;
  state: string;
  created_at: string;
  updated_at: string;
}

function rowToOp(r: OpRow): ApiInsightOp {
  return {
    id: r.id,
    kind: (r.kind === "merge" ? "merge" : "delete") as InsightOpKind,
    targetPath: r.target_path,
    victimPaths: jsonArr(r.victim_paths_json, isStr),
    victimDraftIds: jsonArr(r.victim_draft_ids_json, isPosInt),
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    state: (r.state === "merged" || r.state === "closed" ? r.state : "open") as InsightOpState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getOpRow(id: number): OpRow | undefined {
  return db().prepare("SELECT * FROM insight_ops WHERE id = ?").get(id) as OpRow | undefined;
}

// An open op already touching `path` (as survivor/delete target or as a merge victim).
function openOpForPath(path: string): boolean {
  const rows = db().prepare("SELECT target_path, victim_paths_json FROM insight_ops WHERE state = 'open'").all() as Array<{
    target_path: string;
    victim_paths_json: string;
  }>;
  return rows.some((r) => r.target_path === path || jsonArr(r.victim_paths_json, isStr).includes(path));
}

function ghConfigured(): boolean {
  return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);
}

interface MergeEdited {
  title: string;
  type: string;
  confidence: string;
  accounts: string[];
  relatedIssues: number[];
  body: string;
}

// Mechanically union all sources/accounts/issues and stitch bodies under separators.
// Used as the AI-disabled fallback and as the base the AI preview is built on.
function mechanicalMerge(
  survivor: InsightRow,
  victimInsights: InsightRow[],
  victimDrafts: DraftRow[],
): MergeEdited {
  const accounts = new Set<string>(accountNamesForPath(survivor.path));
  const related = new Set<number>(relatedIssuesForPath(survivor.path));
  let body = (survivor.body_markdown ?? "").trimEnd();

  for (const v of victimInsights) {
    for (const a of accountNamesForPath(v.path)) accounts.add(a);
    for (const n of relatedIssuesForPath(v.path)) related.add(n);
    body += `\n\n---\n\n## Merged: ${v.title}${v.date ? ` (${v.date})` : ""}\n\n${(v.body_markdown ?? "").trim()}`;
  }
  for (const d of victimDrafts) {
    for (const a of jsonArr(d.accounts_json, isStr)) accounts.add(a);
    for (const n of jsonArr(d.related_issues_json, isPosInt)) related.add(n);
    const quotes = jsonArr(d.key_quotes_json, isStr);
    let chunk = (d.body_draft ?? "").trim();
    if (quotes.length > 0) {
      chunk += (chunk ? "\n\n" : "") + quotes.map((q) => `> ${q.replace(/\n/g, " ")}`).join("\n");
    }
    body += `\n\n---\n\n## Merged: ${d.title ?? "untitled"}${d.date ? ` (${d.date})` : ""}\n\n${chunk}`;
  }

  return {
    title: survivor.title,
    type: survivor.type ?? "customer",
    confidence: survivor.confidence ?? "likely",
    accounts: [...accounts],
    relatedIssues: [...related].sort((a, b) => a - b),
    body: body.trim(),
  };
}

// Compose the survivor .md from edited (or mechanical) content. `sources` is always the
// mechanical union of provenance — never AI-edited.
function buildMergedContent(
  survivor: InsightRow,
  victimInsights: InsightRow[],
  victimDrafts: DraftRow[],
  edited: MergeEdited,
): string {
  const sources = new Set<string>(parseSources(survivor.sources_json));
  for (const v of victimInsights) for (const s of parseSources(v.sources_json)) sources.add(s);
  for (const d of victimDrafts) sources.add(`${d.source_type}: ${d.source_url ?? "manual paste"}`);

  const fm: Record<string, unknown> = {
    title: edited.title || survivor.title,
    type: edited.type || survivor.type || "customer",
    date: survivor.date ?? todayUtc(),
    owner: survivor.owner ?? "@unknown",
    sources: [...sources],
    confidence: edited.confidence || survivor.confidence || "likely",
    accounts: edited.accounts,
    related_issues: [...edited.relatedIssues].sort((a, b) => a - b),
  };
  const fmYaml = yamlDump(fm, { lineWidth: 120, noRefs: true });
  return `---\n${fmYaml}---\n\n${edited.body.trim()}\n`;
}

// Short provenance footer appended to the synthesized body — what was folded in, when.
function mergeProvenanceNote(victimInsights: InsightRow[], victimDrafts: DraftRow[]): string {
  const titles = [
    ...victimInsights.map((v) => v.title),
    ...victimDrafts.map((d) => d.title ?? "untitled"),
  ];
  return `*Consolidated from: ${titles.join("; ")} on ${todayUtc()}.*`;
}

function insightToMergeSource(r: InsightRow): MergeInsightSource {
  return {
    title: r.title,
    type: r.type,
    confidence: r.confidence,
    date: r.date,
    body: r.body_markdown ?? "",
    accounts: accountNamesForPath(r.path),
    relatedIssues: relatedIssuesForPath(r.path),
    isDraft: false,
  };
}

function draftToMergeSource(d: DraftRow): MergeInsightSource {
  const quotes = jsonArr(d.key_quotes_json, isStr);
  let body = (d.body_draft ?? "").trim();
  if (quotes.length > 0) {
    body += (body ? "\n\n" : "") + quotes.map((q) => `> ${q.replace(/\n/g, " ")}`).join("\n");
  }
  return {
    title: d.title ?? "untitled",
    type: d.type,
    confidence: d.confidence,
    date: d.date,
    body,
    accounts: jsonArr(d.accounts_json, isStr),
    relatedIssues: jsonArr(d.related_issues_json, isPosInt),
    isDraft: true,
  };
}

interface ResolvedMerge {
  survivor: InsightRow;
  victimInsights: InsightRow[];
  victimDrafts: DraftRow[];
}

// Validate + resolve a merge request. Returns the resolved targets, or sends an error reply
// and returns null. Shared by /merge/prepare and /merge.
function resolveMergeInputs(
  reply: FastifyReply,
  b: { survivorSlug?: unknown; victimPaths?: unknown; victimDraftIds?: unknown },
  { checkOpenOps }: { checkOpenOps: boolean },
): ResolvedMerge | null {
  const survivorSlug = typeof b.survivorSlug === "string" ? b.survivorSlug.trim() : "";
  if (!survivorSlug) {
    badRequest(reply, "survivorSlug required");
    return null;
  }
  const survivor = getInsightBySlug(survivorSlug);
  if (!survivor) {
    reply.code(404).send({ error: "survivor insight not found" });
    return null;
  }
  const victimPaths = Array.isArray(b.victimPaths) ? [...new Set(b.victimPaths.filter(isStr))] : [];
  const victimDraftIds = Array.isArray(b.victimDraftIds)
    ? [...new Set(b.victimDraftIds.filter(isPosInt))]
    : [];
  if (victimPaths.length === 0 && victimDraftIds.length === 0) {
    badRequest(reply, "at least one victim (path or draft) required");
    return null;
  }
  if (victimPaths.includes(survivor.path)) {
    badRequest(reply, "survivor cannot be its own victim");
    return null;
  }
  const victimInsights: InsightRow[] = [];
  for (const p of victimPaths) {
    const v = getInsightByPath(p);
    if (!v) {
      reply.code(404).send({ error: `victim insight not found: ${p}` });
      return null;
    }
    victimInsights.push(v);
  }
  const victimDrafts: DraftRow[] = [];
  for (const did of victimDraftIds) {
    const d = getDraftRow(did);
    if (!d) {
      reply.code(404).send({ error: `victim draft not found: ${did}` });
      return null;
    }
    if (d.state === "merged" || d.state === "discarded") {
      reply.code(409).send({ error: `draft ${did} already ${d.state}` });
      return null;
    }
    victimDrafts.push(d);
  }
  if (checkOpenOps) {
    for (const p of [survivor.path, ...victimPaths]) {
      if (openOpForPath(p)) {
        reply.code(409).send({ error: `an open PR already targets ${p}` });
        return null;
      }
    }
  }
  return { survivor, victimInsights, victimDrafts };
}

function registerOpRoutes(app: FastifyInstance): void {
  // GET /api/insight-ops?state=open|all
  app.get<{ Querystring: { state?: string } }>(
    "/api/insight-ops",
    async (req): Promise<ApiInsightOp[]> => {
      if (!isInsightsEnabled()) return [];
      const q = (req.query.state ?? "open").toLowerCase();
      let where = "";
      const params: unknown[] = [];
      if (q !== "all") {
        const allowed = new Set(["open", "merged", "closed"]);
        where = "WHERE state = ?";
        params.push(allowed.has(q) ? q : "open");
      }
      const rows = db()
        .prepare(`SELECT * FROM insight_ops ${where} ORDER BY created_at DESC LIMIT 500`)
        .all(...params) as OpRow[];
      return rows.map(rowToOp);
    },
  );

  // POST /api/insights/:slug/mark-delete — open a PR removing the file.
  app.post<{ Params: { slug: string } }>(
    "/api/insights/:slug/mark-delete",
    async (req, reply): Promise<ApiInsightOp | undefined> => {
      if (!isInsightsEnabled()) {
        reply.code(404).send({ error: "insights disabled" });
        return;
      }
      const ins = getInsightBySlug(req.params.slug);
      if (!ins) {
        reply.code(404).send({ error: "insight not found" });
        return;
      }
      if (!ghConfigured()) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }
      if (openOpForPath(ins.path)) {
        reply.code(409).send({ error: "an open PR already targets this insight" });
        return;
      }

      const branchName = `insight-retire/${ins.slug}-${randomBytes(2).toString("hex")}`;
      let prUrl: string;
      let prNumber: number;
      try {
        const r = await deleteInsightPr({
          filePath: ins.path,
          title: ins.title,
          branchName,
          prBody: `Retiring \`${ins.path}\` via gh-roadmap insights.`,
        });
        prUrl = r.prUrl;
        prNumber = r.prNumber;
      } catch (err) {
        req.log.error({ err }, "deleteInsightPr failed");
        reply.code(502).send({ error: "failed to open PR", detail: explainGhPublishError(err) });
        return;
      }

      const now = new Date().toISOString();
      const info = db()
        .prepare(
          `INSERT INTO insight_ops (kind, target_path, victim_paths_json, victim_draft_ids_json, pr_url, pr_number, state, created_at, updated_at)
           VALUES ('delete', ?, '[]', '[]', ?, ?, 'open', ?, ?)`,
        )
        .run(ins.path, prUrl, prNumber, now, now);
      const op = getOpRow(Number(info.lastInsertRowid));
      if (!op) {
        reply.code(500).send({ error: "op created but could not be read back" });
        return;
      }
      return rowToOp(op);
    },
  );

  // POST /api/insights/merge/prepare — AI-synthesize a consolidated preview for the PM to
  // review/edit. Merge is an AI feature: if AI is off/unreachable we error rather than ship a
  // meaningless stapled body. Does NOT open a PR or persist anything.
  app.post<{ Body: { survivorSlug?: unknown; victimPaths?: unknown; victimDraftIds?: unknown } }>(
    "/api/insights/merge/prepare",
    async (req, reply): Promise<InsightMergePreview | undefined> => {
      if (!isInsightsEnabled()) {
        reply.code(404).send({ error: "insights disabled" });
        return;
      }
      if (!isAiEnabled()) {
        reply.code(503).send({ error: "Merge needs AI — configure AI_BASE_URL + AI_MODEL" });
        return;
      }
      const resolved = resolveMergeInputs(reply, req.body ?? {}, { checkOpenOps: true });
      if (!resolved) return;
      const { survivor, victimInsights, victimDrafts } = resolved;

      // Mechanical union is the link FLOOR only — never the body. AI must produce the prose.
      const mech = mechanicalMerge(survivor, victimInsights, victimDrafts);
      let merged;
      try {
        merged = (
          await synthesizeMerge({
            survivor: insightToMergeSource(survivor),
            victims: [...victimInsights.map(insightToMergeSource), ...victimDrafts.map(draftToMergeSource)],
          })
        ).merged;
      } catch (err) {
        req.log.error({ err }, "synthesizeMerge failed");
        reply
          .code(502)
          .send({ error: "AI synthesis failed — is the AI server reachable?", detail: String(err) });
        return;
      }
      if (!merged.body || !merged.body.trim()) {
        reply.code(502).send({ error: "AI returned an empty merge body — retry" });
        return;
      }

      // Provenance footer so the merge history is visible in the file. Editable in the preview.
      const note = mergeProvenanceNote(victimInsights, victimDrafts);
      const body = `${merged.body.trim()}\n\n---\n\n${note}`;

      // links default to the AI's union but fall back to the mechanical union if the model
      // returned none — never silently lose a customer/feature link.
      return {
        title: merged.title ?? mech.title,
        type: merged.type ?? mech.type,
        confidence: merged.confidence ?? mech.confidence,
        accounts: merged.accounts.length > 0 ? merged.accounts : mech.accounts,
        relatedIssues: merged.relatedIssues.length > 0 ? merged.relatedIssues : mech.relatedIssues,
        body,
      };
    },
  );

  // POST /api/insights/merge — fold victims into a survivor file, open one PR. Uses the edited
  // preview content when supplied; otherwise mechanically stitches.
  app.post<{
    Body: {
      survivorSlug?: unknown;
      victimPaths?: unknown;
      victimDraftIds?: unknown;
      title?: unknown;
      type?: unknown;
      confidence?: unknown;
      accounts?: unknown;
      relatedIssues?: unknown;
      body?: unknown;
    };
  }>(
    "/api/insights/merge",
    async (req, reply): Promise<ApiInsightOp | undefined> => {
      if (!isInsightsEnabled()) {
        reply.code(404).send({ error: "insights disabled" });
        return;
      }
      if (!ghConfigured()) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }
      const b = req.body ?? {};
      // Merge is AI-driven: the body MUST come from a synthesized preview, never a staple.
      if (typeof b.body !== "string" || !b.body.trim()) {
        badRequest(reply, "merge requires synthesized content — run the preview first");
        return;
      }
      const resolved = resolveMergeInputs(reply, b, { checkOpenOps: true });
      if (!resolved) return;
      const { survivor, victimInsights, victimDrafts } = resolved;
      const victimPaths = victimInsights.map((v) => v.path);
      const victimDraftIds = victimDrafts.map((d) => d.id);

      // Mechanical union is the link/field FLOOR if the PM cleared a field — never the body.
      const mech = mechanicalMerge(survivor, victimInsights, victimDrafts);
      const edited: MergeEdited = {
        title: typeof b.title === "string" && b.title.trim() ? b.title.trim() : mech.title,
        type:
          typeof b.type === "string" && VALID_TYPES.has(b.type.toLowerCase())
            ? b.type.toLowerCase()
            : mech.type,
        confidence:
          typeof b.confidence === "string" && VALID_CONFIDENCE.has(b.confidence.toLowerCase())
            ? b.confidence.toLowerCase()
            : mech.confidence,
        accounts: Array.isArray(b.accounts)
          ? [...new Set(b.accounts.filter(isStr).map((s) => s.trim()).filter(Boolean))]
          : mech.accounts,
        relatedIssues: Array.isArray(b.relatedIssues)
          ? [...new Set(b.relatedIssues.filter(isPosInt))]
          : mech.relatedIssues,
        body: b.body,
      };

      const content = buildMergedContent(survivor, victimInsights, victimDrafts, edited);
      const branchName = `insight-merge/${survivor.slug}-${randomBytes(2).toString("hex")}`;
      const prBodyLines: string[] = [
        `Merging ${victimInsights.length + victimDrafts.length} insight(s) into \`${survivor.path}\` via gh-roadmap.`,
        "",
      ];
      for (const v of victimInsights) prBodyLines.push(`- remove \`${v.path}\``);
      for (const d of victimDrafts) prBodyLines.push(`- fold in draft #${d.id} (${d.title ?? "untitled"})`);

      let prUrl: string;
      let prNumber: number;
      try {
        const r = await mergeInsightsPr({
          survivorPath: survivor.path,
          survivorContent: content,
          victimPaths,
          title: survivor.title,
          branchName,
          prBody: prBodyLines.join("\n"),
        });
        prUrl = r.prUrl;
        prNumber = r.prNumber;
      } catch (err) {
        req.log.error({ err }, "mergeInsightsPr failed");
        reply.code(502).send({ error: "failed to open PR", detail: explainGhPublishError(err) });
        return;
      }

      const now = new Date().toISOString();
      const info = db()
        .prepare(
          `INSERT INTO insight_ops (kind, target_path, victim_paths_json, victim_draft_ids_json, pr_url, pr_number, state, created_at, updated_at)
           VALUES ('merge', ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          survivor.path,
          JSON.stringify(victimPaths),
          JSON.stringify(victimDraftIds),
          prUrl,
          prNumber,
          now,
          now,
        );
      // Contributing drafts ride this PR — no file of their own. Mark merged so they leave the inbox.
      const markDraft = db().prepare(
        "UPDATE insight_drafts SET state='merged', pr_url=?, pr_number=?, updated_at=? WHERE id=?",
      );
      for (const d of victimDrafts) markDraft.run(prUrl, prNumber, now, d.id);

      const op = getOpRow(Number(info.lastInsertRowid));
      if (!op) {
        reply.code(500).send({ error: "op created but could not be read back" });
        return;
      }
      return rowToOp(op);
    },
  );

  // POST /api/insight-ops/:id/merge — squash-merge the op's PR in-app.
  app.post<{ Params: { id: string } }>(
    "/api/insight-ops/:id/merge",
    async (req, reply): Promise<ApiInsightOp | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getOpRow(id);
      if (!row) {
        reply.code(404).send({ error: "op not found" });
        return;
      }
      if (row.state !== "open") {
        reply.code(409).send({ error: `cannot merge op in state '${row.state}'` });
        return;
      }
      if (row.pr_number === null) {
        reply.code(409).send({ error: "op has no PR number" });
        return;
      }
      if (!ghConfigured()) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }
      try {
        await mergeInsightPr(row.pr_number);
      } catch (err) {
        req.log.error({ err }, "insight-op merge failed");
        reply.code(502).send({ error: "failed to merge PR", detail: explainGhPublishError(err) });
        return;
      }
      const now = new Date().toISOString();
      db().prepare("UPDATE insight_ops SET state='merged', updated_at=? WHERE id=?").run(now, id);
      // Pull the merge result (survivor rewritten, victims removed / file deleted) into the
      // local mirror now, so the Insights tab reflects it immediately. Best-effort.
      try {
        await reconcileInsights();
      } catch (err) {
        req.log.warn({ err }, "post-merge reconcile failed; next sync will catch up");
      }
      const op = getOpRow(id);
      if (!op) {
        reply.code(500).send({ error: "op missing after merge" });
        return;
      }
      return rowToOp(op);
    },
  );

  // POST /api/insight-ops/:id/close — abandon an op's open PR (close + delete branch).
  // Terminal: the op is marked 'closed' and the underlying insight file is left as-is.
  app.post<{ Params: { id: string } }>(
    "/api/insight-ops/:id/close",
    async (req, reply): Promise<ApiInsightOp | undefined> => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        badRequest(reply, "invalid id");
        return;
      }
      const row = getOpRow(id);
      if (!row) {
        reply.code(404).send({ error: "op not found" });
        return;
      }
      if (row.state !== "open") {
        reply.code(409).send({ error: `cannot close op in state '${row.state}'` });
        return;
      }
      if (row.pr_number === null) {
        reply.code(409).send({ error: "op has no PR number" });
        return;
      }
      if (!ghConfigured()) {
        reply.code(503).send({ error: "GitHub not configured — set GITHUB_TOKEN/OWNER/REPO" });
        return;
      }
      try {
        await closeInsightPr(row.pr_number);
      } catch (err) {
        req.log.error({ err }, "insight-op close failed");
        reply.code(502).send({ error: "failed to close PR", detail: explainGhPublishError(err) });
        return;
      }
      const now = new Date().toISOString();
      db().prepare("UPDATE insight_ops SET state='closed', updated_at=? WHERE id=?").run(now, id);
      const op = getOpRow(id);
      if (!op) {
        reply.code(500).send({ error: "op missing after close" });
        return;
      }
      return rowToOp(op);
    },
  );
}
