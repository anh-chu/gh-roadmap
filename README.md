# gh-roadmap

Internal PM tool. Mirrors GitHub issues from a product repo with two-way sync, adds a planning
layer (roadmap / list / kanban), AI-assisted reads, a customer-insights pipeline, and a
lightweight accounts mini-CRM. Fastify + better-sqlite3 + Octokit backend serving a Vite + React
frontend from the same process. Runs locally; optional Google sign-in for small-team use.

Architecture & locked design decisions live in [`CLAUDE.md`](CLAUDE.md) — read it before changing anything.

## Features

Six tabs:

- **Roadmap** — drag issues across a time × bucket grid, with TODO + Backlog meta columns.
  Configurable bucketing (none / label / assignee / milestone) and time axis (week / month / quarter).
- **List** — dense sortable table.
- **Kanban** — mirrors one GitHub Projects v2 board (env-pinned).
- **Insights** — browse the product repo's `insights/*.md`, an inbox of captured drafts, AI-extracted
  fields, and publish-to-PR.
- **Accounts** — customer axis: account index (signal-derived + CRM-ingested) → drawer with timeline,
  cares-about issues, an AI "Acme story" read, and an editable mini-CRM profile (ARR / renewal /
  owner / tier / segment / …). Manual create or bulk JSON/CSV ingest.
- **Progress** — a PM "how are things today" spine: verdict → AI read → needs-you-now (at-risk) →
  schedule + momentum, plus an "On your plate" PM-action report.

Cross-cutting:

- **Two-way GitHub sync** — title / body / state / labels / assignee / milestone / comments mirror
  both ways; app-only planning fields (`plannedMonth`, `roadmapNotes`, `position`, …) stay in SQLite.
- **Flow engine** — per-issue state (shipping / in-review / in-code / discussing / stalled / cold /
  fresh / closed) derived from PR + comment + event signals; the flow pill renders everywhere.
- **At-risk + schedule health** — schedule on-time % as the headline, gated momentum as secondary,
  recalibrated at-risk with daily snapshots.
- **AI surfaces** — issue summary, Progress read, insight extraction, account read — all regenerable,
  via any OpenAI-compatible endpoint, with per-task model overrides set in the UI.
- **Customer-signal linking** — insights ↔ issues ↔ accounts, two-way, bumping at-risk severity.
- **Capture API** — unauthenticated localhost endpoint (`POST /api/insights/capture`) for agents/curl
  to drop raw signal into the inbox; the Insights header shows a copy-for-agent brief.
- **Repo file viewer** — read-only view of repo files referenced in issues.
- **Drawer affordances** — expand-to-modal toggle + "copy for agent" on the issue drawer.
- **Google OAuth login** — optional, with domain whitelist + admin gating (see below).
- **Workspace export / import** — full backup + restore of the SQLite-held planning layer.

## Run

```bash
cp .env.example .env        # fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (rest optional)
pnpm install
pnpm dev                    # tsx watch — boots API + web on one port
# or
pnpm build && pnpm start
```

