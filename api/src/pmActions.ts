import { db } from "./db.js";
import { masterFilterSql, type MasterFilter } from "./masterFilter.js";
import type { PmActionCategory, PmActionItem } from "../../shared/types.js";

// Deterministic detectors for "what needs the PM" — the candidate generator half of the
// hybrid PM-actions surface. These never invent: each item is a real issue matching a rule,
// with the matched evidence in `reason`. The AI layer (ai.ts) only reorders/rephrases/drops.

const DAY = 24 * 3600 * 1000;

// Thin-spec fires only on committed/near work — a sparse backlog item isn't PM debt yet.
const THIN_SPEC_MAX_BODY = 200;
// Recently-closed window for post-release artifact prep.
const POST_RELEASE_DAYS = 14;
// A discussion thread this active with no code is likely waiting on a product call.
const DECISION_MIN_COMMENTS = 4;

function daysSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY));
}

function currentMonthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}
function currentWeekKey(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function scopeClause(mf: MasterFilter): { sql: string; params: unknown[] } {
  const f = masterFilterSql(mf);
  return { sql: f ? ` AND ${f.sql}` : "", params: f ? f.params : [] };
}

interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  closed_at: string | null;
  planned_month: string | null;
  planned_week: string | null;
  is_todo: number;
  comment_count: number;
}

interface PullLite {
  state: "open" | "closed";
  merged: number;
  is_draft: number;
  linked: number[];
}

// Map issue number → its linked PRs (open/merged/draft state retained for the rules).
function loadPullsByIssue(): Map<number, PullLite[]> {
  const rows = db()
    .prepare("SELECT state, merged, is_draft, linked_issues FROM pulls")
    .all() as { state: "open" | "closed"; merged: number; is_draft: number; linked_issues: string }[];
  const map = new Map<number, PullLite[]>();
  for (const r of rows) {
    let linked: number[] = [];
    try {
      const v = JSON.parse(r.linked_issues) as unknown;
      if (Array.isArray(v)) linked = v.filter((x): x is number => typeof x === "number");
    } catch {
      /* skip */
    }
    const lite: PullLite = { state: r.state, merged: r.merged, is_draft: r.is_draft, linked };
    for (const n of linked) {
      const arr = map.get(n);
      if (arr) arr.push(lite);
      else map.set(n, [lite]);
    }
  }
  return map;
}

const DEFAULT_ACTION: Record<PmActionCategory, string> = {
  "thin-spec": "Flesh out spec — scope + acceptance criteria",
  "pre-release": "Prep release notes + stakeholder heads-up",
  "post-release": "Capture release notes / customer comms",
  "decision-owed": "Make the product call / set direction",
};

// Lower number = higher priority when one issue matches multiple rules (we keep one).
const CATEGORY_PRIORITY: Record<PmActionCategory, number> = {
  "pre-release": 0,
  "decision-owed": 1,
  "thin-spec": 2,
  "post-release": 3,
};

export function detectPmActions(mf: MasterFilter): PmActionItem[] {
  const now = Date.now();
  const monthKey = currentMonthKey();
  const weekKey = currentWeekKey();
  const scope = scopeClause(mf);

  const rows = db()
    .prepare(
      `SELECT i.number, i.title, i.body, i.state, i.closed_at,
              m.planned_month, m.planned_week, m.is_todo,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_number = i.number) AS comment_count
       FROM issues i
       LEFT JOIN roadmap_meta m ON m.issue_number = i.number
       WHERE 1=1${scope.sql}`,
    )
    .all(...scope.params) as IssueRow[];

  const pullsByIssue = loadPullsByIssue();

  // One candidate per issue — keep the highest-priority matching category.
  const picked = new Map<number, PmActionItem>();
  const consider = (item: PmActionItem): void => {
    const existing = picked.get(item.issueNumber);
    if (!existing || CATEGORY_PRIORITY[item.category] < CATEGORY_PRIORITY[existing.category]) {
      picked.set(item.issueNumber, item);
    }
  };

  for (const r of rows) {
    const committedThisPeriod = r.planned_month === monthKey || r.planned_week === weekKey;
    const committed = committedThisPeriod || !!r.is_todo;
    const pulls = pullsByIssue.get(r.number) ?? [];
    const bodyLen = (r.body ?? "").trim().length;

    if (r.state === "closed") {
      // post-release: shipped recently, artifacts likely still owed.
      if (r.closed_at) {
        const d = daysSince(r.closed_at, now);
        if (d <= POST_RELEASE_DAYS) {
          consider({
            issueNumber: r.number,
            title: r.title,
            category: "post-release",
            reason: `closed ${d}d ago`,
            action: DEFAULT_ACTION["post-release"],
          });
        }
      }
      continue;
    }

    // ── open issues ──
    const livePr = pulls.find((p) => (p.state === "open" && p.is_draft === 0) || p.merged === 1);

    // pre-release: committed this period with code in flight → prep release artifacts.
    if (committedThisPeriod && livePr) {
      const merged = pulls.some((p) => p.merged === 1);
      consider({
        issueNumber: r.number,
        title: r.title,
        category: "pre-release",
        reason: merged ? "PR merged, issue still open" : "PR in flight, due this period",
        action: DEFAULT_ACTION["pre-release"],
      });
    }

    // decision-owed: an active discussion with no code yet — likely waiting on a PM call.
    if (r.comment_count >= DECISION_MIN_COMMENTS && pulls.length === 0) {
      consider({
        issueNumber: r.number,
        title: r.title,
        category: "decision-owed",
        reason: `${r.comment_count} comments, no PR`,
        action: DEFAULT_ACTION["decision-owed"],
      });
    }

    // thin-spec: committed work with a sparse body.
    if (committed && bodyLen < THIN_SPEC_MAX_BODY) {
      consider({
        issueNumber: r.number,
        title: r.title,
        category: "thin-spec",
        reason: bodyLen === 0 ? "no description" : `body ${bodyLen} chars, thin`,
        action: DEFAULT_ACTION["thin-spec"],
      });
    }
  }

  // Stable deterministic order: category priority, then issue number. This is the order
  // shown when AI is off, and the order handed to the AI ranker.
  return [...picked.values()].sort(
    (a, b) =>
      CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category] || a.issueNumber - b.issueNumber,
  );
}
