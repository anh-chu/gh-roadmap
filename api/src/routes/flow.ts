import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getMasterFilter, masterFilterSql } from "../masterFilter.js";
import { computeFlowState, type FlowInput, type FlowThresholdsResolved } from "../flow.js";
import type { FlowResultMap } from "../../../shared/types.js";

interface IssueRow {
  number: number;
  state: "open" | "closed";
  created_at: string | null;
  updated_at: string;
  assignee: string | null;
}

interface PullRow {
  number: number;
  state: "open" | "closed";
  merged: number;
  merged_at: string | null;
  is_draft: number;
  last_commit_at: string | null;
  linked_issues: string;
}

interface ReviewRow {
  pull_number: number;
  state: string;
  submitted_at: string;
  author: string | null;
}

interface CheckRow {
  pull_number: number;
  status: string | null;
  conclusion: string | null;
}

interface CommentAgg {
  issue_number: number;
  cnt: number;
  last_at: string | null;
}

interface EventRow {
  issue_number: number;
  event_type: string;
  created_at: string;
}

interface ThresholdRow {
  flow_shipping_hours: number;
  flow_review_days: number;
  flow_code_days: number;
  flow_discussion_days: number;
  flow_stall_days: number;
  flow_cold_days: number;
  flow_fresh_days: number;
}

// Flow rule metadata, mirrors AttentionRule shape so the existing panel renders both.
interface FlowRule {
  category: "flow-shipping" | "flow-in-review" | "flow-in-code" | "flow-discussing" | "flow-stalled" | "flow-cold" | "flow-fresh";
  label: string;
  description: string;
  thresholds: Array<{ key: string; label: string; min: number; max: number; value: number }>;
  example: string;
}

export async function flowRulesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/flow/rules", async (req) => {
    const t = db()
      .prepare(
        "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days FROM workspace_config WHERE id = ?",
      )
      .get(req.workspaceId) as ThresholdRow | undefined;
    const v = {
      flowShippingHours: t?.flow_shipping_hours ?? 24,
      flowReviewDays: t?.flow_review_days ?? 3,
      flowCodeDays: t?.flow_code_days ?? 3,
      flowDiscussionDays: t?.flow_discussion_days ?? 5,
      flowStallDays: t?.flow_stall_days ?? 14,
      flowColdDays: t?.flow_cold_days ?? 60,
      flowFreshDays: t?.flow_fresh_days ?? 7,
    };
    const rules: FlowRule[] = [
      {
        category: "flow-shipping",
        label: "Shipping",
        description: "Recently merged PR, or open PR approved with green CI.",
        thresholds: [{ key: "flowShippingHours", label: "Merge window (hours)", min: 1, max: 365, value: v.flowShippingHours }],
        example: "PR #420 merged 4h ago.",
      },
      {
        category: "flow-in-review",
        label: "In review",
        description: "Review event submitted on an open PR within the window.",
        thresholds: [{ key: "flowReviewDays", label: "Review activity (days)", min: 1, max: 365, value: v.flowReviewDays }],
        example: "Approved by @uyen 1d ago.",
      },
      {
        category: "flow-in-code",
        label: "In code",
        description: "Open non-draft PR with a recent commit.",
        thresholds: [{ key: "flowCodeDays", label: "Commit activity (days)", min: 1, max: 365, value: v.flowCodeDays }],
        example: "Commit on PR #420 2h ago.",
      },
      {
        category: "flow-discussing",
        label: "Discussing",
        description: "No open PRs but recent issue comments.",
        thresholds: [{ key: "flowDiscussionDays", label: "Comment window (days)", min: 1, max: 365, value: v.flowDiscussionDays }],
        example: "Comment 1d ago, 4 total.",
      },
      {
        category: "flow-stalled",
        label: "Stalled",
        description: "Had activity historically but nothing recently.",
        thresholds: [{ key: "flowStallDays", label: "Stall threshold (days)", min: 1, max: 365, value: v.flowStallDays }],
        example: "No activity in 21 days.",
      },
      {
        category: "flow-cold",
        label: "Cold",
        description: "Open for a long time with no engagement.",
        thresholds: [{ key: "flowColdDays", label: "Cold threshold (days)", min: 1, max: 365, value: v.flowColdDays }],
        example: "Open 92 days, no comments.",
      },
      {
        category: "flow-fresh",
        label: "Fresh",
        description: "Newly created issue, hasn't had time to develop.",
        thresholds: [{ key: "flowFreshDays", label: "Fresh window (days)", min: 1, max: 365, value: v.flowFreshDays }],
        example: "Created 2 days ago.",
      },
    ];
    return rules;
  });
}

