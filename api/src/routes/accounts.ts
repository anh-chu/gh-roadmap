import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { slugifyAccount } from "../insights.js";
import { isAiEnabled, accountRead, type AccountReadSignal } from "../ai.js";
import type {
  Account,
  AccountDetail,
  AccountProfile,
  AccountProfilePatch,
  AccountIngestRow,
  AccountIngestResult,
  AccountSource,
  AccountTimelineItem,
  AccountCaresAboutIssue,
  AccountAiRead,
} from "../../../shared/types.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ─── CRM profile field map ───────────────────────────────────────
// Single source of truth linking DB column ↔ camelCase API key ↔ value kind.
// Drives the SELECT, the upsert SET clause, the row→AccountProfile read, and CSV header aliasing.
type ProfileKey = keyof AccountProfilePatch;
interface ProfileField {
  col: string;
  key: ProfileKey;
  kind: "number" | "text";
}
const PROFILE_FIELDS: ProfileField[] = [
  { col: "arr", key: "arr", kind: "number" },
  { col: "renewal_date", key: "renewalDate", kind: "text" },
  { col: "owner", key: "owner", kind: "text" },
  { col: "tier", key: "tier", kind: "text" },
  { col: "segment", key: "segment", kind: "text" },
  { col: "region", key: "region", kind: "text" },
  { col: "industry", key: "industry", kind: "text" },
  { col: "website", key: "website", kind: "text" },
  { col: "domain", key: "domain", kind: "text" },
  { col: "salesforce_id", key: "salesforceId", kind: "text" },
  { col: "notes", key: "notes", kind: "text" },
];

function deriveSource(signalCount: number, hasProfile: boolean): AccountSource {
  if (signalCount > 0 && hasProfile) return "both";
  if (signalCount > 0) return "signal";
  return "crm";
}

// ─── DB row types ────────────────────────────────────────────────

interface AccountListRow {
  slug: string;
  display_name: string;
  signal_count: number;
  cares_about_count: number;
  latest_date: string | null;
  arr: number | null;
  tier: string | null;
  owner: string | null;
  renewal_date: string | null;
  profile_updated_at: string | null;
}

// Full row including all CRM profile columns (PROFILE_FIELDS) — used by detail + read.
type ProfileColumns = Record<string, string | number | null>;
interface AccountRow extends ProfileColumns {
  slug: string;
  display_name: string;
  ai_read: string | null;
  ai_read_hash: string | null;
  ai_read_at: string | null;
  profile_updated_at: string | null;
}

interface TimelineRow {
  path: string;
  slug: string;
  title: string;
  type: string | null;
  date: string | null;
  confidence: string | null;
  body_excerpt: string;
  file_sha256: string;
}

interface TimelineIssueLinkRow {
  insight_path: string;
  issue_number: number;
}

interface CaresAboutRow {
  issue_number: number;
  signal_count: number;
}

