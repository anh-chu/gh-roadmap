import crypto from "node:crypto";
import { db, getKv, setKv } from "./db.js";
import { upsertSnapshot } from "./health.js";
import { listWorkspaces } from "./workspace.js";
import { getMasterFilter, masterFilterSql } from "./masterFilter.js";
import { refreshPinnedProject, projectFilter } from "./routes/projects.js";
import { getRepoSlug } from "./github.js";
import {
  fetchAllIssues,
  fetchAllPulls,
  fetchIssueTimelineSince,
  listRepoMilestonesWithDue,
  type GhComment,
  type GhIssue,
  type GhExternalPull,
  type GhPull,
  type GhReview,
  type GhTimelineEvent,
} from "./github.js";

// Concurrency guard: prevent overlapping reconcile runs from the webhook debounce
// and the poll loop. Manual sync route has its own _syncing flag as well.
let _reconciling = false;
let _reconcileTimer: ReturnType<typeof setTimeout> | null = null;

export function upsertIssue(i: GhIssue): void {
  db()
    .prepare(
      `INSERT INTO issues(number,node_id,title,body,state,assignee,milestone,milestone_due,labels,updated_at,created_at,closed_at,issue_type,issue_type_color,raw)
       VALUES(@number,@node_id,@title,@body,@state,@assignee,@milestone,@milestone_due,@labels,@updated_at,@created_at,@closed_at,@issue_type,@issue_type_color,@raw)
       ON CONFLICT(number) DO UPDATE SET
         node_id=COALESCE(excluded.node_id, issues.node_id),
         title=excluded.title, body=excluded.body, state=excluded.state,
         assignee=excluded.assignee, milestone=excluded.milestone,
         milestone_due=excluded.milestone_due,
         labels=excluded.labels, updated_at=excluded.updated_at,
         created_at=COALESCE(excluded.created_at, issues.created_at),
         closed_at=excluded.closed_at,
         issue_type=COALESCE(excluded.issue_type, issues.issue_type),
         issue_type_color=COALESCE(excluded.issue_type_color, issues.issue_type_color),
         raw=excluded.raw`,
    )
    .run({
      number: i.number,
      node_id: i.node_id,
      title: i.title,
      body: i.body,
      state: i.state,
      assignee: i.assignee,
      milestone: i.milestone,
      milestone_due: i.milestone_due,
      labels: JSON.stringify(i.labels),
      updated_at: i.updated_at,
      created_at: i.created_at,
      closed_at: i.closed_at,
      issue_type: i.issue_type,
      issue_type_color: i.issue_type_color,
      raw: JSON.stringify(i.raw),
    });
}

export function upsertComment(c: GhComment): void {
  db()
    .prepare(
      `INSERT INTO comments(id,issue_number,author,body,created_at,updated_at)
       VALUES(@id,@issue_number,@author,@body,@created_at,@updated_at)
       ON CONFLICT(id) DO UPDATE SET
         body=excluded.body, updated_at=excluded.updated_at, author=excluded.author`,
    )
    .run(c);
}

export function deleteCommentRow(id: number): void {
  db().prepare("DELETE FROM comments WHERE id = ?").run(id);
}

export function upsertPull(p: GhPull): void {
  db()
    .prepare(
      `INSERT INTO pulls(number,title,state,merged,merged_at,author,created_at,updated_at,closed_at,body,linked_issues,raw,is_draft,last_commit_at,head_ref,repo)
       VALUES(@number,@title,@state,@merged,@merged_at,@author,@created_at,@updated_at,@closed_at,@body,@linked_issues,@raw,@is_draft,@last_commit_at,@head_ref,'')
       ON CONFLICT(number) DO UPDATE SET
         title=excluded.title, state=excluded.state, merged=excluded.merged,
         merged_at=excluded.merged_at, author=excluded.author,
         created_at=COALESCE(excluded.created_at, pulls.created_at),
         updated_at=excluded.updated_at, closed_at=excluded.closed_at,
         body=excluded.body, linked_issues=excluded.linked_issues, raw=excluded.raw,
         is_draft=excluded.is_draft,
         last_commit_at=COALESCE(excluded.last_commit_at, pulls.last_commit_at),
         head_ref=COALESCE(excluded.head_ref, pulls.head_ref),
         repo=''`,
    )
    .run({
      number: p.number,
      title: p.title,
      state: p.state,
      merged: p.merged ? 1 : 0,
      merged_at: p.merged_at,
      author: p.author,
      created_at: p.created_at,
      updated_at: p.updated_at,
      closed_at: p.closed_at,
      body: p.body,
      linked_issues: JSON.stringify(p.linked_issues),
      raw: JSON.stringify(p.raw),
      is_draft: p.is_draft ? 1 : 0,
      last_commit_at: p.last_commit_at,
      head_ref: p.head_ref,
    });
}

