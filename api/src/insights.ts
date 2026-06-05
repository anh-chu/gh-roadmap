import { createHash } from "node:crypto";
import { load as yamlLoad } from "js-yaml";
import { db } from "./db.js";
import { listInsightFiles, fetchInsightBlob, fetchInsightPrState } from "./github.js";

export interface InsightSyncResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

// Insights are mirrored from the canonical GitHub repo via the API (same model as
// issues) — no local checkout. Enabled iff GitHub is configured.
export function isInsightsEnabled(): boolean {
  return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);
}

interface Frontmatter {
  title?: unknown;
  type?: unknown;
  date?: unknown;
  owner?: unknown;
  confidence?: unknown;
  sources?: unknown;
  related_issues?: unknown;
  accounts?: unknown;
}

interface ParsedInsight {
  title: string;
  type: string | null;
  date: string | null;
  owner: string | null;
  confidence: string | null;
  sources: string[];
  relatedIssues: number[];
  accounts: string[];
  body: string;
  excerpt: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const BODY_ISSUE_RE = /#(\d+)\b/g;

function strOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return out;
}

function intArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    if (typeof x === "number" && Number.isInteger(x) && x > 0) out.push(x);
  }
  return out;
}

function dateStr(v: unknown): string | null {
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m && m[1] ? m[1] : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return null;
}

export function slugifyAccount(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function buildExcerpt(body: string): string {
  // Strip code fences, headings, list markers, blockquotes; collapse whitespace.
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 280) return plain;
  return plain.slice(0, 280).replace(/\s+\S*$/, "") + "…";
}

