import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getMasterFilter, masterFilterSql } from "../masterFilter.js";
import type { ApiPull } from "../../../shared/types.js";

type PullRow = {
  number: number;
  title: string;
  state: string;
  merged: number;
  merged_at: string | null;
  author: string | null;
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  linked_issues: string;
};

function rowToApi(r: PullRow): ApiPull {
  let linked: number[] = [];
  try {
    const parsed = JSON.parse(r.linked_issues) as unknown;
    if (Array.isArray(parsed)) linked = parsed.filter((x): x is number => typeof x === "number");
  } catch { /* leave [] */ }
  return {
    number: r.number,
    title: r.title,
    state: r.state === "open" ? "open" : "closed",
    merged: !!r.merged,
    mergedAt: r.merged_at,
    author: r.author,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    linkedIssues: linked,
  };
}

// Master-filter pass rule: drop PR if it has linked issues AND none of them pass the filter.
// If it has no linked issues, pass through.
function buildAllowedIssueSet(): Set<number> | null {
  const mf = masterFilterSql(getMasterFilter());
  if (!mf) return null; // no filter — everything allowed
  const rows = db()
    .prepare(`SELECT number FROM issues i WHERE ${mf.sql}`)
    .all(...mf.params) as { number: number }[];
  return new Set(rows.map((r) => r.number));
}

export async function pullsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pulls", async () => {
    const allowed = buildAllowedIssueSet();
    const rows = db()
      .prepare(
        `SELECT number, title, state, merged, merged_at, author, created_at, updated_at, closed_at, linked_issues
         FROM pulls
         ORDER BY updated_at DESC`,
      )
      .all() as PullRow[];
    const out: ApiPull[] = [];
    for (const r of rows) {
      const api = rowToApi(r);
      if (allowed && api.linkedIssues.length > 0) {
        const anyPass = api.linkedIssues.some((n) => allowed.has(n));
        if (!anyPass) continue;
      }
      out.push(api);
    }
    return out;
  });
}

// Helper used by other modules — returns linked PRs for a given issue number.
export function getPullsForIssue(num: number): ApiPull[] {
  const rows = db()
    .prepare(
      `SELECT number, title, state, merged, merged_at, author, created_at, updated_at, closed_at, linked_issues
       FROM pulls
       WHERE EXISTS (SELECT 1 FROM json_each(linked_issues) WHERE value = ?)
       ORDER BY updated_at DESC`,
    )
    .all(num) as PullRow[];
  return rows.map(rowToApi);
}