// Upsert a cross-repo PR (Option A). Collision-safe: product-repo rows (repo='')
// always win, and a same-number row from a *different* external repo is left untouched
// (the DO UPDATE ... WHERE no-ops). No reviews/CI mirror for these — link + state only.
// `linkedIssues` is the merged set of product issues that reference this PR.
export function upsertExternalPull(p: GhExternalPull, linkedIssues: number[]): void {
  db()
    .prepare(
      `INSERT INTO pulls(number,title,state,merged,merged_at,author,created_at,updated_at,closed_at,body,linked_issues,raw,is_draft,last_commit_at,head_ref,repo)
       VALUES(@number,@title,@state,@merged,@merged_at,@author,@created_at,@updated_at,@closed_at,NULL,@linked_issues,@raw,@is_draft,NULL,NULL,@repo)
       ON CONFLICT(number) DO UPDATE SET
         title=excluded.title, state=excluded.state, merged=excluded.merged,
         merged_at=excluded.merged_at, author=excluded.author,
         created_at=COALESCE(excluded.created_at, pulls.created_at),
         updated_at=excluded.updated_at, closed_at=excluded.closed_at,
         linked_issues=excluded.linked_issues, raw=excluded.raw, is_draft=excluded.is_draft
       WHERE pulls.repo = excluded.repo`,
    )
    .run({
      number: p.number,
      title: p.title,
      state: p.state,
      merged: p.merged ? 1 : 0,
      merged_at: p.merged_at,
      author: p.author,
      created_at: p.created_at,
      updated_at: p.updated_at,
      closed_at: p.closed_at,
      linked_issues: JSON.stringify(linkedIssues),
      raw: JSON.stringify(p),
      is_draft: p.is_draft ? 1 : 0,
      repo: p.repo,
    });
}

export function upsertReview(r: GhReview): void {
  db()
    .prepare(
      `INSERT INTO pull_reviews(id,pull_number,author,state,submitted_at)
       VALUES(@id,@pull_number,@author,@state,@submitted_at)
       ON CONFLICT(id) DO UPDATE SET
         author=excluded.author, state=excluded.state, submitted_at=excluded.submitted_at`,
    )
    .run(r);
}

export function upsertPullChecks(pullNumber: number, status: string | null, conclusion: string | null): void {
  db()
    .prepare(
      `INSERT INTO pull_checks(pull_number,status,conclusion,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(pull_number) DO UPDATE SET
         status=excluded.status, conclusion=excluded.conclusion, updated_at=excluded.updated_at`,
    )
    .run(pullNumber, status, conclusion, new Date().toISOString());
}

// Stable 53-bit hash for webhook-derived events (no GH event id in payload). Mirrors
// the hashing used in github.ts fetchIssueTimelineSince so webhook+reconcile dedupe.
export function hashEventId(issueNumber: number, type: string, createdAt: string, extra: string): number {
  const s = `${issueNumber}|${type}|${createdAt}|${extra}`;
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return Number(h & 0x1fffffffffffffn);
}

export function upsertIssueEvent(e: GhTimelineEvent): void {
  db()
    .prepare(
      `INSERT INTO issue_events(id,issue_number,event_type,actor,created_at,payload)
       VALUES(@id,@issue_number,@event_type,@actor,@created_at,@payload)
       ON CONFLICT(id) DO UPDATE SET
         event_type=excluded.event_type, actor=excluded.actor,
         created_at=excluded.created_at, payload=excluded.payload`,
    )
    .run(e);
}