function parseInsight(raw: string): ParsedInsight | null {
  const m = FM_RE.exec(raw);
  if (!m) return null;
  const fmRaw = m[1] ?? "";
  const body = m[2] ?? "";
  let fm: Frontmatter;
  try {
    const parsed = yamlLoad(fmRaw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    fm = parsed as Frontmatter;
  } catch {
    return null;
  }
  const title = strOrNull(fm.title);
  if (!title) return null;
  return {
    title,
    type: strOrNull(fm.type),
    date: dateStr(fm.date),
    owner: strOrNull(fm.owner),
    confidence: strOrNull(fm.confidence),
    sources: strArray(fm.sources),
    relatedIssues: intArray(fm.related_issues),
    accounts: strArray(fm.accounts),
    body,
    excerpt: buildExcerpt(body),
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function slugFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

function extractBodyIssueRefs(body: string, exclude: Set<number>): number[] {
  BODY_ISSUE_RE.lastIndex = 0;
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = BODY_ISSUE_RE.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !exclude.has(n)) out.add(n);
    if (out.size >= 50) break;
  }
  return [...out];
}

export async function reconcileInsights(): Promise<InsightSyncResult> {
  const result: InsightSyncResult = { scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0 };
  if (!isInsightsEnabled()) return result;

  let entries: Array<{ path: string; sha: string }>;
  try {
    entries = await listInsightFiles();
  } catch (err) {
    // Network / auth failure — leave the existing mirror untouched rather than wiping it.
    // eslint-disable-next-line no-console
    console.warn(`[insights] reconcile aborted: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const conn = db();
  const existingRows = conn.prepare("SELECT path, blob_sha FROM insights").all() as Array<{
    path: string;
    blob_sha: string | null;
  }>;
  const existingByPath = new Map(existingRows.map((r) => [r.path, r.blob_sha]));
  const seenPaths = new Set<string>();

  const upsertInsight = conn.prepare(
    `INSERT INTO insights(path, slug, title, type, date, owner, confidence, sources_json, body_markdown, body_excerpt, file_sha256, blob_sha, updated_at, synced_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       slug=excluded.slug,
       title=excluded.title,
       type=excluded.type,
       date=excluded.date,
       owner=excluded.owner,
       confidence=excluded.confidence,
       sources_json=excluded.sources_json,
       body_markdown=excluded.body_markdown,
       body_excerpt=excluded.body_excerpt,
       file_sha256=excluded.file_sha256,
       blob_sha=excluded.blob_sha,
       updated_at=excluded.updated_at,
       synced_at=excluded.synced_at`,
  );
  const delIssues = conn.prepare("DELETE FROM insight_issues WHERE insight_path = ?");
  const insIssue = conn.prepare(
    "INSERT OR IGNORE INTO insight_issues(insight_path, issue_number, source) VALUES(?,?,?)",
  );
  const delAccounts = conn.prepare("DELETE FROM insight_accounts WHERE insight_path = ?");
  const insAccount = conn.prepare(
    "INSERT OR IGNORE INTO insight_accounts(insight_path, account_slug, account_name) VALUES(?,?,?)",
  );

  const now = new Date().toISOString();

  for (const entry of entries) {
    result.scanned++;
    seenPaths.add(entry.path);
    const prevBlob = existingByPath.get(entry.path);
    if (prevBlob === entry.sha) continue; // unchanged — skip the blob fetch

    // Blob fetch is network I/O — kept outside the SQLite transaction.
    let raw: string;
    try {
      raw = await fetchInsightBlob(entry.sha);
    } catch {
      result.skipped++;
      continue;
    }
    const parsed = parseInsight(raw);
    if (!parsed) {
      result.skipped++;
      continue;
    }
    const slug = slugFromPath(entry.path);
    const contentSha = sha256Hex(raw);

    const writeTx = conn.transaction(() => {
      upsertInsight.run(
        entry.path,
        slug,
        parsed.title,
        parsed.type,
        parsed.date,
        parsed.owner,
        parsed.confidence,
        JSON.stringify(parsed.sources),
        parsed.body,
        parsed.excerpt,
        contentSha,
        entry.sha,
        now,
        now,
      );
      delIssues.run(entry.path);
      const fmSet = new Set<number>();
      for (const n of parsed.relatedIssues) {
        insIssue.run(entry.path, n, "frontmatter");
        fmSet.add(n);
      }
      const bodyRefs = extractBodyIssueRefs(parsed.body, fmSet);
      for (const n of bodyRefs) insIssue.run(entry.path, n, "body");
      delAccounts.run(entry.path);
      for (const name of parsed.accounts) {
        const slugAcc = slugifyAccount(name);
        if (!slugAcc) continue;
        insAccount.run(entry.path, slugAcc, name);
      }
    });
    writeTx();

    if (prevBlob === undefined) result.added++;
    else result.updated++;
  }

  // Remove rows whose file no longer exists in the repo. FK cascade not declared, so manual.
  const toRemove: string[] = [];
  for (const p of existingByPath.keys()) {
    if (!seenPaths.has(p)) toRemove.push(p);
  }
  if (toRemove.length > 0) {
    const delInsight = conn.prepare("DELETE FROM insights WHERE path = ?");
    const removeTx = conn.transaction((paths: string[]) => {
      for (const p of paths) {
        delIssues.run(p);
        delAccounts.run(p);
        delInsight.run(p);
      }
    });
    removeTx(toRemove);
    result.removed = toRemove.length;
  }

  // Backfill the accounts identity table from the junction. Decoupled from per-file
  // change detection so the table self-heals every reconcile regardless of which files
  // changed (and after schema additions). First-seen display_name wins; no overwrite.
  conn
    .prepare(
      `INSERT INTO accounts(slug, display_name, created_at, updated_at)
       SELECT account_slug, account_name, ?, ?
       FROM (SELECT account_slug, MIN(account_name) AS account_name
             FROM insight_accounts GROUP BY account_slug)
       WHERE true
       ON CONFLICT(slug) DO NOTHING`,
    )
    .run(now, now);

  await reconcilePublishedDrafts();
  await reconcileInsightOps();

  return result;
}

// Open delete/merge ops track a PR. If it's merged or closed directly on GitHub, flip the op
// so the Inbox's "Open PRs" list drops it (the merged file disappears via the row cleanup above).
async function reconcileInsightOps(): Promise<void> {
  const conn = db();
  const rows = conn
    .prepare("SELECT id, pr_number FROM insight_ops WHERE state = 'open' AND pr_number IS NOT NULL")
    .all() as Array<{ id: number; pr_number: number }>;
  if (rows.length === 0) return;

  const update = conn.prepare("UPDATE insight_ops SET state = ?, updated_at = ? WHERE id = ?");
  for (const r of rows) {
    let pr: Awaited<ReturnType<typeof fetchInsightPrState>>;
    try {
      pr = await fetchInsightPrState(r.pr_number);
    } catch {
      continue; // transient — re-checked next reconcile
    }
    if (!pr) continue; // PR vanished; leave as-is
    if (pr.merged) update.run("merged", new Date().toISOString(), r.id);
    else if (pr.state === "closed") update.run("closed", new Date().toISOString(), r.id);
  }
}

// Published drafts sit in the Inbox's "Awaiting merge" list until their PR merges.
// The in-app merge button flips state→'merged', but a PR merged directly on GitHub
// leaves the draft stuck as 'published' and still showing an Approve & merge button
// that can only fail. Reconcile against live PR state so merged ones drop off.
async function reconcilePublishedDrafts(): Promise<void> {
  const conn = db();
  const rows = conn
    .prepare("SELECT id, pr_number FROM insight_drafts WHERE state = 'published' AND pr_number IS NOT NULL")
    .all() as Array<{ id: number; pr_number: number }>;
  if (rows.length === 0) return;

  const update = conn.prepare("UPDATE insight_drafts SET state = ?, updated_at = ? WHERE id = ?");
  for (const r of rows) {
    let pr: Awaited<ReturnType<typeof fetchInsightPrState>>;
    try {
      pr = await fetchInsightPrState(r.pr_number);
    } catch {
      continue; // transient — re-checked next reconcile
    }
    if (!pr) continue; // PR vanished; leave as-is
    if (pr.merged) update.run("merged", new Date().toISOString(), r.id);
  }
}

// Used by health.computeAtRisk to bump severity for issues with customer signals.
export function loadIssueNumbersWithInsights(): Set<number> {
  if (!isInsightsEnabled()) return new Set();
  const rows = db()
    .prepare("SELECT DISTINCT issue_number FROM insight_issues")
    .all() as Array<{ issue_number: number }>;
  return new Set(rows.map((r) => r.issue_number));
}

// Used by ai.buildProgressUserText to add account names per at-risk issue.
export function loadAccountsForIssues(issueNumbers: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!isInsightsEnabled() || issueNumbers.length === 0) return out;
  const placeholders = issueNumbers.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT ii.issue_number AS n, ia.account_name AS name
       FROM insight_issues ii
       JOIN insight_accounts ia ON ia.insight_path = ii.insight_path
       WHERE ii.issue_number IN (${placeholders})`,
    )
    .all(...issueNumbers) as Array<{ n: number; name: string }>;
  for (const r of rows) {
    const arr = out.get(r.n);
    if (arr) {
      if (!arr.includes(r.name)) arr.push(r.name);
    } else {
      out.set(r.n, [r.name]);
    }
  }
  return out;
}
