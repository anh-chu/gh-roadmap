---
title: gh-roadmap — Project Context
status: living
owner: anh (anh.chu@katalon.com)
purpose: durable hand-off so any coding agent (or human) can understand this app without re-deriving its design decisions
updated: 2026-06-05
---

# gh-roadmap — Project Context

Internal PM tool. Mirrors a product repo's GitHub issues with two-way sync, adds a planning
layer on top, and surfaces AI-assisted reads plus a customer-insight / account pipeline. Runs
locally single-user with no auth by default; optional Google login + roles + per-user GitHub write
identity turn it into a small-team tool (see §2 "Auth layers"). Not deployable to Vercel's free
tier (it's a long-lived stateful Node process with a SQLite file, not a serverless function).

This file is the orientation doc. Read it before changing anything. Run instructions are in
[`README.md`](README.md); the source tree is the other source of truth.

---

## 0. How to work in this repo (for the agent reading this)

- **This is its own repository** (`github.com/anh-chu/gh-roadmap`). It was extracted from the
  owner's personal wiki monorepo; history starts fresh here. The repo root _is_ the app root —
  `api/`, `web/`, and `shared/` sit directly at the root (there is **no** `server/` wrapper
  directory inside the repo, despite older docs/paths that may say `server/...`).
- **Verify before and after a change:** `pnpm install` then `pnpm typecheck` (runs both
  `api` and `web` under `tsc --strict`). The build must be green before you start and when you
  finish. There is no test suite; typecheck + a manual boot (`pnpm dev`) are the gates.
- **The design has been heavily curated.** Over-engineering, over-prompting the model, and scope
  creep have all caused regressions here. Bias toward the smallest, most explicit change that
  satisfies the request. When a UX or product call is ambiguous, ask the owner rather than guessing —
  §5 and §6 record decisions that should not be re-litigated.
- **Match the surrounding style.** Single global stylesheet (`web/src/styles.css`, sectioned by
  feature), module-level cache pattern in hooks, typed fetch wrappers in `web/src/lib/api.ts`,
  PRAGMA-guarded `ALTER` migrations in `api/src/db.ts`. All cross-tier types live in
  `shared/types.ts` — add there, don't duplicate per tier.
- **Keep the API contract current.** When adding an endpoint, removing an endpoint, or changing any
  request/response shape, update the OpenAPI definition in `api/src/openapi.ts` in the same change.
  Agents use `/api/openapi.json` and `/api/openapi.yaml` as their contract.
- **Never invent data.** Mock data is banned app-wide; render `—` or an honest empty state.

---

## 1. Who uses this

| User                             | Need                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Anh (primary, PM of the MHT pod) | Daily standup prep + ad-hoc stakeholder Q&A + spotting risk before it becomes risk |
| Eng leads + devs in the pod      | Read-only or light interaction with their queue                                    |
| Future: other PMs                | Multi-PM-ready from day one — no person-specific assumptions hardcoded             |

Pod scope today is locked to the `pod:mht` label via the master-filter feature, switchable per
`workspace_config`. Nothing about a single PM's identity is baked into code paths.

## 2. Locked architectural decisions

### Stack

```
backend     Fastify 5 + better-sqlite3 + Octokit + TypeScript (strict)
frontend    Vite + React + TypeScript (strict), mounted as Fastify middleware — one port
storage     SQLite file (data/roadmap.db) — no Postgres, no Docker
deploy      runs anywhere Node 20+ runs; not serverless/Vercel-shaped
auth        optional, layered — off by default (single-user localhost). See "Auth layers" below.
```

#### Auth layers (all optional, independently toggled by env)

1. **Service identity** (`github.ts`) — the shared client for all reads, sync, and (by default) all
   writes. Either a PAT (`GITHUB_TOKEN`) or a GitHub App installation (`GITHUB_APP_ID` +
   `GITHUB_APP_INSTALLATION_ID` + `GITHUB_APP_PRIVATE_KEY`). App creds take precedence and mint a
   self-renewing ~1h installation token in-app; writes then appear as `app-name[bot]`.
2. **Login gate** (`auth.ts`) — Google OAuth. Off when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
   are unset (every request is a local admin). On → every `/api/*` (except `/api/auth/*`) needs a
   session cookie; roles viewer/editor/admin; `ALLOWED_EMAIL_DOMAIN` whitelist, `ADMIN_EMAILS`
   immutable bootstrap-admin list.
3. **Per-user GitHub write identity** (`githubOauth.ts`, `githubWriteIdentity.ts`,
   `routes/githubAuth.ts`) — GitHub OAuth. On when `GITHUB_OAUTH_CLIENT_ID`/`SECRET` set (requires
   the login gate + `TOKEN_ENC_KEY`; partial config refuses boot). User-initiated writes then act
   as the caller's own linked GitHub account; users connect once via "Connect GitHub" (avatar menu
   or the `409 github_not_linked` prompt). Tokens stored AES-256-GCM-encrypted; revoked →
   `409 github_reauth_required`. Off → writes fall back to the service identity.