export async function flowRoutes(app: FastifyInstance): Promise<void> {
  await flowRulesRoutes(app);
  app.get("/api/flow", async (req) => {
    const t = db()
      .prepare(
        "SELECT flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days, flow_stall_days, flow_cold_days, flow_fresh_days FROM workspace_config WHERE id = ?",
      )
      .get(req.workspaceId) as ThresholdRow | undefined;

    const thresholds: FlowThresholdsResolved = {
      shippingHours: t?.flow_shipping_hours ?? 24,
      reviewActivityDays: t?.flow_review_days ?? 3,
      codeActivityDays: t?.flow_code_days ?? 3,
      discussionDays: t?.flow_discussion_days ?? 5,
      stallDays: t?.flow_stall_days ?? 14,
      coldDays: t?.flow_cold_days ?? 60,
      freshDays: t?.flow_fresh_days ?? 7,
    };

    const mf = masterFilterSql(getMasterFilter(req.workspaceId));
    const scope = mf ? ` WHERE ${mf.sql}` : "";
    const scopeParams = mf ? mf.params : [];

    const issues = db()
      .prepare(
        `SELECT i.number, i.state, i.created_at, i.updated_at, i.assignee FROM issues i${scope}`,
      )
      .all(...scopeParams) as IssueRow[];

    // Build per-issue indexes — fetch all relevant tables once, group in JS.
    const pulls = db()
      .prepare(
        `SELECT number, state, merged, merged_at, is_draft, last_commit_at, linked_issues FROM pulls`,
      )
      .all() as PullRow[];
    const reviews = db()
      .prepare(`SELECT pull_number, state, submitted_at, author FROM pull_reviews`)
      .all() as ReviewRow[];
    const checks = db()
      .prepare(`SELECT pull_number, status, conclusion FROM pull_checks`)
      .all() as CheckRow[];
    const commentAgg = db()
      .prepare(
        `SELECT issue_number, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM comments GROUP BY issue_number`,
      )
      .all() as CommentAgg[];
    const events = db()
      .prepare(`SELECT issue_number, event_type, created_at FROM issue_events`)
      .all() as EventRow[];

    const checksByPull = new Map<number, CheckRow>();
    for (const c of checks) checksByPull.set(c.pull_number, c);
    const reviewsByPull = new Map<number, ReviewRow[]>();
    for (const r of reviews) {
      const arr = reviewsByPull.get(r.pull_number);
      if (arr) arr.push(r);
      else reviewsByPull.set(r.pull_number, [r]);
    }
    const pullsByIssue = new Map<number, PullRow[]>();
    for (const p of pulls) {
      let linked: number[] = [];
      try {
        const parsed = JSON.parse(p.linked_issues) as unknown;
        if (Array.isArray(parsed)) linked = parsed.filter((x): x is number => typeof x === "number");
      } catch { /* skip */ }
      for (const n of linked) {
        const arr = pullsByIssue.get(n);
        if (arr) arr.push(p);
        else pullsByIssue.set(n, [p]);
      }
    }
    const commentsByIssue = new Map<number, CommentAgg>();
    for (const c of commentAgg) commentsByIssue.set(c.issue_number, c);
    const eventsByIssue = new Map<number, EventRow[]>();
    for (const e of events) {
      const arr = eventsByIssue.get(e.issue_number);
      if (arr) arr.push(e);
      else eventsByIssue.set(e.issue_number, [e]);
    }

    const result: FlowResultMap = {};
    for (const i of issues) {
      const linkedPulls = pullsByIssue.get(i.number) ?? [];
      const comment = commentsByIssue.get(i.number);
      const evs = eventsByIssue.get(i.number) ?? [];
      const input: FlowInput = {
        issue: {
          number: i.number,
          state: i.state,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          assignee: i.assignee,
          commentCount: comment?.cnt ?? 0,
          lastCommentAt: comment?.last_at ?? null,
        },
        pulls: linkedPulls.map((p) => ({
          number: p.number,
          state: p.state,
          merged: !!p.merged,
          mergedAt: p.merged_at,
          isDraft: !!p.is_draft,
          lastCommitAt: p.last_commit_at,
          ciStatus: checksByPull.get(p.number)?.status ?? null,
          reviews: (reviewsByPull.get(p.number) ?? []).map((r) => ({
            state: r.state,
            submittedAt: r.submitted_at,
            author: r.author,
          })),
        })),
        events: evs.map((e) => ({ type: e.event_type, createdAt: e.created_at })),
        thresholds,
      };
      result[i.number] = computeFlowState(input);
    }
    return result;
  });
}
