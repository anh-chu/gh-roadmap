# gh-roadmap

Internal PM tool. Mirrors GitHub issues from a product repo with two-way sync, adds a planning
layer (roadmap / list / kanban), AI-assisted reads, a customer-insights pipeline, and a
lightweight accounts mini-CRM. Fastify + better-sqlite3 + Octokit backend serving a Vite + React
frontend from the same process. Runs locally, single user, no auth.

## Run

```bash
cp .env.example .env
# fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_WEBHOOK_SECRET
pnpm install
pnpm dev          # tsx watch
# or
pnpm build && pnpm start

```

Open [http://localhost:3000](http://localhost:3000) — the prototype board is served at `/`, API under `/api/*`.

Agent/API definition links:

- OpenAPI JSON: `http://localhost:<port>/api/openapi.json`
- OpenAPI YAML: `http://localhost:<port>/api/openapi.yaml`

Use the live port from `.runtime-port` when dev auto-bumps past 3000.

## Auth: GH App vs PAT

- **PAT** — fastest path. Create a fine-grained personal access token with `repo` (read/write) scope. Single-user, 5,000 req/hr.
- **GitHub App** — _recommended for the team_. Install the app on the repo; installation tokens get **15,000 req/hr** and are not tied to a person. Set `GITHUB_TOKEN` to the installation token (or extend `src/github.ts` to mint one from a private key — out of scope for phase 1).

## Webhook setup

Production: in the repo settings → **Webhooks** → add `https://<host>/webhook/github`, content type `application/json`, secret matches `GITHUB_WEBHOOK_SECRET`, subscribe to **Issues** and **Issue comments**.

Local dev: use [smee.io](https://smee.io) to forward GitHub events:

```bash
npx smee -u https://smee.io/<your-channel> -t http://localhost:3000/webhook/github

```

## Endpoints

<table class="border-collapse w-full" style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Method</p></th><th colspan="1" rowspan="1"><p>Path</p></th><th colspan="1" rowspan="1"><p>Notes</p></th></tr><tr><td colspan="1" rowspan="1"><p>GET</p></td><td colspan="1" rowspan="1"><p>/api/issues</p></td><td colspan="1" rowspan="1"><p>Issues joined with roadmap_meta</p></td></tr><tr><td colspan="1" rowspan="1"><p>PATCH</p></td><td colspan="1" rowspan="1"><p>/api/issues/:num</p></td><td colspan="1" rowspan="1"><p>Two-way: title/body/state/labels/assignee</p></td></tr><tr><td colspan="1" rowspan="1"><p>PATCH</p></td><td colspan="1" rowspan="1"><p>/api/issues/:num/roadmap</p></td><td colspan="1" rowspan="1"><p>App-only: plannedMonth/notes/position</p></td></tr><tr><td colspan="1" rowspan="1"><p>GET</p></td><td colspan="1" rowspan="1"><p>/api/issues/:num/comments</p></td><td colspan="1" rowspan="1"><p></p></td></tr><tr><td colspan="1" rowspan="1"><p>POST</p></td><td colspan="1" rowspan="1"><p>/api/issues/:num/comments</p></td><td colspan="1" rowspan="1"><p>Two-way</p></td></tr><tr><td colspan="1" rowspan="1"><p>PATCH</p></td><td colspan="1" rowspan="1"><p>/api/comments/:id</p></td><td colspan="1" rowspan="1"><p>Two-way</p></td></tr><tr><td colspan="1" rowspan="1"><p>DELETE</p></td><td colspan="1" rowspan="1"><p>/api/comments/:id</p></td><td colspan="1" rowspan="1"><p>Two-way</p></td></tr><tr><td colspan="1" rowspan="1"><p>GET</p></td><td colspan="1" rowspan="1"><p>/api/meta</p></td><td colspan="1" rowspan="1"><p>Rate-limit + counts + areas</p></td></tr><tr><td colspan="1" rowspan="1"><p>POST</p></td><td colspan="1" rowspan="1"><p>/webhook/github</p></td><td colspan="1" rowspan="1"><p>HMAC-verified</p></td></tr></tbody></table>

## Rate-limit defenses

- GraphQL bulk fetch (50 issues + 50 comments each per call)
- Webhook-driven inbound; reconcile only on boot + nightly
- Rate-limit headers captured on every response, exposed at `/api/meta`
- Logger warns when remaining < 10% of limit
- Per-issue write debounce (300ms) helper available in `sync.ts`

## Out of scope (next phases)

- OAuth login + role gating (Viewer/Editor/Admin)
- GH App private-key flow (installation token minting)
- Conditional ETag caching layer
- Tests