export async function reconcile(opts?: { full?: boolean }): Promise<{
  issues: number;
  comments: number;
  pulls: number;
  reviews: number;
  events: number;
}> {
  if (_reconciling) return { issues: 0, comments: 0, pulls: 0, reviews: 0, events: 0 };
  _reconciling = true;
  try {
  const last = opts?.full ? null : getKv("lastSyncAt");
  const lastWebhook = getKv("lastWebhookAt");

  // Parallel fetch with early page cutoff on incremental sync.
  const [issuesResult, pulls] = await Promise.all([
    fetchAllIssues(last ?? undefined),
    fetchAllPulls(last ?? undefined),
  ]);
  const { issues, comments } = issuesResult;

  // Floor for timeline fetches. First boot: 30 days. Subsequent: lastSyncAt - 7d.
  const floor = last
    ? new Date(Date.parse(last) - 7 * 24 * 3600 * 1000).toISOString()
    : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Skip timeline if webhook has been delivering events since last sync.
  const webhookCurrent = !!(last && lastWebhook && Date.parse(lastWebhook) > Date.parse(last));
  const issuesNeedingTimeline = webhookCurrent
    ? []
    : last
      ? issues.filter((i) => i.updated_at > last)
      : issues;

  // Priority order so a slow or interrupted pass refreshes the work a PM watches first
  // (flow state + cross-repo PR links land on committed work before parking lots).
  // Tier 0: open + scheduled (planned in any workspace); 1: open + unscheduled (TODO/Backlog
  // — distinguishing the two now needs the Projects status join, not worth it here); 2: closed.
  // Recent-first within a tier. is_todo is deprecated (placement reads Projects status), so we
  // key on planned_month/planned_week, the durable "committed to a timeframe" signal.
  const scheduled = new Set(
    (db()
      .prepare("SELECT DISTINCT issue_number FROM roadmap_meta WHERE planned_month IS NOT NULL OR planned_week IS NOT NULL")
      .all() as { issue_number: number }[])
      .map((r) => r.issue_number),
  );
  const syncTier = (i: GhIssue): number =>
    i.state !== "open" ? 2 : scheduled.has(i.number) ? 0 : 1;
  issuesNeedingTimeline.sort(
    (a, b) => syncTier(a) - syncTier(b) || (b.updated_at > a.updated_at ? 1 : -1),
  );

  // Batch timeline fetches 10-wide (network I/O, outside SQLite transaction).
  let totalReviews = 0;
  const allEvents: GhTimelineEvent[] = [];
  // Cross-repo PRs discovered via issue timelines, aggregated by `repo#number` so one
  // PR referencing several product issues upserts once with the merged linked-issue set.
  const externalByKey = new Map<string, { pull: GhExternalPull; issues: Set<number> }>();
  const BATCH = 10;
  for (let i = 0; i < issuesNeedingTimeline.length; i += BATCH) {
    const chunk = issuesNeedingTimeline.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map((issue) => fetchIssueTimelineSince(issue.number, floor, 100)),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      allEvents.push(...r.value.events);
      for (const ext of r.value.externalPulls) {
        const key = `${ext.repo}#${ext.number}`;
        const entry = externalByKey.get(key);
        if (entry) {
          entry.issues.add(ext.linked_issue);
          // Keep the freshest snapshot of the PR's lifecycle.
          if (ext.updated_at > entry.pull.updated_at) entry.pull = ext;
        } else {
          externalByKey.set(key, { pull: ext, issues: new Set([ext.linked_issue]) });
        }
      }
    }
  }

  const tx = db().transaction(() => {
    for (const i of issues) upsertIssue(i);
    for (const c of comments) upsertComment(c);
    for (const p of pulls) {
      upsertPull(p);
      for (const rv of p.reviews) {
        upsertReview(rv);
        totalReviews++;
      }
      if (p.check_status) upsertPullChecks(p.number, p.check_status, p.check_status);
    }
    for (const e of allEvents) upsertIssueEvent(e);
    for (const { pull, issues: linked } of externalByKey.values()) {
      upsertExternalPull(pull, [...linked].sort((a, b) => a - b));
    }
  });
  tx();

  // Milestone due-date reconcile: issue rows only refresh milestone_due when the
  // issue itself changes upstream, so a milestone's due_on edit (or a freshly
  // added column) leaves stale/null values. One cheap REST call aligns all rows.
  try {
    const milestones = await listRepoMilestonesWithDue();
    const align = db().prepare(
      "UPDATE issues SET milestone_due = ? WHERE milestone = ? AND milestone_due IS NOT ?",
    );
    const mtx = db().transaction(() => {
      for (const m of milestones) align.run(m.due_on, m.title, m.due_on);
    });
    mtx();
  } catch (err) {
    console.error("milestone due reconcile failed", err);
  }

  // Milestone → planning snap: while an open issue sits in the TODO or Backlog status
  // and carries a GitHub milestone due, the milestone is authoritative for its timeline
  // position — its planned_month is (re)written to the milestone's month every sync,
  // overriding manual month drags. The PM takes ownership by moving it off TODO/Backlog
  // status (then placement reads its own planned date). Requires a pinned project
  // (status_label source); no-op otherwise. Per-workspace, master-filter scoped
  // (planned dates are per-workspace).
  try {
    const pin = projectFilter();
    if (pin !== null) {
      const now = new Date().toISOString();
      const slug = getRepoSlug() ?? "";
      for (const ws of listWorkspaces()) {
        if (ws.archivedAt) continue;
        const statusRow = db()
          .prepare("SELECT todo_status_name, backlog_status_name FROM workspace_config WHERE id = ?")
          .get(ws.id) as { todo_status_name: string; backlog_status_name: string } | undefined;
        if (!statusRow) continue;
        const mf = masterFilterSql(getMasterFilter(ws.id), "i");
        db()
          .prepare(
            `INSERT INTO roadmap_meta(workspace_id, issue_number, planned_month, planned_week, app_updated_at)
             SELECT ?, i.number, substr(i.milestone_due, 1, 7), NULL, ?
             FROM issues i
             JOIN project_items p ON p.content_number = i.number AND p.content_type = 'Issue'
               AND p.project_number = ${pin} AND (p.content_repo = ? OR p.content_repo IS NULL)
             WHERE i.milestone_due IS NOT NULL
               AND i.state = 'open'
               AND p.status_label IN (?, ?)
               ${mf ? `AND ${mf.sql}` : ""}
             ON CONFLICT(workspace_id, issue_number) DO UPDATE SET
               planned_month = excluded.planned_month,
               planned_week = NULL,
               app_updated_at = excluded.app_updated_at
             WHERE roadmap_meta.planned_month IS NOT excluded.planned_month
                OR roadmap_meta.planned_week IS NOT NULL`,
          )
          .run(ws.id, now, slug, statusRow.todo_status_name, statusRow.backlog_status_name, ...(mf?.params ?? []));
      }
    }
  } catch (err) {
    console.error("milestone planning snap failed", err);
  }

  // Pinned-project refresh: project_items otherwise only refresh when the Kanban
  // routes are hit, so Roadmap-only sessions would join stale status forever.
  // Forces past the 60s freshness gate; no-op when GITHUB_PROJECT_NUMBER is unset.
  try {
    await refreshPinnedProject();
  } catch (err) {
    console.error("pinned project refresh failed", err);
  }

  setKv("lastSyncAt", new Date().toISOString());
  return {
    issues: issues.length,
    comments: comments.length,
    pulls: pulls.length,
    reviews: totalReviews,
    events: allEvents.length,
  };
  } finally {
    _reconciling = false;
  }
}

