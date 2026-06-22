import { App, Octokit } from "octokit";

export type GhIssue = {
  number: number;
  node_id: string | null; // GraphQL node id; null on payloads that lack it (never overwrites stored value)
  title: string;
  body: string | null;
  state: "open" | "closed";
  assignee: string | null;
  milestone: string | null;
  milestone_due: string | null;
  labels: string[];
  updated_at: string;
  created_at: string | null;
  closed_at: string | null;
  raw: unknown;
};

export type GhComment = {
  id: number;
  issue_number: number;
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type RateLimit = {
  remaining: number;
  limit: number;
  reset: number; // epoch seconds
};

let _octo: Octokit | null = null;
let _owner = "";
let _repo = "";
let _rate: RateLimit = { remaining: 5000, limit: 5000, reset: 0 };
// App-auth mode + the resolved bot login ("<app-slug>[bot]"). Under App auth GET /user
// 403s, so getAuthenticatedLogin() returns this instead of calling it.
let _appAuth = false;
let _serviceLogin: string | null = null;

export interface GithubInit {
  owner: string;
  repo: string;
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: string;
}

// True when GITHUB_OWNER/REPO are set and either a PAT (GITHUB_TOKEN) or a full
// GitHub App credential triple is present. Single source of truth for "is GitHub
// usable" — server boot and every route guard call this.
export function isGithubConfigured(): boolean {
  if (!process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) return false;
  const hasPat = !!process.env.GITHUB_TOKEN;
  const hasApp = !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_APP_INSTALLATION_ID
  );
  return hasPat || hasApp;
}

// Accept the private key as raw PEM (real newlines), PEM with literal "\n"
// escapes (single-line .env), or base64 of the PEM (systemd-friendly).
function normalizePrivateKey(raw: string): string {
  const v = raw.trim();
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  return Buffer.from(v, "base64").toString("utf8");
}

function attachRateLimitHook(o: Octokit): void {
  o.hook.after("request", (response) => {
    const h = response.headers as Record<string, string | undefined>;
    const rem = h["x-ratelimit-remaining"];
    const lim = h["x-ratelimit-limit"];
    const rst = h["x-ratelimit-reset"];
    if (rem) _rate.remaining = Number(rem);
    if (lim) _rate.limit = Number(lim);
    if (rst) _rate.reset = Number(rst);
  });
}

// GitHub App credentials take precedence over a PAT: the installation Octokit mints
// short-lived (~1h) tokens and auto-renews them, so the shared service identity acts
// as the app's bot rather than a person. serviceOctokit() returns this client. Falls
// back to a static PAT token when App creds are absent.
export async function initGithub(opts: GithubInit): Promise<void> {
  _owner = opts.owner;
  _repo = opts.repo;

  if (opts.appId && opts.privateKey && opts.installationId) {
    const app = new App({
      appId: Number(opts.appId),
      privateKey: normalizePrivateKey(opts.privateKey),
    });
    _octo = await app.getInstallationOctokit(Number(opts.installationId));
    _appAuth = true;
    // Resolve the bot login once (the JWT-authed app client can read GET /app; the
    // installation token cannot). Best-effort — on failure the bot name just stays unset.
    _serviceLogin = null;
    try {
      const { data } = await app.octokit.request("GET /app");
      if (data?.slug) _serviceLogin = `${data.slug}[bot]`;
    } catch {
      /* leave _serviceLogin null */
    }
  } else if (opts.token) {
    _octo = new Octokit({ auth: opts.token });
    _appAuth = false;
    _serviceLogin = null;
  } else {
    throw new Error("initGithub: provide a GITHUB_TOKEN or GitHub App credentials");
  }

  attachRateLimitHook(_octo);
}

// True when the service identity is a GitHub App installation (writes appear as the bot).
export function isAppAuth(): boolean {
  return _appAuth;
}

function octo(): Octokit {
  if (!_octo) throw new Error("github not initialised — call initGithub() first");
  return _octo;
}

// The shared service-token client. Reads and background jobs use this; write fns take an
// explicit Octokit (caller passes serviceOctokit() today, a per-user client post-OAuth).
export function serviceOctokit(): Octokit {
  return octo();
}

// A throwaway client for a user's OAuth token. No caching — instantiate per call.
export function octokitForToken(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function getRateLimitStatus(): RateLimit {
  return { ..._rate };
}

// "owner/repo" of the issues repo, or null when GitHub is unconfigured.
// Used to build issue web links (https://github.com/<slug>/issues/<n>).
export function getRepoSlug(): string | null {
  if (!_owner || !_repo) return null;
  return `${_owner}/${_repo}`;
}

export async function getAuthenticatedLogin(): Promise<string | null> {
  if (!_octo) return null;
  // Installation tokens 403 on GET /user — return the resolved bot login instead (and
  // skip the doomed request, which would otherwise fire on every /api/meta poll).
  if (_appAuth) return _serviceLogin;
  try {
    const { data } = await _octo.rest.users.getAuthenticated();
    return data.login ?? null;
  } catch {
    return null;
  }
}

type GqlIssueNode = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  createdAt: string;
  closedAt: string | null;
  assignees: { nodes: { login: string }[] };
  milestone: { title: string; dueOn: string | null } | null;
  labels: { nodes: { name: string }[] };
  comments: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      databaseId: number;
      author: { login: string } | null;
      body: string;
      createdAt: string;
      updatedAt: string;
    }[];
  };
};