Full run/config matrix is in [`README.md`](README.md); policy doc: `docs/github-oauth-write-identity-plan.md`.

A single `pnpm dev` boots everything. The Vite dev middleware skips `/api` and `/webhook` so the
Fastify routes win. The port auto-bumps on `EADDRINUSE` and writes `.runtime-port` so sibling tools
can discover the live port.

### GitHub integration

- One issues repo, set via `GITHUB_OWNER` / `GITHUB_REPO` (the owner runs it against
  `katalon-studio/product`). The service identity is a GitHub App (preferred) or a PAT — needs
  `repo` + `project` scopes (`project` powers the Kanban tab). See "Auth layers" above.
- Writes go through the service identity by default; when per-user GitHub OAuth is enabled they go
  through the caller's own linked account instead. Reads + background sync always use the service
  identity.
- Issues are pulled via a bulk GraphQL query (cheaper than a REST loop) and upserted into SQLite.
- Writes go through Octokit only on explicit user action. **Never write app-only fields back to GitHub.**
- The webhook handler is wired and HMAC-verified but not relied on — boot-time and nightly
  reconcile catch any missed events.

### Roadmap data model

| Source of truth                    | Fields                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| GitHub (mirrored both ways)        | title, body, state, labels, assignee, milestone, comments           |
| App-only (never written to GitHub) | `plannedMonth`, `plannedWeek`, `isTodo`, `roadmapNotes`, `position` |

Cross-area drag (when bucketing = label) writes a `<prefix>:*` label to GitHub — a real GitHub
mutation. Same-area moves stay app-only. **These app-only fields live only in SQLite**, so the
`data/roadmap.db` file holds planning work that cannot be re-derived from GitHub. Don't discard it.

## 3. The dashboard's surfaces

| Tab          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                 | State   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Roadmap**  | Drag issues across time × bucket. TODO + Backlog meta columns. Configurable bucketing (none / label / assignee / milestone), configurable time axis (week / month / quarter), pin-meta-cols toggle                                                                                                                                                                                                                      | shipped |
| **List**     | Dense sortable table                                                                                                                                                                                                                                                                                                                                                                                                    | shipped |
| **Kanban**   | Mirrors one GitHub Project v2 board. Env-pinned via `GITHUB_PROJECT_NUMBER`. No in-app project switcher                                                                                                                                                                                                                                                                                                                 | shipped |
| **Insights** | Browse `insights/*.md` from the product repo. Inbox of captured drafts at top. AI-extracted fields + body; publishing opens a PR                                                                                                                                                                                                                                                                                        | shipped |
| **Accounts** | Customer axis. Account index (signal-derived **and** CRM-ingested) → drawer with timeline, cares-about issues (2-hop), an AI "Acme story" read, and an editable **mini-CRM profile** (ARR / renewal / owner / tier / segment / region / industry / website / domain / salesforce_id / notes). Create one account manually, or ingest in bulk via JSON / CSV paste. `source` flag per account: `signal` / `crm` / `both` | shipped |
| **Progress** | "How are things today" — a single-column spine: Verdict line → AI Read → Needs-you-now (at-risk, primary) → Schedule (headline) + Momentum (secondary) → detail/changes. **Not** a velocity dashboard — PM lens, not EM lens                                                                                                                                                                                            | shipped |