interface SignalRow {
  date: string | null;
  type: string | null;
  confidence: string | null;
  title: string;
  body_excerpt: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function buildTimelineIssueMap(paths: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (paths.length === 0) return out;
  const ph = paths.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT insight_path, issue_number FROM insight_issues WHERE insight_path IN (${ph}) ORDER BY issue_number`,
    )
    .all(...paths) as TimelineIssueLinkRow[];
  for (const r of rows) {
    const arr = out.get(r.insight_path);
    if (arr) arr.push(r.issue_number);
    else out.set(r.insight_path, [r.issue_number]);
  }
  return out;
}

function computeSourceHash(timelinePaths: string[], caresAboutIssues: number[]): string {
  // Hash over sorted `path:file_sha256` pairs + sorted cares-about issue numbers.
  const shaRows = db()
    .prepare(
      `SELECT path, file_sha256 FROM insights WHERE path IN (${timelinePaths.map(() => "?").join(",")}) ORDER BY path`,
    )
    .all(...timelinePaths) as Array<{ path: string; file_sha256: string }>;
  const fileParts = shaRows.map((r) => `${r.path}:${r.file_sha256}`).sort();
  const issueParts = [...caresAboutIssues].sort((a, b) => a - b).map(String);
  return sha256([...fileParts, ...issueParts].join("|"));
}

function storeAiRead(slug: string, content: string, model: string, hash: string): string {
  const at = new Date().toISOString();
  db()
    .prepare(
      `UPDATE accounts SET ai_read=?, ai_read_hash=?, ai_read_at=?, updated_at=? WHERE slug=?`,
    )
    .run(content, hash, at, at, slug);
  return at;
}

// ─── CRM profile read / write ────────────────────────────────────

function readProfile(row: AccountRow): AccountProfile {
  const out: Record<string, unknown> = { updatedAt: row.profile_updated_at ?? null };
  for (const f of PROFILE_FIELDS) out[f.key] = row[f.col] ?? null;
  return out as unknown as AccountProfile;
}

// Coerce one incoming patch value to its DB representation. Returns `undefined` to mean
// "field not present" (skip); `null` clears the column; numbers/strings are stored as-is.
function coerce(field: ProfileField, raw: unknown): string | number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (field.kind === "number") {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    const s = String(raw).replace(/[$,\s]/g, "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(raw).trim();
  return s === "" ? null : s;
}

// Upsert an account + its provided profile fields. Creates the account row if missing
// (slug is the PK). Sets profile_updated_at so a CRM-only account becomes index-visible.
// Returns whether a new account row was created.
function upsertAccountProfile(
  slug: string,
  displayName: string | undefined,
  patch: AccountProfilePatch,
): { created: boolean } {
  const conn = db();
  const now = new Date().toISOString();
  const exists = conn.prepare("SELECT 1 FROM accounts WHERE slug = ?").get(slug) !== undefined;
  let created = false;
  if (!exists) {
    conn
      .prepare(
        "INSERT INTO accounts(slug, display_name, created_at, updated_at) VALUES(?,?,?,?)",
      )
      .run(slug, displayName?.trim() || slug, now, now);
    created = true;
  } else if (displayName && displayName.trim()) {
    conn.prepare("UPDATE accounts SET display_name = ? WHERE slug = ?").run(displayName.trim(), slug);
  }

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const f of PROFILE_FIELDS) {
    const v = coerce(f, patch[f.key]);
    if (v === undefined) continue;
    sets.push(`${f.col} = ?`);
    vals.push(v);
  }
  // Always stamp profile_updated_at + updated_at, even on a create with no fields,
  // so the account is recognised as carrying a profile.
  sets.push("profile_updated_at = ?", "updated_at = ?");
  vals.push(now, now);
  conn.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE slug = ?`).run(...vals, slug);
  return { created };
}

// ─── CSV ingest ──────────────────────────────────────────────────

// Minimal RFC-4180-ish parser: handles quoted fields, escaped "" quotes, and CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

// Header alias → ingest-row key. Headers are lowercased + non-alphanumerics stripped.
const CSV_HEADER_ALIASES: Record<string, keyof AccountIngestRow> = {
  name: "name", account: "name", accountname: "name", displayname: "name", company: "name",
  slug: "slug",
  arr: "arr", annualrecurringrevenue: "arr", revenue: "arr",
  renewal: "renewalDate", renewaldate: "renewalDate",
  owner: "owner", csm: "owner", ae: "owner", accountowner: "owner",
  tier: "tier",
  segment: "segment",
  region: "region", geo: "region",
  industry: "industry", vertical: "industry",
  website: "website", url: "website",
  domain: "domain",
  salesforceid: "salesforceId", sfid: "salesforceId", sfdcid: "salesforceId",
  notes: "notes", note: "notes",
};