type GqlIssuesPage = {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlIssueNode[];
    };
  };
};

const ISSUES_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN, CLOSED]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          updatedAt
          createdAt
          closedAt
          assignees(first: 1) { nodes { login } }
          milestone { title dueOn }
          labels(first: 30) { nodes { name } }
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes {
              databaseId
              author { login }
              body
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
`;

export type GhPull = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  author: string | null;
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  body: string | null;
  linked_issues: number[];
  raw: unknown;
  // Flow-state extras.
  is_draft: boolean;
  head_ref: string | null;
  last_commit_at: string | null;
  check_status: string | null; // GH StatusState rollup (SUCCESS, FAILURE, PENDING, ERROR, EXPECTED) | null
  reviews: GhReview[];
};

export type GhReview = {
  id: number;
  pull_number: number;
  author: string | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at: string;
};

export type GhTimelineEvent = {
  id: number;
  issue_number: number;
  event_type: string;
  actor: string | null;
  created_at: string;
  payload: string | null;
};

// A PR in a different repo that references a product issue, surfaced via the issue
// timeline. Mirrored into `pulls` (repo != '') so cross-repo work shows on the issue.
export type GhExternalPull = {
  repo: string; // owner/name (always non-empty)
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  is_draft: boolean;
  author: string | null;
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  url: string;
  linked_issue: number; // the product issue whose timeline surfaced this PR
};

type GqlPullNode = {
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isDraft: boolean;
  headRefName: string | null;
  author: { login: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
  commits: {
    nodes: {
      commit: {
        committedDate: string | null;
        statusCheckRollup: { state: string } | null;
      };
    }[];
  };
  reviews: {
    nodes: {
      databaseId: number | null;
      author: { login: string } | null;
      state: string;
      submittedAt: string | null;
    }[];
  };
};

type GqlPullsPage = {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlPullNode[];
    };
  };
};

// Pulls query — captures full PR mirror: draft flag, head ref, last commit (+CI rollup),
// recent reviews, linked issues. `commits(last: 1)` gives the tip commit and its
// statusCheckRollup; `reviews(first: 50)` covers all but the most pathological PRs.
const PULLS_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN, CLOSED, MERGED]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          merged
          mergedAt
          createdAt
          updatedAt
          closedAt
          isDraft
          headRefName
          author { login }
          closingIssuesReferences(first: 20) { nodes { number } }
          commits(last: 1) {
            nodes {
              commit {
                committedDate
                statusCheckRollup { state }
              }
            }
          }
          reviews(first: 50) {
            nodes {
              databaseId
              author { login }
              state
              submittedAt
            }
          }
        }
      }
    }
  }
`;

// Parse "Closes #123", "Fixes #45", "Resolves #6" from PR body — covers cases
// where GH didn't auto-link (manual reference, non-default keyword case, etc.).
const LINK_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*[:#]?\s*#(\d+)/gi;
function parseLinkedFromBody(body: string | null): number[] {
  if (!body) return [];
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(body)) !== null) {
    const num = Number(m[1]);
    if (Number.isFinite(num)) out.push(num);
  }
  return out;
}