// Schedule a reconcile after a debounce delay. Used by webhook handler so that
// changes pushed via GitHub appear within seconds instead of waiting for the next
// poll cycle. Debounce prevents a burst of webhooks from triggering N reconciles.
export function scheduleReconcile(delayMs = 10_000): void {
  if (_reconcileTimer) clearTimeout(_reconcileTimer);
  _reconcileTimer = setTimeout(() => {
    _reconcileTimer = null;
    if (_reconciling) {
      // Another reconcile is in-flight — try again after delay.
      scheduleReconcile(delayMs);
      return;
    }
    reconcile()
      .then((r) => console.log(`webhook reconcile done – ${JSON.stringify(r)}`))
      .catch((err) => console.error("webhook reconcile failed", err));
  }, delayMs);
}

// Daily health snapshot — captured per UTC day, one row per non-archived workspace.
// Upserts so a same-day call refreshes the row, and the timeseries always has the
// latest read for "today".
export function runDailySnapshot(): { snapshots: ReturnType<typeof upsertSnapshot>[] } {
  return { snapshots: listWorkspaces().map((ws) => upsertSnapshot(ws.id)) };
}

// GitHub signs webhook bodies with HMAC-SHA256 (X-Hub-Signature-256: "sha256=<hex>").
// We must compare against the *raw* request body, not a re-serialised JSON — Fastify
// gives us the parsed object by default, so the route uses a rawBody hook.
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type WebhookIssuePayload = {
  action: string;
  issue: {
    number: number;
    node_id?: string;
    title: string;
    body: string | null;
    state: "open" | "closed";
    assignee: { login: string } | null;
    milestone: { title: string; due_on?: string | null } | null;
    labels: { name: string }[];
    updated_at: string;
    created_at?: string;
    closed_at?: string | null;
  };
};