## 4. Core conventions worth knowing

### Master filter

Workspace-level include + exclude label lists, applied at the SQL layer on every read. The default
is `include: ["pod:mht"]`. All counts, AI prompts, at-risk lists, and insight linking respect it.
It is intentionally **not** applied to write endpoints.

### Bucketing (row axis on Roadmap)

Configurable: none / label-prefix / assignee / milestone. When `none`, the label column collapses.
Drop semantics differ per mode (see `targetForCol` in `web/src/components/Board.tsx`). Label mode
is the default with prefix `area`.

### Time axis (column axis on Roadmap)

Configurable: week / month / quarter. Count (1–12) and offset (−6..+6) are tunable in the View
popover. Quarters are stored internally as their first month for compatibility.

### Flow engine (`api/src/flow.ts`)

Per-issue state derived from PR + comment + event signals. States: shipping / in-review / in-code /
discussing / stalled / cold / fresh / closed. Hybrid model: deterministic rules pick the state, a
score ranks within it. The flow pill renders everywhere (Board / List / Kanban / Drawer / Insight body).

The PR mirror runs _full depth_ — reviews, check-runs, draft state, head ref, and timeline events
(labeled / assigned / mentioned / cross-referenced). All upserted on webhook + reconcile.

### At-risk + Confidence (`api/src/health.ts`)

- **Backlog items are explicitly excluded from at-risk.** Only `planned_month` / `planned_week` /
  `is_todo=1` items count.
- **Schedule is the headline metric** (`computeScheduleHealth`): on-time %, status,
  committed/overdue/due-now. It's the signal the data actually feeds (week-plans + closed dates +
  effort labels). On-time history is stored per snapshot (`on_time` column) for its own sparkline.
- **Momentum (confidence) is gated and secondary.** It's the mean ship-probability over flow state,
  but the `shipping`/`in-review`/`in-code` states all require a linked PR, and in live data very few
  pod issues have one. So `computeConfidence` counts only issues with **real flow signal** (linked
  PR, event, or comment); the rest are excluded and reported as `noSignal`. The UI shows
  `N judged · M no signal` so a thin sample reads as weakly evidenced. Momentum vocabulary is
  `strong/mixed/weak` — never "on track / at risk" — so it can't collide with schedule status words.
- **At-risk is recalibrated:** a `stalled`/`cold` item with no linked PR and no events can't be
  distinguished from an active-but-unlinked one, so it's filed as `low-signal` (severity 1) instead
  of a critical stall — this keeps genuine stalls visible instead of flooding the UI red. Snapshots
  are daily, backfilled on boot via `backfillHealthSnapshots(30)`.
- At-risk severity is bumped +1 (cap 3) when an issue has linked insights (customer signal); the AI
  Read names affected accounts inline.

### AI integration