function dedupeSort(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export async function fetchAllPulls(lastSyncAt?: string): Promise<GhPull[]> {
  const out: GhPull[] = [];
  let cursor: string | null = null;
  const cutoff = lastSyncAt ? new Date(lastSyncAt).getTime() : 0;
  for (;;) {
    const data: GqlPullsPage = await octo().graphql<GqlPullsPage>(PULLS_QUERY, {
      owner: _owner,
      repo: _repo,
      cursor,
    });
    const page = data.repository.pullRequests;
    let cutoffHit = false;
    for (const n of page.nodes) {
      if (cutoff && new Date(n.updatedAt).getTime() < cutoff) {
        cutoffHit = true;
        break;
      }
      const linked = dedupeSort([
        ...n.closingIssuesReferences.nodes.map((x) => x.number),
        ...parseLinkedFromBody(n.body),
      ]);
      const tip = n.commits?.nodes?.[0]?.commit;
      const reviews: GhReview[] = (n.reviews?.nodes ?? [])
        .filter((r): r is { databaseId: number; author: { login: string } | null; state: string; submittedAt: string } =>
          typeof r.databaseId === "number" && typeof r.submittedAt === "string",
        )
        .map((r) => ({
          id: r.databaseId,
          pull_number: n.number,
          author: r.author?.login ?? null,
          state: r.state,
          submitted_at: r.submittedAt,
        }));
      out.push({
        number: n.number,
        title: n.title,
        state: n.state === "OPEN" ? "open" : "closed",
        merged: !!n.merged,
        merged_at: n.mergedAt,
        author: n.author?.login ?? null,
        created_at: n.createdAt,
        updated_at: n.updatedAt,
        closed_at: n.closedAt,
        body: n.body,
        linked_issues: linked,
        raw: n,
        is_draft: !!n.isDraft,
        head_ref: n.headRefName ?? null,
        last_commit_at: tip?.committedDate ?? null,
        check_status: tip?.statusCheckRollup?.state ?? null,
        reviews,
      });
    }
    if (cutoffHit || !page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

export async function fetchAllIssues(lastSyncAt?: string): Promise<{ issues: GhIssue[]; comments: GhComment[] }> {
  const issues: GhIssue[] = [];
  const comments: GhComment[] = [];
  let cursor: string | null = null;
  const cutoff = lastSyncAt ? new Date(lastSyncAt).getTime() : 0;

  for (;;) {
    const data: GqlIssuesPage = await octo().graphql<GqlIssuesPage>(ISSUES_QUERY, {
      owner: _owner,
      repo: _repo,
      cursor,
    });
    const page: GqlIssuesPage["repository"]["issues"] = data.repository.issues;
    let cutoffHit = false;
    for (const n of page.nodes) {
      if (cutoff && new Date(n.updatedAt).getTime() < cutoff) {
        cutoffHit = true;
        break;
      }
      issues.push({
        number: n.number,
        node_id: n.id,
        title: n.title,
        body: n.body,
        state: n.state === "OPEN" ? "open" : "closed",
        assignee: n.assignees.nodes[0]?.login ?? null,
        milestone: n.milestone?.title ?? null,
        milestone_due: n.milestone?.dueOn ?? null,
        labels: n.labels.nodes.map((l) => l.name),
        updated_at: n.updatedAt,
        created_at: n.createdAt,
        closed_at: n.closedAt,
        raw: n,
      });
      for (const c of n.comments.nodes) {
        comments.push({
          id: c.databaseId,
          issue_number: n.number,
          author: c.author?.login ?? null,
          body: c.body,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        });
      }
      // Issues with >50 comments fall back to REST pagination.
      if (n.comments.pageInfo.hasNextPage) {
        const more = await restFetchComments(n.number);
        for (const c of more) {
          if (!comments.find((x) => x.id === c.id)) comments.push(c);
        }
      }
    }
    if (cutoffHit || !page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { issues, comments };
}

async function restFetchComments(issueNumber: number): Promise<GhComment[]> {
  const out: GhComment[] = [];
  const iter = octo().paginate.iterator(octo().rest.issues.listComments, {
    owner: _owner,
    repo: _repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for await (const { data } of iter) {
    for (const c of data) {
      out.push({
        id: c.id,
        issue_number: issueNumber,
        author: c.user?.login ?? null,
        body: c.body ?? "",
        created_at: c.created_at,
        updated_at: c.updated_at,
      });
    }
  }
  return out;
}

export type IssuePatch = {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignee?: string | null;
  milestone?: string | null;
};

// Full repo label set (not just labels currently applied to issues).
export async function listRepoLabels(): Promise<string[]> {
  const out: string[] = [];
  const iter = octo().paginate.iterator(octo().rest.issues.listLabelsForRepo, {
    owner: _owner,
    repo: _repo,
    per_page: 100,
  });
  for await (const { data } of iter) for (const l of data) out.push(l.name);
  return [...new Set(out)].sort();
}

// Full repo milestone set (open + closed), by title.
export async function listRepoMilestones(): Promise<string[]> {
  const out: string[] = [];
  for (const state of ["open", "closed"] as const) {
    const iter = octo().paginate.iterator(octo().rest.issues.listMilestones, {
      owner: _owner,
      repo: _repo,
      state,
      per_page: 100,
    });
    for await (const { data } of iter) for (const m of data) out.push(m.title);
  }
  return [...new Set(out)].sort();
}

// Full repo milestone set with due dates, for the milestone_due reconcile pass.
export async function listRepoMilestonesWithDue(): Promise<
  { title: string; due_on: string | null }[]
> {
  const out: { title: string; due_on: string | null }[] = [];
  const iter = octo().paginate.iterator(octo().rest.issues.listMilestones, {
    owner: _owner,
    repo: _repo,
    state: "all",
    per_page: 100,
  });
  for await (const { data } of iter)
    for (const m of data) out.push({ title: m.title, due_on: m.due_on ?? null });
  return out;
}

async function resolveMilestoneNumber(title: string): Promise<number | null> {
  // GH milestone API takes a number, not a title. Look up by title across open + closed.
  for (const state of ["open", "closed"] as const) {
    const { data } = await octo().rest.issues.listMilestones({
      owner: _owner,
      repo: _repo,
      state,
      per_page: 100,
    });
    const hit = data.find((m) => m.title === title);
    if (hit) return hit.number;
  }
  return null;
}

export async function updateIssue(octo: Octokit, num: number, patch: IssuePatch): Promise<GhIssue> {
  const params: Record<string, unknown> = {
    owner: _owner,
    repo: _repo,
    issue_number: num,
  };
  if (patch.title !== undefined) params.title = patch.title;
  if (patch.body !== undefined) params.body = patch.body;
  if (patch.state !== undefined) params.state = patch.state;
  if (patch.labels !== undefined) params.labels = patch.labels;
  if (patch.assignee !== undefined) params.assignees = patch.assignee ? [patch.assignee] : [];
  if (patch.milestone !== undefined) {
    if (patch.milestone === null) params.milestone = null;
    else {
      const n = await resolveMilestoneNumber(patch.milestone);
      if (n === null) throw new Error(`milestone not found: ${patch.milestone}`);
      params.milestone = n;
    }
  }

  const { data } = await octo.rest.issues.update(params as never);
  return {
    number: data.number,
    node_id: data.node_id ?? null,
    title: data.title,
    body: data.body ?? null,
    state: data.state === "open" ? "open" : "closed",
    assignee: data.assignee?.login ?? null,
    milestone: data.milestone?.title ?? null,
    milestone_due: data.milestone?.due_on ?? null,
    labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    updated_at: data.updated_at,
    created_at: data.created_at ?? null,
    closed_at: data.closed_at ?? null,
    raw: data,
  };
}

export type IssueCreate = {
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string | null;
};

export async function createIssue(octo: Octokit, input: IssueCreate): Promise<GhIssue> {
  const params: Record<string, unknown> = {
    owner: _owner,
    repo: _repo,
    title: input.title,
  };
  if (input.body !== undefined) params.body = input.body;
  if (input.labels !== undefined) params.labels = input.labels;
  if (input.assignee) params.assignees = [input.assignee];

  const { data } = await octo.rest.issues.create(params as never);
  return {
    number: data.number,
    node_id: data.node_id ?? null,
    title: data.title,
    body: data.body ?? null,
    state: data.state === "open" ? "open" : "closed",
    assignee: data.assignee?.login ?? null,
    milestone: data.milestone?.title ?? null,
    milestone_due: data.milestone?.due_on ?? null,
    labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    updated_at: data.updated_at,
    created_at: data.created_at ?? null,
    closed_at: data.closed_at ?? null,
    raw: data,
  };
}

export async function createComment(octo: Octokit, num: number, body: string): Promise<GhComment> {
  const { data } = await octo.rest.issues.createComment({
    owner: _owner,
    repo: _repo,
    issue_number: num,
    body,
  });
  return {
    id: data.id,
    issue_number: num,
    author: data.user?.login ?? null,
    body: data.body ?? "",
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export async function updateComment(octo: Octokit, id: number, body: string): Promise<GhComment> {
  const { data } = await octo.rest.issues.updateComment({
    owner: _owner,
    repo: _repo,
    comment_id: id,
    body,
  });
  // issue_number not present on response; caller knows.
  return {
    id: data.id,
    issue_number: 0,
    author: data.user?.login ?? null,
    body: data.body ?? "",
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export async function deleteComment(octo: Octokit, id: number): Promise<void> {
  await octo.rest.issues.deleteComment({
    owner: _owner,
    repo: _repo,
    comment_id: id,
  });
}

// ─────────────── PROJECTS (v2) ───────────────
// GitHub Projects v2 is GraphQL-only. We target projects linked to the configured repo.
// Token must have the `project` scope.

export interface GhProjectStatusOption {
  id: string;
  name: string;
}

export interface GhProjectSummary {
  number: number;
  nodeId: string;
  title: string;
  statusFieldId: string | null;
  statusOptions: GhProjectStatusOption[];
  fieldsJson: string;
}

export interface GhProjectItemRaw {
  itemId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  contentNumber: number | null;
  contentRepo: string | null;
  contentTitle: string;
  statusOptionId: string | null;
  statusLabel: string | null;
  assignees: string[];
  raw: unknown;
}

type GqlProjectV2 = {
  id: string;
  number: number;
  title: string;
  fields: {
    nodes: Array<{
      __typename: string;
      id?: string;
      name?: string;
      options?: { id: string; name: string }[];
    }>;
  };
};

type GqlRepoProjectsPage = {
  repository: {
    projectsV2: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlProjectV2[];
    };
  };
};

const REPO_PROJECTS_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      projectsV2(first: 20, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  }
`;

function projectFromGql(p: GqlProjectV2): GhProjectSummary {
  const statusField = p.fields.nodes.find(
    (f) => f.__typename === "ProjectV2SingleSelectField" && f.name === "Status",
  );
  return {
    number: p.number,
    nodeId: p.id,
    title: p.title,
    statusFieldId: statusField?.id ?? null,
    statusOptions: statusField?.options ?? [],
    fieldsJson: JSON.stringify(p.fields.nodes),
  };
}

export async function listRepoProjects(): Promise<GhProjectSummary[]> {
  const out: GhProjectSummary[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: GqlRepoProjectsPage = await octo().graphql<GqlRepoProjectsPage>(REPO_PROJECTS_QUERY, {
      owner: _owner,
      repo: _repo,
      cursor,
    });
    const page = data.repository?.projectsV2;
    if (!page) break;
    for (const p of page.nodes) out.push(projectFromGql(p));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

type GqlProjectItemContent =
  | {
      __typename: "Issue" | "PullRequest";
      number: number;
      title: string;
      repository: { nameWithOwner: string };
      assignees: { nodes: { login: string }[] };
    }
  | {
      __typename: "DraftIssue";
      title: string;
      assignees: { nodes: { login: string }[] };
    };

type GqlProjectItemNode = {
  id: string;
  content: GqlProjectItemContent | null;
  fieldValues: {
    nodes: Array<{
      __typename: string;
      optionId?: string;
      name?: string;
      field?: { __typename: string; id: string; name: string };
    }>;
  };
};

type GqlProjectItemsPage = {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlProjectItemNode[];
    };
  } | null;
};

const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query ($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content {
              __typename
              ... on Issue {
                number
                title
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
              }
              ... on PullRequest {
                number
                title
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
              }
              ... on DraftIssue {
                title
                assignees(first: 10) { nodes { login } }
              }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                  name
                  field {
                    __typename
                    ... on ProjectV2FieldCommon { id name }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function itemFromGql(n: GqlProjectItemNode, statusFieldId: string | null): GhProjectItemRaw {
  const c = n.content;
  let contentType: GhProjectItemRaw["contentType"] = "DraftIssue";
  let contentNumber: number | null = null;
  let contentRepo: string | null = null;
  let contentTitle = "";
  let assignees: string[] = [];
  if (c) {
    if (c.__typename === "Issue" || c.__typename === "PullRequest") {
      contentType = c.__typename;
      contentNumber = c.number;
      contentRepo = c.repository.nameWithOwner;
      contentTitle = c.title;
      assignees = c.assignees.nodes.map((a) => a.login);
    } else if (c.__typename === "DraftIssue") {
      contentType = "DraftIssue";
      contentTitle = c.title;
      assignees = c.assignees.nodes.map((a) => a.login);
    }
  }

  let statusOptionId: string | null = null;
  let statusLabel: string | null = null;
  for (const fv of n.fieldValues.nodes) {
    if (
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      fv.field &&
      statusFieldId &&
      fv.field.id === statusFieldId
    ) {
      statusOptionId = fv.optionId ?? null;
      statusLabel = fv.name ?? null;
    }
  }

  return {
    itemId: n.id,
    contentType,
    contentNumber,
    contentRepo,
    contentTitle,
    statusOptionId,
    statusLabel,
    assignees,
    raw: n,
  };
}

export async function fetchProjectItems(
  projectNodeId: string,
  statusFieldId: string | null,
): Promise<GhProjectItemRaw[]> {
  const out: GhProjectItemRaw[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: GqlProjectItemsPage = await octo().graphql<GqlProjectItemsPage>(PROJECT_ITEMS_QUERY, {
      projectId: projectNodeId,
      cursor,
    });
    const page = data.node?.items;
    if (!page) break;
    for (const n of page.nodes) out.push(itemFromGql(n, statusFieldId));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

const UPDATE_STATUS_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item { id }
    }
  }
`;

const CLEAR_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
    ) {
      projectV2Item { id }
    }
  }
`;

export async function updateProjectItemStatus(
  octo: Octokit,
  projectNodeId: string,
  itemId: string,
  statusFieldId: string,
  optionId: string | null,
): Promise<void> {
  if (optionId === null) {
    await octo.graphql(CLEAR_FIELD_MUTATION, {
      projectId: projectNodeId,
      itemId,
      fieldId: statusFieldId,
    });
    return;
  }
  await octo.graphql(UPDATE_STATUS_MUTATION, {
    projectId: projectNodeId,
    itemId,
    fieldId: statusFieldId,
    optionId,
  });
}

const ADD_ITEM_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

// Add an issue (by GraphQL node id) to a Projects v2 board. Idempotent on GitHub's
// side — re-adding an existing item returns the existing item id.
export async function addProjectV2ItemById(
  octo: Octokit,
  projectNodeId: string,
  contentNodeId: string,
): Promise<string> {
  const res = await octo.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    ADD_ITEM_MUTATION,
    { projectId: projectNodeId, contentId: contentNodeId },
  );
  return res.addProjectV2ItemById.item.id;
}

// ─────────────── ISSUE TIMELINE (flow-state mirror) ───────────────
// Cost trade-off: GraphQL timelineItems(since:) returns items modified since the cursor;
// we cap at 100 events per issue per call. First boot reaches back 30 days, subsequent
// reconciles use lastSyncAt - 7d as the floor. Only called for issues whose updated_at
// moved since the last sync (caller filters).

type GqlTimelineNode = {
  __typename: string;
  id?: string;          // legacy node id (string) — we hash to a stable numeric for SQLite PK
  databaseId?: number;  // when GH exposes it
  createdAt: string;
  actor?: { login: string } | null;
  label?: { name: string };
  assignee?: { login: string } | null;
  source?: TimelineRef;
  subject?: TimelineRef;
};

// A cross-/referenced timeline target. For PullRequests we capture enough to mirror a
// cross-repo PR (Option A): repo, lifecycle, merge state, author, timestamps, url.
type TimelineRef = {
  __typename: string;
  number?: number;
  title?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  mergedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  url?: string;
  author?: { login: string } | null;
  repository?: { nameWithOwner: string };
};

type GqlIssueTimelinePage = {
  repository: {
    issue: {
      timelineItems: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GqlTimelineNode[];
      };
    } | null;
  };
};

const TIMELINE_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $num: Int!, $since: DateTime, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $num) {
        timelineItems(
          first: 100
          since: $since
          after: $cursor
          itemTypes: [
            LABELED_EVENT
            UNLABELED_EVENT
            ASSIGNED_EVENT
            UNASSIGNED_EVENT
            MENTIONED_EVENT
            CROSS_REFERENCED_EVENT
            REFERENCED_EVENT
          ]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
            ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } }
            ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } } }
            ... on MentionedEvent { createdAt actor { login } }
            ... on CrossReferencedEvent {
              createdAt
              actor { login }
              source { __typename ... on Issue { number title } ... on PullRequest { ...prRef } }
            }
            ... on ReferencedEvent {
              createdAt
              actor { login }
              subject { __typename ... on Issue { number title } ... on PullRequest { ...prRef } }
            }
          }
        }
      }
    }
  }
  fragment prRef on PullRequest {
    number
    title
    state
    isDraft
    mergedAt
    createdAt
    updatedAt
    closedAt
    url
    author { login }
    repository { nameWithOwner }
  }
`;

// Map __typename to our event_type. Anything not in this map is dropped.
const EVENT_TYPE_MAP: Record<string, string> = {
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  AssignedEvent: "assigned",
  UnassignedEvent: "unassigned",
  MentionedEvent: "mentioned",
  CrossReferencedEvent: "cross-referenced",
  ReferencedEvent: "referenced",
  ReadyForReviewEvent: "ready_for_review",
};

// Stable 53-bit hash for nodes without databaseId. SQLite INTEGER PRIMARY KEY accepts
// up to 2^63 but we keep within JS-safe range for round-trip integrity.
function hashId(issueNumber: number, type: string, createdAt: string, extra: string): number {
  const s = `${issueNumber}|${type}|${createdAt}|${extra}`;
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  // Mask to 53 bits and ensure positive.
  return Number(h & 0x1fffffffffffffn);
}

// ─────────────── INSIGHT PR PUBLISHING ───────────────

export interface PublishInsightOpts {
  filePath: string; // "insights/<slug>.md"
  content: string; // full markdown with frontmatter
  title: string;
  branchName: string;
  prBody?: string;
}

export interface PublishInsightResult {
  prUrl: string;
  prNumber: number;
}

function insightsRepo(): { owner: string; repo: string } {
  const override = (process.env.INSIGHTS_GITHUB_REPO ?? "").trim();
  if (override) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(override);
    if (!m || !m[1] || !m[2]) {
      throw new Error("INSIGHTS_GITHUB_REPO must be 'owner/repo'");
    }
    return { owner: m[1], repo: m[2] };
  }
  return { owner: _owner, repo: _repo };
}

// ─────────────── INSIGHT READING (GitHub-sourced) ───────────────
// Insights are mirrored from the canonical repo via the API — same model as issues,
// no local checkout. `listInsightFiles` returns the `insights/` dir listing (one call,
// each entry carries its git blob sha for change detection); `fetchInsightBlob` pulls
// content only for files whose sha changed since the last reconcile.

export interface GhInsightEntry {
  path: string; // "insights/<slug>.md"
  sha: string; // git blob sha — stable per content, used to skip unchanged files
}

export async function listInsightFiles(): Promise<GhInsightEntry[]> {
  const o = octo();
  const { owner, repo } = insightsRepo();
  let data: unknown;
  try {
    const res = await o.rest.repos.getContent({ owner, repo, path: "insights" });
    data = res.data;
  } catch (err) {
    // 404 = no insights/ dir in the repo. Treat as empty, not an error.
    if (err && typeof err === "object" && (err as { status?: number }).status === 404) return [];
    throw err;
  }
  if (!Array.isArray(data)) return []; // a file, not a dir — unexpected
  const out: GhInsightEntry[] = [];
  for (const e of data as Array<{ type: string; name: string; path: string; sha: string }>) {
    if (e.type !== "file") continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name.startsWith("_")) continue;
    if (e.name === "README.md") continue;
    out.push({ path: e.path, sha: e.sha });
  }
  return out;
}

// Read one file from the *issues* repo (not the insights repo) for in-app viewing.
// Used to surface files referenced in an issue body. Read-only — never writes.
// Throws { status: 404 } when the path is missing / is a directory, and
// { status: 422 } when the file is too large (GitHub omits content >1MB) or binary.
export interface RepoFileResult {
  path: string;
  ref: string | null; // ref requested by caller; null = repo default branch
  content: string;
  sha: string;
  size: number;
  htmlUrl: string | null;
}

export async function fetchRepoFile(path: string, ref?: string): Promise<RepoFileResult> {
  const o = octo();
  const res = await o.rest.repos.getContent({
    owner: _owner,
    repo: _repo,
    path,
    ...(ref ? { ref } : {}),
  });
  const data = res.data;
  if (Array.isArray(data) || data.type !== "file") {
    throw Object.assign(new Error("not a file"), { status: 404 });
  }
  // GitHub omits `content` for files larger than 1MB.
  if (!("content" in data) || !data.content) {
    throw Object.assign(new Error("file too large to display"), { status: 422 });
  }
  const text = Buffer.from(data.content, "base64").toString("utf8");
  if (text.includes(String.fromCharCode(0))) {
    throw Object.assign(new Error("binary file"), { status: 422 });
  }
  return {
    path: data.path,
    ref: ref ?? null,
    content: text,
    sha: data.sha,
    size: data.size,
    htmlUrl: data.html_url ?? null,
  };
}

export async function fetchInsightBlob(sha: string): Promise<string> {
  const o = octo();
  const { owner, repo } = insightsRepo();
  const { data } = await o.rest.git.getBlob({ owner, repo, file_sha: sha });
  return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8");
}

export async function publishInsightPr(o: Octokit, opts: PublishInsightOpts): Promise<PublishInsightResult> {
  const { owner, repo } = insightsRepo();

  const repoInfo = await o.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch;

  const ref = await o.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const baseSha = ref.data.object.sha;

  await o.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${opts.branchName}`,
    sha: baseSha,
  });

  await o.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: opts.filePath,
    message: `Insight: ${opts.title}`,
    content: Buffer.from(opts.content, "utf8").toString("base64"),
    branch: opts.branchName,
  });

  const pr = await o.rest.pulls.create({
    owner,
    repo,
    title: `Insight: ${opts.title}`,
    head: opts.branchName,
    base: defaultBranch,
    body: opts.prBody ?? `Captured via gh-roadmap insights inbox.`,
  });

  return { prUrl: pr.data.html_url, prNumber: pr.data.number };
}

export interface DeleteInsightOpts {
  filePath: string; // "insights/<slug>.md"
  title: string;
  branchName: string;
  prBody?: string;
}

export interface MergeInsightsOpts {
  survivorPath: string; // "insights/<survivor>.md" — updated in place
  survivorContent: string; // full rewritten markdown with frontmatter
  victimPaths: string[]; // other insight files to delete
  title: string;
  branchName: string;
  prBody?: string;
}

// Resolve a file's current blob sha on a branch (required for delete/update).
async function fileSha(path: string, branch: string): Promise<string> {
  const o = octo();
  const { owner, repo } = insightsRepo();
  const { data } = await o.rest.repos.getContent({ owner, repo, path, ref: branch });
  if (Array.isArray(data) || !("sha" in data)) {
    throw Object.assign(new Error(`expected a file at ${path}`), { status: 404 });
  }
  return data.sha;
}

// Branch off default, create the PR. Shared by delete/merge after their file ops run.
async function openBranch(o: Octokit, branchName: string): Promise<string> {
  const { owner, repo } = insightsRepo();
  const repoInfo = await o.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch;
  const ref = await o.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
  await o.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: ref.data.object.sha });
  return defaultBranch;
}

// Open a PR that removes a single insight file.
export async function deleteInsightPr(o: Octokit, opts: DeleteInsightOpts): Promise<PublishInsightResult> {
  const { owner, repo } = insightsRepo();
  const defaultBranch = await openBranch(o, opts.branchName);

  await o.rest.repos.deleteFile({
    owner,
    repo,
    path: opts.filePath,
    message: `Retire insight: ${opts.title}`,
    sha: await fileSha(opts.filePath, opts.branchName),
    branch: opts.branchName,
  });

  const pr = await o.rest.pulls.create({
    owner,
    repo,
    title: `Retire insight: ${opts.title}`,
    head: opts.branchName,
    base: defaultBranch,
    body: opts.prBody ?? `Retiring insight via gh-roadmap.`,
  });
  return { prUrl: pr.data.html_url, prNumber: pr.data.number };
}

// Open a PR that rewrites the survivor file and deletes victim files in one branch.
export async function mergeInsightsPr(o: Octokit, opts: MergeInsightsOpts): Promise<PublishInsightResult> {
  const { owner, repo } = insightsRepo();
  const defaultBranch = await openBranch(o, opts.branchName);

  await o.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: opts.survivorPath,
    message: `Merge insights into: ${opts.title}`,
    content: Buffer.from(opts.survivorContent, "utf8").toString("base64"),
    sha: await fileSha(opts.survivorPath, opts.branchName),
    branch: opts.branchName,
  });

  for (const victim of opts.victimPaths) {
    await o.rest.repos.deleteFile({
      owner,
      repo,
      path: victim,
      message: `Merge: remove ${victim} (folded into ${opts.survivorPath})`,
      sha: await fileSha(victim, opts.branchName),
      branch: opts.branchName,
    });
  }

  const pr = await o.rest.pulls.create({
    owner,
    repo,
    title: `Merge insights into: ${opts.title}`,
    head: opts.branchName,
    base: defaultBranch,
    body: opts.prBody ?? `Merging insights via gh-roadmap.`,
  });
  return { prUrl: pr.data.html_url, prNumber: pr.data.number };
}

// State of an insight PR on the insights repo. Used to reconcile published drafts
// whose PR was merged (or closed) directly on GitHub, outside the in-app merge button.
// Returns null when the PR is gone (404).
export async function fetchInsightPrState(
  prNumber: number,
): Promise<{ state: "open" | "closed"; merged: boolean } | null> {
  const o = octo();
  const { owner, repo } = insightsRepo();
  try {
    const { data } = await o.rest.pulls.get({ owner, repo, pull_number: prNumber });
    return { state: data.state === "closed" ? "closed" : "open", merged: !!data.merged };
  } catch (err) {
    if (err && typeof err === "object" && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}

// Squash-merge an insight PR opened by publishInsightPr. Throws on GitHub error
// (e.g. 405 not mergeable, 409 head changed). Caller maps the error for the PM.
// After merging, deletes the head branch (GitHub doesn't auto-delete on squash unless the
// repo opts in). Branch cleanup is best-effort — a failure there never fails the merge.
export async function mergeInsightPr(o: Octokit, prNumber: number): Promise<void> {
  const { owner, repo } = insightsRepo();
  const { data: pr } = await o.rest.pulls.get({ owner, repo, pull_number: prNumber });
  await o.rest.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "squash",
  });
  const headRef = pr.head?.ref;
  if (headRef) {
    try {
      await o.rest.git.deleteRef({ owner, repo, ref: `heads/${headRef}` });
    } catch {
      /* branch already gone / protected — cosmetic, ignore */
    }
  }
}

// Close (abandon) an insight PR without merging, then delete its head branch.
// Branch name isn't persisted at publish time, so we read it off the PR. If the
// PR is already closed/gone we still try to clean the branch. Branch-delete
// failures are non-fatal (branch may already be gone or protected).
export async function closeInsightPr(o: Octokit, prNumber: number): Promise<void> {
  const { owner, repo } = insightsRepo();
  const { data: pr } = await o.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== "closed") {
    await o.rest.pulls.update({ owner, repo, pull_number: prNumber, state: "closed" });
  }
  const headRef = pr.head?.ref;
  if (headRef) {
    try {
      await o.rest.git.deleteRef({ owner, repo, ref: `heads/${headRef}` });
    } catch (err) {
      if (!(err && typeof err === "object" && (err as { status?: number }).status === 422)) throw err;
    }
  }
}

// Extract a cross-repo PR from a timeline ref, or null when it's same-repo / not a PR.
function externalPullFromRef(ref: TimelineRef | undefined, issueNumber: number): GhExternalPull | null {
  if (!ref || ref.__typename !== "PullRequest" || typeof ref.number !== "number") return null;
  const repo = ref.repository?.nameWithOwner ?? "";
  if (!repo || repo === `${_owner}/${_repo}`) return null; // same-repo PRs come from fetchAllPulls
  return {
    repo,
    number: ref.number,
    title: ref.title ?? `#${ref.number}`,
    state: ref.state === "OPEN" ? "open" : "closed",
    merged: ref.state === "MERGED",
    merged_at: ref.mergedAt ?? null,
    is_draft: !!ref.isDraft,
    author: ref.author?.login ?? null,
    created_at: ref.createdAt ?? null,
    updated_at: ref.updatedAt ?? ref.createdAt ?? new Date(0).toISOString(),
    closed_at: ref.closedAt ?? null,
    url: ref.url ?? `https://github.com/${repo}/pull/${ref.number}`,
    linked_issue: issueNumber,
  };
}

export async function fetchIssueTimelineSince(
  issueNumber: number,
  sinceIso: string,
  cap = 100,
): Promise<{ events: GhTimelineEvent[]; externalPulls: GhExternalPull[] }> {
  const out: GhTimelineEvent[] = [];
  const externalPulls: GhExternalPull[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: GqlIssueTimelinePage = await octo().graphql<GqlIssueTimelinePage>(TIMELINE_QUERY, {
      owner: _owner,
      repo: _repo,
      num: issueNumber,
      since: sinceIso,
      cursor,
    });
    const page = data.repository.issue?.timelineItems;
    if (!page) break;
    for (const n of page.nodes) {
      const type = EVENT_TYPE_MAP[n.__typename];
      if (!type) continue;
      const actor = n.actor?.login ?? null;
      let extra = "";
      let payload: Record<string, unknown> | null = null;
      if (type === "labeled" || type === "unlabeled") {
        extra = n.label?.name ?? "";
        if (n.label?.name) payload = { label: n.label.name };
      } else if (type === "assigned" || type === "unassigned") {
        extra = n.assignee?.login ?? "";
        if (n.assignee?.login) payload = { assignee: n.assignee.login };
      } else if (type === "cross-referenced" && n.source) {
        extra = `${n.source.__typename}#${n.source.number ?? ""}`;
        payload = { source: n.source };
        const ext = externalPullFromRef(n.source, issueNumber);
        if (ext) externalPulls.push(ext);
      } else if (type === "referenced" && n.subject) {
        extra = `${n.subject.__typename}#${n.subject.number ?? ""}`;
        payload = { subject: n.subject };
        const ext = externalPullFromRef(n.subject, issueNumber);
        if (ext) externalPulls.push(ext);
      }
      const id = typeof n.databaseId === "number" ? n.databaseId : hashId(issueNumber, type, n.createdAt, extra);
      out.push({
        id,
        issue_number: issueNumber,
        event_type: type,
        actor,
        created_at: n.createdAt,
        payload: payload ? JSON.stringify(payload) : null,
      });
      if (out.length >= cap) return { events: out, externalPulls };
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { events: out, externalPulls };
}