type WebhookPullPayload = {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    merged: boolean;
    merged_at: string | null;
    user: { login: string } | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    draft?: boolean;
    head?: { ref?: string; sha?: string };
  };
};

type WebhookReviewPayload = {
  action: string;
  pull_request: { number: number };
  review: {
    id: number;
    user: { login: string } | null;
    state: string; // "approved" | "changes_requested" | "commented" | "dismissed"
    submitted_at: string | null;
  };
};

type WebhookCheckPayload = {
  action: string;
  // check_suite and check_run share enough shape — we only use status/conclusion + linked PRs.
  check_suite?: {
    status: string | null;
    conclusion: string | null;
    pull_requests: { number: number }[];
  };
  check_run?: {
    status: string | null;
    conclusion: string | null;
    pull_requests: { number: number }[];
  };
};

type WebhookIssueLabeledPayload = {
  action: "labeled" | "unlabeled" | "assigned" | "unassigned";
  issue: { number: number };
  sender?: { login: string } | null;
  label?: { name: string };
  assignee?: { login: string } | null;
};

type WebhookCommentPayload = {
  action: "created" | "edited" | "deleted";
  issue: { number: number };
  comment: {
    id: number;
    user: { login: string } | null;
    body: string;
    created_at: string;
    updated_at: string;
  };
};

