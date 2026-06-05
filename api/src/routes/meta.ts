import type { FastifyInstance } from "fastify";
import { db, getKv, setKv } from "../db.js";
import { getAuthenticatedLogin, getRateLimitStatus, getRepoSlug, listRepoLabels, listRepoMilestones } from "../github.js";
import type { BucketingField, BucketsInfo } from "../../../shared/types.js";
import { getMasterFilter, masterFilterSql, passesMasterFilter } from "../masterFilter.js";

type IssueScanRow = { labels: string; assignee: string | null; milestone: string | null };

function computeBuckets(field: BucketingField, value: string): BucketsInfo {
  if (field === "none") return { field, value, options: [] };

  const mf = getMasterFilter();
  const rows = (db()
    .prepare("SELECT labels, assignee, milestone FROM issues")
    .all() as IssueScanRow[])
    .filter((r) => passesMasterFilter(JSON.parse(r.labels) as string[], mf));

  if (field === "label") {
    const prefix = `${value}:`;
    const set = new Set<string>();
    for (const r of rows) {
      const labels = JSON.parse(r.labels) as string[];
      for (const l of labels) {
        if (l.startsWith(prefix)) set.add(l.slice(prefix.length));
      }
    }
    return { field, value, options: [...set].sort() };
  }

  if (field === "assignee") {
    const set = new Set<string>();
    for (const r of rows) if (r.assignee) set.add(r.assignee);
    return { field, value, options: [...set].sort() };
  }

  // milestone
  const set = new Set<string>();
  let hasNone = false;
  for (const r of rows) {
    if (r.milestone) set.add(r.milestone);
    else hasNone = true;
  }
  const options = [...set].sort();
  if (hasNone) options.push("(no milestone)");
  return { field, value, options };
}

// Counts open issues at the end of each of the last 8 weeks (oldest entry first).
// An issue is "open at time T" iff created_at <= T AND (closed_at IS NULL OR closed_at > T).
function openHistoryWeekly(): number[] {
  const mf = masterFilterSql(getMasterFilter());
  const scope = mf ? ` AND ${mf.sql}` : "";
  const scopeParams = mf ? mf.params : [];

  const series: number[] = [];
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const stmt = db().prepare(
    `SELECT COUNT(*) AS n FROM issues i
     WHERE created_at IS NOT NULL
       AND created_at <= ?
       AND (closed_at IS NULL OR closed_at > ?)${scope}`,
  );
  for (let i = 7; i >= 0; i--) {
    const t = new Date(now - i * WEEK_MS).toISOString();
    const row = stmt.get(t, t, ...scopeParams) as { n: number };
    series.push(row.n);
  }
  return series;
}

function ymUtc(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function closedInMonth(month: string): number {
  const mf = masterFilterSql(getMasterFilter());
  const scope = mf ? ` AND ${mf.sql}` : "";
  const scopeParams = mf ? mf.params : [];
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM issues i
       WHERE state = 'closed'
         AND closed_at IS NOT NULL
         AND substr(closed_at, 1, 7) = ?${scope}`,
    )
    .get(month, ...scopeParams) as { n: number };
  return row.n;
}

function scopedCount(state: "open" | "closed"): number {
  const mf = masterFilterSql(getMasterFilter());
  const scope = mf ? ` AND ${mf.sql}` : "";
  const scopeParams = mf ? mf.params : [];
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM issues i WHERE state = ?${scope}`)
    .get(state, ...scopeParams) as { n: number };
  return row.n;
}

// The repo label/milestone catalog changes rarely; cache it so opening the
// drawer doesn't hit GitHub each time. Falls back to empty (client unions with
// in-use values) when GitHub is unconfigured or the call fails.
let catalogCache: { labels: string[]; milestones: string[]; at: number } | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/catalog", async () => {
    const now = Date.now();
    if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
      return { labels: catalogCache.labels, milestones: catalogCache.milestones };
    }
    try {
      const [labels, milestones] = await Promise.all([listRepoLabels(), listRepoMilestones()]);
      catalogCache = { labels, milestones, at: now };
      return { labels, milestones };
    } catch {
      return { labels: [], milestones: [] };
    }
  });

  app.get("/api/meta", async () => {
    const rate = getRateLimitStatus();
    const open = scopedCount("open");
    const closed = scopedCount("closed");

    const cfg = db()
      .prepare("SELECT bucketing_field, bucketing_value FROM workspace_config WHERE id = 1")
      .get() as { bucketing_field: BucketingField; bucketing_value: string } | undefined;
    const field: BucketingField = cfg?.bucketing_field ?? "label";
    const value = cfg?.bucketing_value ?? "area";

    const buckets = computeBuckets(field, value);
    const areas = field === "label" && value === "area" ? buckets.options : [];

    // webhookEventsToday is a sync_log metric, not an issue metric — leave unscoped.
    const webhookEventsToday = (db()
      .prepare("SELECT COUNT(*) AS n FROM sync_log WHERE date(processed_at) = date('now')")
      .get() as { n: number }).n;

    const now = new Date();
    const thisMonth = ymUtc(now);
    const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastMonth = ymUtc(lastMonthDate);

    // Cache the authenticated login in kv so we don't hit GitHub on every /api/meta poll.
    let currentUser = getKv("currentUser");
    if (currentUser === null) {
      const login = await getAuthenticatedLogin();
      if (login) {
        setKv("currentUser", login);
        currentUser = login;
      }
    }

    return {
      rateLimitRemaining: rate.remaining,
      rateLimitLimit: rate.limit,
      rateLimitReset: rate.reset,
      lastSyncAt: getKv("lastSyncAt"),
      openCount: open,
      closedCount: closed,
      buckets,
      webhookEventsToday,
      openHistoryWeekly: openHistoryWeekly(),
      closedThisMonth: closedInMonth(thisMonth),
      closedLastMonth: closedInMonth(lastMonth),
      currentUser,
      aiEnvDefault: (process.env.AI_MODEL ?? "").trim() || null,
      areas,
      repoSlug: getRepoSlug(),
    };
  });
}
