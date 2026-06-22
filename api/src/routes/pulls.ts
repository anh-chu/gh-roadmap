import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getMasterFilter, masterFilterSql } from "../masterFilter.js";
import type { ApiPull, PullCi, PullReviewDecision } from "../../../shared/types.js";

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
  is_draft: number;
  last_commit_at: string | null;
  repo: string;
};

type ReviewRow = { pull_number: number; state: string; submitted_at: string; author: string | null };
type CheckRow = { pull_number: number; status: string | null; conclusion: string | null };

// pull_checks → normalized CI badge. Conclusion (when present) wins; else fall back to run status.
function normalizeCi(c: CheckRow | undefined): PullCi {
  if (!c) return null;
  const concl = (c.conclusion ?? "").toUpperCase();
  if (concl === "SUCCESS") return "success";
  if (concl && concl !== "NEUTRAL" && concl !== "SKIPPED") return "failure";
  const status = (c.status ?? "").toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  return null;
}

// Latest review per author → net decision. Any changes-requested wins, else approved, else commented.
function normalizeReview(rows: ReviewRow[] | undefined): PullReviewDecision {
  if (!rows || rows.length === 0) return null;
  const latest = new Map<string, ReviewRow>();
  for (const r of rows) {
    const key = r.author ?? "?";
    const prev = latest.get(key);
    if (!prev || r.submitted_at > prev.submitted_at) latest.set(key, r);
  }
  const states = [...latest.values()].map((r) => r.state.toUpperCase());
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "commented";
}

function rowToApi(
  r: PullRow,
  checksByPull: Map<number, CheckRow>,
  reviewsByPull: Map<number, ReviewRow[]>,
): ApiPull {
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
    isDraft: !!r.is_draft,
    ci: normalizeCi(checksByPull.get(r.number)),
    reviewDecision: normalizeReview(reviewsByPull.get(r.number)),
    lastCommitAt: r.last_commit_at,
    repo: r.repo ?? "",
  };
}

// Load reviews + checks for the given PR numbers, grouped for rowToApi.
function loadPullDetail(numbers: number[]): {
  checksByPull: Map<number, CheckRow>;
  reviewsByPull: Map<number, ReviewRow[]>;
} {
  const checksByPull = new Map<number, CheckRow>();
  const reviewsByPull = new Map<number, ReviewRow[]>();
  if (numbers.length === 0) return { checksByPull, reviewsByPull };
  const placeholders = numbers.map(() => "?").join(",");
  const checks = db()
    .prepare(`SELECT pull_number, status, conclusion FROM pull_checks WHERE pull_number IN (${placeholders})`)
    .all(...numbers) as CheckRow[];
  for (const c of checks) checksByPull.set(c.pull_number, c);
  const reviews = db()
    .prepare(`SELECT pull_number, state, submitted_at, author FROM pull_reviews WHERE pull_number IN (${placeholders})`)
    .all(...numbers) as ReviewRow[];
  for (const r of reviews) {
    const arr = reviewsByPull.get(r.pull_number);
    if (arr) arr.push(r);
    else reviewsByPull.set(r.pull_number, [r]);
  }
  return { checksByPull, reviewsByPull };
}

// Master-filter pass rule: drop PR if it has linked issues AND none of them pass the filter.
// If it has no linked issues, pass through.
function buildAllowedIssueSet(workspaceId: number): Set<number> | null {
  const mf = masterFilterSql(getMasterFilter(workspaceId));
  if (!mf) return null; // no filter — everything allowed
  const rows = db()
    .prepare(`SELECT number FROM issues i WHERE ${mf.sql}`)
    .all(...mf.params) as { number: number }[];
  return new Set(rows.map((r) => r.number));
}

export async function pullsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pulls", async (req) => {
    const allowed = buildAllowedIssueSet(req.workspaceId);
    const rows = db()
      .prepare(
        `SELECT number, title, state, merged, merged_at, author, created_at, updated_at, closed_at, linked_issues, is_draft, last_commit_at, repo
         FROM pulls
         ORDER BY updated_at DESC`,
      )
      .all() as PullRow[];
    const { checksByPull, reviewsByPull } = loadPullDetail(rows.map((r) => r.number));
    const out: ApiPull[] = [];
    for (const r of rows) {
      const api = rowToApi(r, checksByPull, reviewsByPull);
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
      `SELECT number, title, state, merged, merged_at, author, created_at, updated_at, closed_at, linked_issues, is_draft, last_commit_at, repo
       FROM pulls
       WHERE EXISTS (SELECT 1 FROM json_each(linked_issues) WHERE value = ?)
       ORDER BY updated_at DESC`,
    )
    .all(num) as PullRow[];
  const { checksByPull, reviewsByPull } = loadPullDetail(rows.map((r) => r.number));
  return rows.map((r) => rowToApi(r, checksByPull, reviewsByPull));
}