export function handleWebhook(event: string, payload: unknown): void {
  setKv("lastWebhookAt", new Date().toISOString());
  // Drop the __raw request Buffer the webhook route attaches for HMAC verification:
  // JSON.stringify serializes a Buffer as a giant {type,data:[...]} number array,
  // ~5x the real payload, bloating sync_log on every event.
  const { __raw, ...stored } = (payload ?? {}) as { __raw?: unknown };
  void __raw;
  db()
    .prepare("INSERT INTO sync_log(event_type,payload,processed_at) VALUES(?,?,?)")
    .run(event, JSON.stringify(stored), new Date().toISOString());
  // Debounced reconcile so changes appear without manual click.
  scheduleReconcile(10_000);

  if (event === "issues") {
    const p = payload as WebhookIssuePayload;
    if (!p.issue) return;
    upsertIssue({
      number: p.issue.number,
      node_id: p.issue.node_id ?? null,
      title: p.issue.title,
      body: p.issue.body,
      state: p.issue.state,
      assignee: p.issue.assignee?.login ?? null,
      milestone: p.issue.milestone?.title ?? null,
      milestone_due: p.issue.milestone?.due_on ?? null,
      labels: p.issue.labels.map((l) => l.name),
      issue_type: null,
      issue_type_color: null,
      updated_at: p.issue.updated_at,
      created_at: p.issue.created_at ?? null,
      closed_at: p.issue.closed_at ?? null,
      raw: p.issue,
    });
    // Mirror label/assignee actions as issue_events so the flow engine sees the trail.
    const labelAction = (payload as { action?: string }).action ?? "";
    if (labelAction === "labeled" || labelAction === "unlabeled" || labelAction === "assigned" || labelAction === "unassigned") {
      const lp = payload as WebhookIssueLabeledPayload;
      const created = new Date().toISOString();
      const actor = lp.sender?.login ?? null;
      const extra =
        labelAction === "labeled" || labelAction === "unlabeled"
          ? (lp.label?.name ?? "")
          : (lp.assignee?.login ?? "");
      const payloadJson = JSON.stringify(
        labelAction === "labeled" || labelAction === "unlabeled"
          ? { label: lp.label?.name }
          : { assignee: lp.assignee?.login },
      );
      upsertIssueEvent({
        id: hashEventId(lp.issue.number, labelAction, created, extra),
        issue_number: lp.issue.number,
        event_type: labelAction,
        actor,
        created_at: created,
        payload: payloadJson,
      });
    }
  } else if (event === "pull_request") {
    const p = payload as WebhookPullPayload;
    if (!p.pull_request) return;
    const pr = p.pull_request;
    const LINK_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*[:#]?\s*#(\d+)/gi;
    const linked: number[] = [];
    if (pr.body) {
      let m: RegExpExecArray | null;
      while ((m = LINK_RE.exec(pr.body)) !== null) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) linked.push(n);
      }
    }
    upsertPull({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: !!pr.merged,
      merged_at: pr.merged_at,
      author: pr.user?.login ?? null,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at,
      body: pr.body,
      linked_issues: [...new Set(linked)].sort((a, b) => a - b),
      raw: pr,
      is_draft: !!pr.draft,
      head_ref: pr.head?.ref ?? null,
      last_commit_at: null, // webhook lacks committedDate; reconcile fills it
      check_status: null,
      reviews: [],
    });
  } else if (event === "pull_request_review") {
    const p = payload as WebhookReviewPayload;
    if (!p.review || !p.pull_request) return;
    if (!p.review.submitted_at) return;
    upsertReview({
      id: p.review.id,
      pull_number: p.pull_request.number,
      author: p.review.user?.login ?? null,
      // Normalise to GraphQL-style uppercase to match reconcile output.
      state: p.review.state.toUpperCase(),
      submitted_at: p.review.submitted_at,
    });
  } else if (event === "check_suite" || event === "check_run") {
    const p = payload as WebhookCheckPayload;
    const c = p.check_suite ?? p.check_run;
    if (!c || !Array.isArray(c.pull_requests)) return;
    // Translate GH webhook status/conclusion → our StatusState mirror.
    // status: queued|in_progress|completed; conclusion: success|failure|neutral|cancelled|timed_out|action_required|stale
    let rollup: string | null = null;
    if (c.status !== "completed") rollup = "PENDING";
    else if (c.conclusion === "success") rollup = "SUCCESS";
    else if (c.conclusion === "failure" || c.conclusion === "timed_out") rollup = "FAILURE";
    else if (c.conclusion === "action_required" || c.conclusion === "cancelled") rollup = "ERROR";
    else rollup = c.conclusion ? c.conclusion.toUpperCase() : null;
    for (const pr of c.pull_requests) {
      upsertPullChecks(pr.number, rollup, c.conclusion);
    }
  } else if (event === "issue_comment") {
    const p = payload as WebhookCommentPayload;
    if (p.action === "deleted") {
      deleteCommentRow(p.comment.id);
    } else {
      upsertComment({
        id: p.comment.id,
        issue_number: p.issue.number,
        author: p.comment.user?.login ?? null,
        body: p.comment.body,
        created_at: p.comment.created_at,
        updated_at: p.comment.updated_at,
      });
    }
  }
}

// Per-issue debounce: queue writes and flush after 300ms idle. The writer function
// is provided by callers (e.g. PATCH /api/issues/:num) so this stays generic.
const debounceTimers = new Map<string, NodeJS.Timeout>();
export function debounce(key: string, fn: () => void, ms = 300): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms);
  debounceTimers.set(key, t);
}