- OpenAI-compatible HTTP, configured via `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. Any compatible
  endpoint works (a local OpenCode/Ollama/vLLM server, etc.). When `AI_BASE_URL` or the model is
  unset, AI routes return 503 and the UI hides AI surfaces.
- Per-task model overrides live in the DB (`aiModelSummary` / `aiModelProgress` / `aiModelExtract`);
  a header "AI" popover lets the PM set them. Empty = env fallback.
- Four AI surfaces: **issue summary** (drawer + card-hover tooltip, hash-invalidated cache),
  **Progress AI Read** (24h cache), **insight extraction** (capture → fields + body draft), and
  **account read** (the "Acme story", hash-invalidated cache on the account row).
- **Every AI surface supports regeneration** — this is a must-have pattern; a PM should never be
  stuck with stale or low-quality output.
- AI output rules (prompts in `api/src/prompts/*.md`):
  - Bold only numeric tokens (containing digits) and state words. Never bold issue refs `#NNN` —
    those have their own chip styling. Server-side `cleanMarkdown` strips `**#NNN**` that slips through.
  - Concrete examples in the prompt beat rule lists; models copy shape from examples better than
    they obey abstract rules.
  - Reasoning models need explicit "do not think out loud, do not reflect after the answer"
    instructions, or they leak chain-of-thought into the content field.

### Issue references in AI markdown

Any `#NNN` rendered through `IssueRefMarkdown` becomes an interactive chip: click opens the issue
drawer; hover shows a portal tooltip with title + assignee/state + AI summary. Out-of-scope refs
(excluded by the master filter) render as faded plain text.

### Customer signal (Insights → Issues → Accounts)

Insight files in the product repo's `insights/*.md` carry:

- `accounts:` frontmatter list (optional; legacy files have none)
- `related_issues:` frontmatter list of issue numbers
- body `#NNN` mentions, parsed as a fallback when frontmatter is absent

Linking flows both ways: the issue drawer shows `📎 N insights · 👥 Acme +1`; board cards show a
`📎 N` chip; at-risk severity bumps; the AI Read cites accounts; the insight drawer shows linked
issues as IssueRef chips.

### Two-axis insight model (Accounts)

A raw `insights/*.md` capture is **input**; extraction **routes** it onto two first-class axes —
**Feature** (a GitHub issue, "what to build") and **Customer** (an Account, "what's up with them").
`type` (customer / data / competitive / …) stays a facet, not a third axis. Routing is conservative:
extraction links only accounts/issues **explicitly named** in the raw text — never inferred (a wrong
auto-link pollutes both rollups and the at-risk bump).

- The `accounts` table is keyed by slug. It holds a display name, the AI-read cache columns, and (as
  of the mini-CRM work) structured profile columns. Timeline + cares-about stay **derived** (queries
  over `insight_accounts` / `insight_issues`) — never denormalized.
- Account slugs are produced by `slugifyAccount` (in `api/src/insights.ts`). CRM ingest reuses the
  same function so an ingested account lines up with its signal-derived counterpart.
- The account AI read ("Acme story") mirrors issue-summary: a hash-invalidated cache on the row plus
  a regenerate endpoint, reusing the `summary` task model.
- The `AccountRef` chip is clickable everywhere it renders and opens the Account drawer. Along an
  axis, duplicate signals are **corroboration** (cares-about issues show a `·N` count), not noise to
  suppress.

### Accounts mini-CRM (shipped)

Structured profile fields on the `accounts` table, added by PRAGMA-guarded `ALTER`:
`arr` (REAL), `renewal_date`, `owner`, `tier`, `segment`, `region`, `industry`, `website`, `domain`,
`salesforce_id`, `notes`, plus `profile_updated_at`. That last column doubles as the **provenance
marker**: it's set whenever a profile is written, which is what lets a CRM-only account (zero insight
signals) appear in the index.

- The index query `LEFT JOIN`s the signal tables and keeps a row when
  `signal_count >= 1 OR profile_updated_at IS NOT NULL`. `source` is derived: `both` / `signal` / `crm`.
- One `PROFILE_FIELDS` map in `api/src/routes/accounts.ts` is the single source of truth — it drives
  the SELECT, the upsert SET clause, the row→profile read, and CSV header aliasing. Add a field there.
- Three write paths, all upsert by slug (re-ingesting hydrates, never duplicates):
  `POST /api/accounts` (manual single create), `POST /api/accounts/ingest` (bulk JSON),
  `POST /api/accounts/ingest/csv` (`{csv}` body, header-aliased columns), and
  `PATCH /api/accounts/:slug/profile` (manual hydrate from the drawer).
- Deferred: alias merge ("Acme" vs "Acme Corp"), at-risk structured account chips (still prose in the
  AI Read), account-scoped master filter (the index is unscoped: all accounts with ≥1 signal or a profile).

### Insights ingestion

- **Read:** insights are mirrored from the canonical GitHub repo via the API — same model as issues,
  **no local checkout**. `reconcileInsights` calls `github.listInsightFiles` (lists `insights/` with
  per-file git blob shas) and `fetchInsightBlob` (pulls content only for changed shas). Enabled iff
  GitHub is configured; optional `INSIGHTS_GITHUB_REPO` (owner/repo) points insights at a different
  repo than the issues repo. _(An earlier phase used a local file path + git submodule; it was
  replaced because it never auto-pulled, so merged insights went stale.)_
- **Write:** programmatic + manual capture → AI extracts fields and a body draft → an Inbox of drafts
  → Publish opens a PR on the product repo. Drafts live in `insight_drafts` (lifecycle
  pending/published/discarded). Merged PRs appear on the next sync (boot / nightly / manual `Synced`
  pill) — no manual `git pull`.

## 5. The PM design lens (decided — don't re-litigate)

| Topic                               | Decision                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PM vs EM dashboard                  | **PM lens always.** No velocity, cycle time, or throughput trends. Focus: "do I need to nudge, rearrange, or unblock anything right now?" |
| Velocity / cycle time / burndown    | Out of scope. Killed early.                                                                                                               |
| R/E/N tagging (Reliable/Expand/New) | Removed entirely — a vestigial deck framework with no team adoption.                                                                      |
| Sev 1/2/3 vocabulary                | Mapped to critical/high/medium in AI prompts (internally 1=low, opposite of industry, which confuses models).                             |
| Card hover summary                  | Kept after being killed once. Portal-rendered tooltip: 600ms delay, click-out aware, scroll-tracking, viewport-flipping.                  |
| Mock data                           | Banned everywhere. `—` or honest empty states.                                                                                            |
| Drawer / comment summary length     | "Substance only" — describe what the thing _is_, don't narrate scheduling state.                                                          |
| Bold rules                          | Numeric tokens only.                                                                                                                      |
| AI Read tone                        | Concrete examples + bullets for at-risk, not flat paragraphs.                                                                             |

## 6. Reframes that mattered

- **Personal workspace vs product repo as canonical.** The owner's wiki is strictly a personal
  workspace; the product repo's `insights/` directory is the official, team-shared canonical layer.
  Multi-PM design centers on the product repo, not any individual's notes.
- **No Salesforce / Gainsight access for PMs** — an org gap. This dashboard's job is to make the
  `insights/` pattern work end-to-end as the consolidation layer the org otherwise lacks. (The
  mini-CRM is a local stand-in for that missing system, hydrated manually or by import.)
- **No standard for customer/prospect/competitor entity pages.** Accounts are derived from the
  `accounts:` frontmatter field (and now optionally hydrated with CRM profile data). Rich per-entity
  pages are a deferred phase.

## 7. Workflow you should not break

```
   PM hears something
        ↓
   POST /api/insights/capture   (curl / agent / paste modal — unauthenticated, localhost)
        ↓
   AI extracts fields + body draft → draft lands in the Inbox
        ↓
   PM opens the draft → edits → clicks Publish
        ↓
   Octokit creates a branch + file + PR on the product repo
        ↓
   PR shows in the Inbox as "Awaiting merge" → PM clicks Approve & merge (squash, in-app)
   — or merges manually on GitHub
        ↓
   Next sync (boot / nightly / manual Synced pill) reads insights/ via the GitHub API
        ↓
   reconcileInsights indexes it → it appears in the Insights tab, linked on issues + accounts
```

The capture endpoint is unauthenticated (localhost) and agent-friendly. The `</> API` button in the
Insights Inbox header shows the curl command and a "Copy all for agent" brief.

## 8. Not done yet (candidate next work)

| Deferred                                         | Why                                                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source connectors (Slack / gdoc / Jira)          | The capture API is the foundation; per-source pipes feed it later.                                                                                                                                    |
| In-app insight authoring                         | Currently capture-only; authoring in-app would bypass the AI extraction loop.                                                                                                                         |
| Account alias merge                              | "Acme" vs "Acme Corp" split into two accounts. Ship the split visibly; manual merge later, no auto-guess.                                                                                             |
| At-risk structured account chips                 | The at-risk AI Read names accounts in prose; render them as structured chips instead.                                                                                                                 |
| Account-scoped master filter                     | The accounts index is unscoped (master filter is issue-label based).                                                                                                                                  |
| Theme (pre-issue feature holder)                 | Signals link straight to issues; themes are ad hoc, premature to model.                                                                                                                               |
| AI-suggested issue matches for unlinked insights | Cheap once insight bodies + issue titles are vectorized.                                                                                                                                              |
| One-click create-issue-from-insight              | `POST /api/issues` exists; wiring + UX deferred.                                                                                                                                                      |
| Webhook for `projects_v2_item.*`                 | The Kanban tab is poll-only at 60s freshness; a manual refresh button works.                                                                                                                          |
| GitHub App private-key flow                      | **Shipped.** App creds mint the installation token in-app (`github.ts`).                                                                                                                              |
| OAuth / multi-tenant                             | **Shipped.** Google login gate + roles + per-user GitHub write identity + multi-pod workspaces are live (all optional). Remaining: SSO providers beyond Google, no-refresh-rotation on GitHub tokens. |

## 9. Code map (paths relative to repo root)

```
api/src/
  server.ts          Fastify boot, Vite middleware, route registration, .runtime-port
  db.ts              all SQLite schema + migrations (PRAGMA-guarded ALTER pattern)
  github.ts          Octokit wrapper, GraphQL queries, PR creation, insight blob fetch
  sync.ts            reconcile loop (issues + comments + pulls + reviews + checks + events)
  flow.ts            flow state engine (rules + score)
  health.ts          schedule health + confidence + at-risk
  healthBackfill.ts  daily health-snapshot backfill
  insights.ts        GitHub-API insight sync (listInsightFiles + fetchInsightBlob), slugifyAccount, draft reconcile
  masterFilter.ts    label-based include/exclude SQL helper
  predictive.ts      preventative at-risk detectors
  ai.ts              AI HTTP client + task functions (issue summary, progress, account read, extract)
  auth.ts            Google OAuth login + session gating + role helpers
  githubOauth.ts     per-user GitHub OAuth (layer 3): enable check, boot guards, code exchange
  githubWriteIdentity.ts  resolves the Octokit for a write (caller's linked token vs service identity)
  crypto.ts          AES-256-GCM encrypt/decrypt of stored user GitHub tokens (TOKEN_ENC_KEY)
  prompts/           summarize.md, progress.md, extract-insight.md
  routes/
    issues.ts        list, patch, create, /roadmap PATCH
    comments.ts      comment CRUD
    pulls.ts         PR list
    meta.ts          dashboard meta (counts, rate limit, current user)
    config.ts        workspace_config GET/PATCH
    health.ts        live + history + backfill
    brief.ts         morning brief (snapshot + changes since pod_last_seen_at)
    flow.ts          flow data
    projects.ts      Kanban tab (Projects v2)
    insights.ts      insight sync + drafts (capture, regenerate, publish PR)
    accounts.ts      list / detail / AI-read + mini-CRM (create, PATCH /profile, POST /ingest, POST /ingest/csv)
    webhook.ts       GitHub webhook receiver
    auth.ts          Google login / callback / logout / session (/api/auth/*)
    githubAuth.ts    GitHub link / callback / unlink for per-user write identity (/api/github/*)
    ai.ts            issue-summary + progress endpoints, hash-invalidated cache
web/src/
  App.tsx            top-level wiring, tab routing, use{Issues,Flow,Health,Insights,...} hooks
  components/        Board, List, Kanban, Drawer, Card, Header, Toolbar, Progress, Insights,
                     InsightInbox, InsightDraftEditor, InsightDrawer, Accounts, AccountDrawer,
                     AccountRef, AiBlock, AiSettings, FlowPill, IssueRef, ScopePill, FilterPopover, ...
  hooks/             use{Issues,Meta,Config,Health,Flow,Pulls,Projects,Insights,InsightDrafts,
                     IssueSummary,AiProgress,Brief,Accounts,Account,...}.ts — module-level cache pattern
  lib/api.ts         typed fetch wrappers; jsonOrThrow surfaces server error.detail
  styles.css         single global stylesheet, sectioned by feature
shared/types.ts      ALL cross-tier types (ApiIssue, Issue, FlowResult, RiskItem, Account, AccountProfile, ...)
```

## 10. Starting a new session here

1. Read this file (you're doing it).
2. Read [`README.md`](README.md) for run/config instructions.
3. `git log --oneline -20` to see recent work.
4. `pnpm install && pnpm typecheck` to confirm the build is green before changing anything.
5. When a product or UX call is ambiguous, ask the owner. The design is curated; prefer the
   smallest, most explicit change.