function csvToIngestRows(csv: string): { rows: AccountIngestRow[]; errors: string[] } {
  const errors: string[] = [];
  const grid = parseCsv(csv);
  if (grid.length < 2) {
    if (grid.length === 0) errors.push("CSV is empty");
    else errors.push("CSV has a header but no data rows");
    return { rows: [], errors };
  }
  const header = (grid[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const keys = header.map((h) => CSV_HEADER_ALIASES[h]);
  if (!keys.includes("name") && !keys.includes("slug")) {
    errors.push("CSV needs a 'name' or 'slug' column");
    return { rows: [], errors };
  }
  const rows: AccountIngestRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const row: Record<string, string> = {};
    keys.forEach((k, i) => {
      const cell = cells[i];
      if (k && cell !== undefined) row[k] = cell;
    });
    rows.push(row as AccountIngestRow);
  }
  return { rows, errors };
}

// Apply a batch of ingest rows. Each row identified by slug (preferred) or slugified name.
function ingestRows(rows: AccountIngestRow[]): AccountIngestResult {
  const result: AccountIngestResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const tx = db().transaction((batch: AccountIngestRow[]) => {
    batch.forEach((raw, i) => {
      const { slug: rawSlug, name, displayName, ...rest } = raw;
      const slug = (rawSlug && slugifyAccount(rawSlug)) || (name && slugifyAccount(name)) || "";
      if (!slug) {
        result.skipped++;
        result.errors.push(`Row ${i + 1}: missing name/slug`);
        return;
      }
      const { created } = upsertAccountProfile(slug, displayName ?? name, rest);
      if (created) result.created++;
      else result.updated++;
    });
  });
  tx(rows);
  return result;
}

// ─── Route plugin ────────────────────────────────────────────────

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/accounts → Account[]
  // LEFT JOIN so CRM-only accounts (profile, zero signals) surface alongside signal-derived ones.
  app.get("/api/accounts", async (): Promise<Account[]> => {
    const rows = db()
      .prepare(
        `SELECT
           a.slug,
           a.display_name,
           a.arr,
           a.tier,
           a.owner,
           a.renewal_date,
           a.profile_updated_at,
           COUNT(DISTINCT ia.insight_path)                           AS signal_count,
           COUNT(DISTINCT ii.issue_number)                           AS cares_about_count,
           MAX(i.date)                                               AS latest_date
         FROM accounts a
         LEFT JOIN insight_accounts ia ON ia.account_slug = a.slug
         LEFT JOIN insights i ON i.path = ia.insight_path
         LEFT JOIN insight_issues ii ON ii.insight_path = ia.insight_path
         GROUP BY a.slug
         HAVING signal_count >= 1 OR a.profile_updated_at IS NOT NULL
         ORDER BY signal_count DESC, a.display_name ASC`,
      )
      .all() as AccountListRow[];

    return rows.map((r) => ({
      slug: r.slug,
      displayName: r.display_name,
      signalCount: r.signal_count,
      caresAboutCount: r.cares_about_count,
      latestDate: r.latest_date ?? null,
      source: deriveSource(r.signal_count, r.profile_updated_at !== null),
      arr: r.arr ?? null,
      tier: r.tier ?? null,
      owner: r.owner ?? null,
      renewalDate: r.renewal_date ?? null,
    }));
  });

  // GET /api/accounts/:slug → AccountDetail
  app.get<{ Params: { slug: string } }>(
    "/api/accounts/:slug",
    async (req, reply): Promise<AccountDetail | undefined> => {
      const { slug } = req.params;

      const accountRow = db()
        .prepare("SELECT * FROM accounts WHERE slug = ?")
        .get(slug) as AccountRow | undefined;
      if (!accountRow) {
        reply.code(404).send({ error: "account not found" });
        return;
      }

      // Timeline: insights mentioning this account, newest first.
      const timelineRows = db()
        .prepare(
          `SELECT i.path, i.slug, i.title, i.type, i.date, i.confidence, i.body_excerpt, i.file_sha256
           FROM insights i
           JOIN insight_accounts ia ON ia.insight_path = i.path
           WHERE ia.account_slug = ?
           ORDER BY (i.date IS NULL), i.date DESC, i.updated_at DESC`,
        )
        .all(slug) as TimelineRow[];

      const timelinePaths = timelineRows.map((r) => r.path);
      const issueMap = buildTimelineIssueMap(timelinePaths);

      const timeline: AccountTimelineItem[] = timelineRows.map((r) => ({
        path: r.path,
        slug: r.slug,
        title: r.title,
        type: r.type,
        date: r.date,
        confidence: r.confidence,
        excerpt: r.body_excerpt,
        linkedIssues: issueMap.get(r.path) ?? [],
      }));

      // Cares-about: issues linked via this account's signal insights.
      const caresRows = db()
        .prepare(
          `SELECT ii.issue_number, COUNT(DISTINCT ii.insight_path) AS signal_count
           FROM insight_issues ii
           WHERE ii.insight_path IN (
             SELECT insight_path FROM insight_accounts WHERE account_slug = ?
           )
           GROUP BY ii.issue_number
           ORDER BY signal_count DESC, ii.issue_number ASC`,
        )
        .all(slug) as CaresAboutRow[];

      const caresAbout: AccountCaresAboutIssue[] = caresRows.map((r) => ({
        issueNumber: r.issue_number,
        signalCount: r.signal_count,
      }));

      // AI read — cache or generate.
      let aiRead: AccountAiRead | null = null;
      if (timelinePaths.length > 0) {
        const sourceHash = computeSourceHash(timelinePaths, caresAbout.map((c) => c.issueNumber));

        if (accountRow.ai_read && accountRow.ai_read_hash === sourceHash) {
          // Cache hit.
          aiRead = {
            content: accountRow.ai_read,
            model: "cached",
            generatedAt: accountRow.ai_read_at ?? "",
            fromCache: true,
          };
        } else if (isAiEnabled(req.workspaceId)) {
          try {
            const signals: AccountReadSignal[] = timelineRows.map((r) => ({
              date: r.date,
              type: r.type,
              confidence: r.confidence,
              title: r.title,
              excerpt: r.body_excerpt,
            }));
            const { content, model } = await accountRead(
              {
                displayName: accountRow.display_name,
                signals,
                caresAboutIssues: caresAbout.map((c) => c.issueNumber),
              },
              req.workspaceId,
            );
            const generatedAt = storeAiRead(slug, content, model, sourceHash);
            aiRead = { content, model, generatedAt, fromCache: false };
          } catch (err) {
            req.log.error({ err }, "account-read ai generation failed");
            aiRead = null;
          }
        }
      }

      return {
        slug: accountRow.slug,
        displayName: accountRow.display_name,
        source: deriveSource(timeline.length, accountRow.profile_updated_at !== null),
        profile: readProfile(accountRow),
        timeline,
        caresAbout,
        aiRead,
      };
    },
  );

  // PATCH /api/accounts/:slug/profile → AccountDetail['profile']
  // Manual hydrate from the drawer. Account must already exist.
  app.patch<{ Params: { slug: string }; Body: AccountProfilePatch }>(
    "/api/accounts/:slug/profile",
    async (req, reply): Promise<AccountProfile | undefined> => {
      const { slug } = req.params;
      const exists = db().prepare("SELECT 1 FROM accounts WHERE slug = ?").get(slug) !== undefined;
      if (!exists) {
        reply.code(404).send({ error: "account not found" });
        return;
      }
      upsertAccountProfile(slug, undefined, req.body ?? {});
      const row = db().prepare("SELECT * FROM accounts WHERE slug = ?").get(slug) as AccountRow;
      return readProfile(row);
    },
  );

  // POST /api/accounts → { slug, created }
  // Manual single create. Identified by name (slugified) or explicit slug; profile fields optional.
  // Upsert semantics: if the account already exists it's hydrated and returned, not duplicated.
  app.post<{ Body: AccountIngestRow }>(
    "/api/accounts",
    async (req, reply): Promise<{ slug: string; created: boolean } | undefined> => {
      const { slug: rawSlug, name, displayName, ...rest } = req.body ?? {};
      const slug = (rawSlug && slugifyAccount(rawSlug)) || (name && slugifyAccount(name)) || "";
      if (!slug) {
        reply.code(400).send({ error: "name or slug required" });
        return;
      }
      const { created } = upsertAccountProfile(slug, displayName ?? name, rest);
      reply.code(created ? 201 : 200);
      return { slug, created };
    },
  );

  // POST /api/accounts/ingest → AccountIngestResult
  // Bulk JSON upsert. Body: { accounts: AccountIngestRow[] }. Agent/curl-friendly.
  app.post<{ Body: { accounts?: AccountIngestRow[] } }>(
    "/api/accounts/ingest",
    async (req, reply): Promise<AccountIngestResult | undefined> => {
      const rows = req.body?.accounts;
      if (!Array.isArray(rows)) {
        reply.code(400).send({ error: "body must be { accounts: AccountIngestRow[] }" });
        return;
      }
      return ingestRows(rows);
    },
  );

  // POST /api/accounts/ingest/csv → AccountIngestResult
  // Body: { csv: string }. Header row maps columns (name/slug required) to profile fields.
  app.post<{ Body: { csv?: string } }>(
    "/api/accounts/ingest/csv",
    async (req, reply): Promise<AccountIngestResult | undefined> => {
      const csv = req.body?.csv;
      if (typeof csv !== "string" || csv.trim() === "") {
        reply.code(400).send({ error: "body must be { csv: string }" });
        return;
      }
      const { rows, errors } = csvToIngestRows(csv);
      if (rows.length === 0) {
        return { created: 0, updated: 0, skipped: 0, errors };
      }
      const result = ingestRows(rows);
      result.errors.unshift(...errors);
      return result;
    },
  );

  // POST /api/accounts/:slug/regenerate → AccountAiRead
  app.post<{ Params: { slug: string } }>(
    "/api/accounts/:slug/regenerate",
    async (req, reply): Promise<AccountAiRead | undefined> => {
      if (!isAiEnabled(req.workspaceId)) {
        reply.code(503).send({ error: "AI not configured" });
        return;
      }
      const { slug } = req.params;

      const accountRow = db()
        .prepare("SELECT slug, display_name FROM accounts WHERE slug = ?")
        .get(slug) as Pick<AccountRow, "slug" | "display_name"> | undefined;
      if (!accountRow) {
        reply.code(404).send({ error: "account not found" });
        return;
      }

      const signalRows = db()
        .prepare(
          `SELECT i.date, i.type, i.confidence, i.title, i.body_excerpt
           FROM insights i
           JOIN insight_accounts ia ON ia.insight_path = i.path
           WHERE ia.account_slug = ?
           ORDER BY (i.date IS NULL), i.date DESC`,
        )
        .all(slug) as SignalRow[];

      const timelinePaths = (
        db()
          .prepare(
            "SELECT insight_path AS path FROM insight_accounts WHERE account_slug = ? ORDER BY insight_path",
          )
          .all(slug) as Array<{ path: string }>
      ).map((r) => r.path);

      const caresRows = db()
        .prepare(
          `SELECT ii.issue_number
           FROM insight_issues ii
           WHERE ii.insight_path IN (
             SELECT insight_path FROM insight_accounts WHERE account_slug = ?
           )
           GROUP BY ii.issue_number`,
        )
        .all(slug) as Array<{ issue_number: number }>;

      const issueNumbers = caresRows.map((r) => r.issue_number);
      const sourceHash = timelinePaths.length > 0
        ? computeSourceHash(timelinePaths, issueNumbers)
        : sha256("");

      const signals: AccountReadSignal[] = signalRows.map((r) => ({
        date: r.date,
        type: r.type,
        confidence: r.confidence,
        title: r.title,
        excerpt: r.body_excerpt,
      }));

      try {
        const { content, model } = await accountRead(
          {
            displayName: accountRow.display_name,
            signals,
            caresAboutIssues: issueNumbers,
          },
          req.workspaceId,
        );
        const generatedAt = storeAiRead(slug, content, model, sourceHash);
        return { content, model, generatedAt, fromCache: false };
      } catch (err) {
        req.log.error({ err }, "account-read regenerate failed");
        reply.code(503).send({
          error: "account-read failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );
}