Open [http://localhost:3000](http://localhost:3000) — the web app is served at `/`, the API under
`/api/*`. The port auto-bumps on `EADDRINUSE`; the live port is written to `.runtime-port` so
sibling tools can discover it.

```bash
pnpm typecheck              # tsc --strict over both api and web — the build gate (no test suite)
```

## Configuration

All config is env vars (see `.env.example` for the annotated list). Highlights:

| Var | Purpose |
|---|---|
| `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` | Issues repo + auth (PAT or GitHub App installation token). Required. |
| `GITHUB_PROJECT_NUMBER` | Pin the Kanban tab to one Projects v2 board. Optional. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the inbound webhook. Optional. |
| `INSIGHTS_GITHUB_REPO` | Point insights sync at a different repo than the issues repo (`owner/repo`). Optional. |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | OpenAI-compatible endpoint for AI surfaces. Unset → AI routes 503 and the UI hides them. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Set both to require Google sign-in. Leave blank for single-user localhost mode. |
| `ALLOWED_EMAIL_DOMAIN` / `ADMIN_EMAILS` / `SESSION_SECRET` | Domain whitelist, admin gating, cookie signing. Optional. |
| `DB_PATH` | SQLite file location. Defaults to `./data/roadmap.db`. |

### Auth modes

- **Single-user (default).** Leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` blank — no login,
  every request is a local admin. The original localhost pattern.
- **Team (Google OAuth).** Set both client vars to gate the whole app behind "Sign in with Google".
  Register `<app-origin>/api/auth/callback` as the redirect URI. `ALLOWED_EMAIL_DOMAIN` restricts
  sign-in to one domain. `ADMIN_EMAILS` (comma-separated) is the **immutable bootstrap-admin
  list** — always admins, never demotable in-app (blank = every signed-in user is an admin).

### Roles (team mode)

Three roles: **viewer** (read-only — every non-GET request 403s, except logout and insight
capture), **editor** (all app writes), **admin** (editor + user roles + AI settings +
export/import). Newly signed-in users default to **viewer**; an admin promotes them via the
header **Users** panel (`GET /api/users`, `PATCH /api/users/:email/role`). With auth off the
role system is dormant — the local user is admin. Viewer write affordances are hidden in the
UI; the server enforces regardless.

### GitHub auth: App vs PAT

- **PAT** — fastest. Fine-grained personal access token with `repo` (read/write) + `project` scope
  (`project` powers the Kanban tab). Single-user, 5,000 req/hr.
- **GitHub App** — recommended for a team. Installation tokens get 15,000 req/hr and aren't tied to
  a person. Set `GITHUB_TOKEN` to the installation token.

### Webhook setup (optional)

Boot-time + nightly reconcile catch any missed events, so the webhook is not required.

Production: repo settings → **Webhooks** → add `https://<host>/webhook/github`, content type
`application/json`, secret matches `GITHUB_WEBHOOK_SECRET`, subscribe to **Issues** and
**Issue comments**.

Local dev: forward events via [smee.io](https://smee.io):

```bash
npx smee -u https://smee.io/<your-channel> -t http://localhost:3000/webhook/github
```

## API

The OpenAPI definition is the source of truth — it's kept current with every endpoint change:

- JSON: `http://localhost:<port>/api/openapi.json`
- YAML: `http://localhost:<port>/api/openapi.yaml`

Route groups (`api/src/routes/`):

| Area | Routes |
|---|---|
| Issues | list / patch (two-way) / create, `/roadmap` PATCH (app-only planning fields) |
| Comments | list / create / patch / delete (two-way) |
| Meta & config | counts, rate limit, current user; `workspace_config` GET/PATCH |
| Roadmap surfaces | flow state, schedule health (live + history + backfill), Projects v2 (Kanban), PRs |
| Progress | morning brief (snapshot + changes since last-seen) |
| AI | issue summary, progress read, account read, insight extraction (all regenerable) |
| Insights | GitHub-API sync, capture, draft lifecycle, publish-PR |
| Accounts | list / detail / AI read + mini-CRM (create, PATCH profile, JSON + CSV ingest) |
| PM actions | quick-action endpoints surfaced in the UI |
| Repo files | read-only viewer for repo files referenced in issues |
| Data | full-workspace export / import (backup + restore) |
| Auth | Google OAuth login / callback / logout / session |
| Webhook | HMAC-verified GitHub receiver |

## Rate-limit defenses

- GraphQL bulk fetch (50 issues + 50 comments per call) instead of a REST loop
- Webhook-driven inbound; reconcile only on boot + nightly
- Rate-limit headers captured on every response, exposed at `/api/meta`; logger warns under 10%
- Per-issue write debounce helper in `sync.ts`

## Out of scope (next phases)

See [`CLAUDE.md`](CLAUDE.md) §8 for the full candidate-work list. Notable open items:

- GitHub OAuth write-identity (so team writes are attributed per-user, not to one shared token)
- GH App private-key flow (minting installation tokens in-app)
- Conditional ETag caching layer
- Source connectors (Slack / gdoc / Jira) feeding the capture API
- Tests
