# Multi-Pod Plan — many pods on one hosted server

Status: proposed. Owner: Anh. Date: 2026-06-11.

## Goal

Let pod:dlt (and future pods) use the same hosted instance as pod:mht without
clobbering each other's view, at-risk set, brief, or AI config — while keeping
the customer layer (accounts + insights) **shared org-wide**.

Decisions already locked with the owner:

- **Customer layer is shared org-wide.** No `workspace_id` on `accounts` /
  `insights` / `insight_*`. Insight↔issue linking stays cross-pod.
- **Open viewing + a header switcher.** Any signed-in (domain-gated) user can view
  any pod and switch the active one in the header. No per-pod membership ACL in v1.
- **One DB, shared raw mirror.** One reconcile loop mirrors the whole product
  repo into the shared `issues`/PR/event tables. Pods are read-time *views* via
  their own master filter — no N× GitHub rate-limit cost.

## UX (v1) — what the user actually sees

The visible delta is small and lives entirely in the header (`Header.tsx`).

**Header gains a pod selector next to the existing `ScopePill`:**

```
●  Roadmap   katalon-studio/product   [ MHT ▾ ]   [scope: pod:mht +area:auth ✎]
                                       └ pod        └ within-pod, personal
```

- **Only one pod exists:** no selector renders (nothing to switch) — the app looks
  exactly like today. The selector appears only when there are ≥2 non-archived pods.
- **Multiple pods exist:** every signed-in user gets the `[ MHT ▾ ]` dropdown
  listing all pods (no per-user membership in v1). Picking another pod is a **full
  context swap** — board, list, at-risk, progress, brief, AI reads all refetch.
  Like switching Slack workspaces.

**Two filter layers (decided with owner):**

| Layer | Lives on | Who edits | Scope of effect |
|---|---|---|---|
| **Pod base filter** (e.g. `include: pod:mht`) | `workspace_config` row | **Admin only** | Everyone in the pod |
| **Personal refinement** (e.g. `+ area:auth`) | per-user (see below) | **Any user, self only** | Just that user |

The effective filter is `pod_base AND personal_refinement`. The `ScopePill` is the
control for the layer the caller may edit: an **admin** editing it writes the pod
base (`workspace_config`); a **non-admin** editing it writes their own refinement.
The pill shows the composed result either way.

> **SUPERSEDED (owner, 2026-06-11): personal refinement is CUT from this plan.**
> Owner decided refinement scope = browsing surfaces only (board/list) — and the existing
> client-side `FilterPopover` (state / assignees / label substring) already does exactly that
> job. No `user_view_prefs` table, no `PATCH /api/view-pref`, no `masterFilter` email variant.
> `masterFilter(workspaceId)` takes only the workspace. `ScopePill` stays a single-layer,
> **admin-only** editor of the pod base filter (non-admins see it read-only). If cross-device
> persistence of the popover filter is ever wanted, persist to localStorage — still no server
> change. The sections below are kept for history; skip them when building.

### Personal refinement — storage (superseded, see above)

The master filter is applied **server-side on every read** (counts, at-risk, AI
prompts, brief — not just the board), so a personal refinement must be known
server-side to compose everywhere. Threading a filter through every request is the
wrong altitude. Instead, one tiny table the `masterFilter` helper already-being-
workspace-aware reads:

```sql
CREATE TABLE IF NOT EXISTS user_view_prefs (
  email        TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  include      TEXT NOT NULL DEFAULT '[]',
  exclude      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (email, workspace_id)
);
```

`masterFilter(workspaceId, email)` returns `pod_base ∧ caller_refinement`. Set via
`PATCH /api/view-pref` (writes the caller's row for the active pod). This persists
per-user-per-pod (survives reload/device) — slightly more than "ephemeral", but it
makes the refinement compose server-side for free, which a client-only approach
can't without per-request plumbing. If true ephemerality is wanted later,
clear-on-logout is a one-liner.

**Where the refinement applies (important scoping decision — confirm):** the
personal refinement narrows the **browsing surfaces only — the Roadmap board and
the List**. The **aggregate + AI surfaces (counts, at-risk, Progress, brief, AI
reads) stay defined by the pod base filter**, shared and cached **per pod**. So
two callers refine differently see the same pod health but a different board.
Rationale: "narrow what I'm looking at," not "redefine the pod's health" — and it
keeps the per-pod cache model intact (no per-user AI cost, no cache fragmentation).
Concretely: `masterFilter` takes a flag/variant — issue-list reads pass the caller
email (compose refinement); aggregate/AI reads pass none (pod base only).

> Altitude check: this is the one genuinely *new* capability multi-pod adds beyond
> scoping (today the filter is global + shared; now there's a personal layer). It's
> scoped tight: two label lists, one table, one PATCH, composed in the existing
> helper. No per-pod roles, no saved-view management, no sharing.

## The blocker today

`workspace_config` is a hard singleton — `id INTEGER PRIMARY KEY CHECK (id = 1)`.
That one row holds the master filter, bucketing, time axis, AI model overrides,
and `pod_last_seen_at`. Every read path consumes it. So pod:dlt editing the
master filter rewrites pod:mht's entire experience.

Config readers to re-thread (grep `workspace_config` / config getter):
`masterFilter.ts`, `health.ts`, `predictive.ts`, `ai.ts`, `routes/brief.ts`,
`routes/config.ts`, `routes/flow.ts`, `routes/meta.ts`, `routes/ai.ts`,
`openapi.ts` (doc only).

## What is shared vs per-pod

| Data | Disposition |
|---|---|
| `issues`, `comments`, `pulls`, `pull_reviews`, `pull_checks`, `issue_events` | **Shared raw mirror.** Scoped per pod at read time by master filter. |
| `accounts`, `insights`, `insight_issues`, `insight_accounts`, `insight_drafts`, `insight_ops` | **Shared org-wide.** No tenancy column. |
| `ai_summaries`, `ai_insights` | **Shared** (keyed by issue + content hash; pod-agnostic — see cache audit below). |
| `workspace_config` | **Per-pod.** De-singletoned (one row per pod). |
| `roadmap_meta` (planning fields) | **Per-pod.** Re-key to `(workspace_id, issue_number)` — see below. |
| `health_snapshots` | **Per-pod.** Composite key `(workspace_id, snapshot_date)`; computed over the pod's filtered set. |
| `pod_last_seen_at`, `ai_model_*` | **Per-pod** — already columns on the config row; just stop being singleton. |

### The planning-field collision — fix now, don't defer (codex pushback, accepted)

Correction to an earlier draft: app-only planning fields (`planned_month`,
`planned_week`, `is_todo`, `roadmap_notes`, `position`) live in **`roadmap_meta`**,
PK `issue_number` — **not** on the `issues` row. The collision is still real: a
dual-labeled issue (`pod:mht` *and* `pod:dlt`) would let two pods overwrite each
other's planned slot, ordering, todo flag, and notes.

**Decision (revised):** re-key `roadmap_meta` to `(workspace_id, issue_number)`
**now**, not later. The table is small and self-contained, so the cost is low
today; deferring means a *second* broad rewrite across the same read/write paths
once planning becomes workspace-aware. With the per-pod key, a dual-labeled issue
simply appears on **both** pods' boards with **independent** planning — no race,
no convention to enforce. The disjoint-label assumption becomes a nicety, not a
correctness requirement.

### Shared customer layer — presentation boundary (codex flag)

Sharing accounts/insights org-wide is coherent at the data layer, but the **UI
must not present a cross-pod issue as if it belongs to the active pod.** In the
account drawer's "cares-about issues" (and anywhere an insight surfaces issues),
an issue outside the active pod's master filter must get explicit out-of-pod
treatment — reuse the existing faded "out-of-scope ref" rendering (`IssueRefMarkdown`
already does this for master-filter-excluded refs). The account index/timeline
stay unscoped (all signals), but issue chips within them respect the active pod.

## Identity & access (fits the stateless auth)

Auth is stateless: email in a signed `rm_session` cookie, `req.user` set globally,
admin via `ADMIN_EMAILS`. There is **no users table**.

**Decision (owner): no per-pod membership in v1 — any signed-in user can view any
pod.** Google login + `ALLOWED_EMAIL_DOMAIN` already gates access to the org, which
is a reasonable trust boundary for internal roadmaps. So **no `workspace_members`
table, no membership gating** — a large simplification. (A membership ACL is the
deferred escape hatch if a pod ever needs to be private; see deferred list.)

- **Active workspace = a preference cookie** `rm_workspace` holding the active
  workspace id, validated only as "an existing, non-archived pod." Signing is
  *optional* — there's no access decision riding on it now, it's purely a UI
  preference. A cookie (vs query-param/localStorage) keeps the active pod known on
  every API call including curl/agents.
- Resolution order per request: cookie id (if it points at a live pod) → first
  non-archived pod. Never null (there's always ≥1 pod).
- **Admin** (`ADMIN_EMAILS`) still matters — it gates editing a pod's base filter
  and (later) pod CRUD. It does *not* gate viewing.
- **Auth-off / LOCAL_USER:** unchanged — sees all pods, active from cookie
  defaulting to the first row.

## Schema migration (PRAGMA-guarded, `api/src/db.ts`)

SQLite can't drop a CHECK constraint or change a PK in place, so this needs three
table rebuilds. Run them as **three guarded blocks inside one transaction** (each
guard = a sentinel column absent). No migration framework, no generic rebuild
helper — match the existing `db.ts` PRAGMA-guarded style.

1. If `workspace_config` still has the `CHECK (id = 1)` singleton shape:
   - `CREATE TABLE workspace_config_new` — same columns, `id INTEGER PRIMARY KEY
     AUTOINCREMENT`, plus `slug TEXT NOT NULL UNIQUE`, `name TEXT NOT NULL`,
     `archived_at TEXT` (slug is user-facing identity → unique; archived_at → see
     archive model below).
   - `INSERT INTO workspace_config_new SELECT *, 'mht', 'MHT', NULL FROM workspace_config` (existing row → workspace 1).
   - drop old, rename new. (Detect via a sentinel: a `slug` column absent ⇒ run.)
2. `CREATE TABLE IF NOT EXISTS user_view_prefs (...)` (personal refinement, see UX).
   No `workspace_members` table — viewing is open to any signed-in user.
3. `roadmap_meta` re-key to `(workspace_id, issue_number)`: table rebuild
   (SQLite can't change a PK in place), guarded by `workspace_id` column absent.
   `CREATE TABLE roadmap_meta_new (... , workspace_id INTEGER NOT NULL, PRIMARY KEY
   (workspace_id, issue_number))`; `INSERT ... SELECT ..., 1` (existing planning
   rows → workspace 1); drop + rename. All `roadmap_meta` reads/writes (the
   `/roadmap` PATCH, board reads) take `workspace_id`.
4. `health_snapshots`: rebuild to composite PK `(workspace_id, snapshot_date)`;
   backfill existing rows to `1`. Snapshot writes/reads filter by it.

Verify: `pnpm typecheck` + boot; existing planning data and the current MHT view
are byte-identical to before.

## Work breakdown (each step ends green: `pnpm typecheck` + manual boot)

### Step 1 — Schema + types
- Migration above in `db.ts`. Add `Workspace`, `WorkspaceMember` to `shared/types.ts`.
- Verify: boot, confirm one workspace `mht` exists holding the old config; MHT
  board/at-risk/brief unchanged.

### Step 2 — Thread `workspaceId` through reads + writes (the real surface area)
- This is the **actual tenancy boundary, not a cosmetic refactor** (codex): treat
  a read/write that forgets `workspaceId` as a bug class, not a style nit.
- Change the config getter to take a `workspaceId` and return that pod's row.
- `masterFilter(workspaceId, email?)`: pod base, ∧ caller's `user_view_prefs`
  refinement **only when an email is passed**. Issue-list reads (board, list) pass
  the email; aggregate/AI reads (`health.ts`, `predictive.ts`, `ai.ts`, `brief.ts`,
  `flow.ts`, `meta.ts`) pass **none** → pod base only (per-pod cache intact, see UX).
  All callers must pass the active `workspaceId` regardless.
- Thread `workspaceId` into `roadmap_meta` reads/writes (`routes/issues.ts`
  board read + `/roadmap` PATCH) and `health_snapshots` reads/writes.
- Verify: with a single workspace, every surface is identical to today (this step
  is behavior-preserving — no multi-pod behavior yet).

### Step 3 — Active-workspace resolution + endpoints
- `auth.ts` (or a sibling `workspace.ts`): `activeWorkspace(req)` reads
  `rm_workspace`, validates it points at a live (non-archived) pod, else falls back
  to the first non-archived pod. `setActiveWorkspaceCookie`.
- Global preHandler sets `req.workspaceId` after `req.user`.
- API (minimal): `GET /api/workspaces` (all non-archived pods),
  `POST /api/workspaces/active` (switch — validates the pod exists, no ACL),
  `PATCH /api/view-pref` (caller's personal refinement for the active pod).
  The existing scope-config PATCH (`config.ts`) that edits the pod **base** filter
  becomes **admin-gated** (`req.user.isAdmin`). **No pod CRUD endpoints in v1** —
  seeded by migration / direct DB / curl.
- Update `api/src/openapi.ts` for the new/changed endpoints (contract rule).
- Verify: switching pods (via curl with cookie) swaps board/at-risk/brief;
  auth-off local user sees all pods.

### Step 4 — Per-workspace health backfill
- `healthBackfill.ts`: loop `backfillHealthSnapshots(30)` per workspace; snapshot
  rows tagged with `workspace_id`. Boot backfill iterates workspaces.
- Verify: each pod gets its own snapshots + on-time sparkline.

### Step 5 — Frontend switcher (v1 = switcher only)
- Header workspace switcher (only when ≥2 pods): lists `GET /api/workspaces`,
  POSTs `/active`, refetches. Module-level cache pattern in a `useWorkspaces` hook.
- `ScopePill` becomes layer-aware: **admin** → edits pod base (existing PATCH);
  **member** → edits their `user_view_prefs` refinement (`PATCH /api/view-pref`).
  Pill displays the composed `base ∧ refinement` for everyone.
- `web/src/lib/api.ts` typed wrappers; `styles.css` section for the switcher.
- **No admin "Pods" CRUD UI in v1** — pod creation / base master-filter / archive
  is done by an admin via DB or curl. The polished settings surface is deferred
  product work, not part of the tenancy primitive.
- Verify: switch pods in the UI; view recomputes; the switcher hides when only one
  pod exists.

## Sequencing vs. github-oauth-write-identity

The two are independent (no shared schema): multi-pod scopes *views*; write-identity
gates *writes* by linked GitHub token. `user_view_prefs(email,…)` and
`user_github(email PK)` are parallel, both email-keyed and stateless. Either order
works; multi-pod is the smaller change now that membership is dropped.

## Cache audit (codex flag)

Caches whose **inputs become workspace-scoped** need a `workspace_id` component in
their key (or a conscious decision to stay global):

- **`ai_summaries` / `ai_insights`** — keyed by issue + content hash, pod-agnostic
  input → keep global. No change.
- **Account AI read ("Acme story")** — if its prompt context includes issue text
  and that context becomes pod-scoped, the cache key needs `workspace_id`. The
  customer layer is shared, so default: **keep global**, and ensure the account
  read does *not* silently pull pod-scoped issue context. Decide explicitly.
- **Progress AI Read (24h cache)** — computed over the master-filtered set →
  inherently per-pod. No schema change: namespace the existing cache key string,
  e.g. `progress:${workspaceId}`.

## Product decisions (owner, decided)

- **Issue creation auto-labels the active pod, slug-derived.** `POST /api/issues`
  applies `pod:${slug}` (codex: deriving from the master-filter `include` list is
  ambiguous once it holds more than one label — the slug is the unambiguous pod
  identity). v1 assumes the pod label convention is `pod:<slug>`.

## Pod lifecycle — archive, not delete (codex)

There is **no delete** in v1. "Planning must survive" + a hard row drop is
conceptually muddy (orphaned `roadmap_meta` rows pointing at a missing pod). The
clean model is **archive**:

- `workspace_config.archived_at TEXT NULL` (added in migration 1).
- Active-workspace resolution and `GET /api/workspaces` include only
  `archived_at IS NULL`. The switcher hides archived pods.
- A cookie pointing at an archived pod clears and falls back.
- **Nothing cascades.** `roadmap_meta`, `health_snapshots`, `user_view_prefs` rows
  all stay — they're tiny and let an un-archive fully rehydrate the pod.

No `DELETE` endpoint; archiving is a one-column flip (done by admin via DB in v1,
matching "no admin CRUD UI yet").

## Out of scope / deferred

- Per-pod scoping of accounts/insights (explicitly shared org-wide).
- **Per-pod view membership / private pods** — v1 lets any signed-in (domain-gated)
  user view any pod. A `workspace_members(email, workspace_id)` ACL is the escape
  hatch if a pod ever needs to be restricted; the active-pod resolution would then
  gate on it. Not built now.
- Admin "Pods" CRUD UI (create/configure pods in-app) — seeded by DB/curl in v1.
- `DELETE` for pods — archive only in v1.
- Per-pod GitHub Project (`GITHUB_PROJECT_NUMBER`) — still one env-pinned Kanban;
  revisit if pods want distinct boards.
- Per-pod AI provider keys (AI config stays global env + per-pod model overrides,
  which the de-singletoned config already gives us).

## Risk notes

- Step 2 is the only broad-touch change (~10+ files); it's mechanical and
  behavior-preserving with one workspace, so it's verifiable before any
  multi-pod behavior exists.
- **Step 5 is intentionally just the switcher.** The admin pod-settings UX (the
  real product surface) is cut from v1 — pods are seeded/managed by an admin via
  DB/curl until the manual path hurts. Keeps the tenancy primitive small.
- **Access boundary is the existing login**, not the pod cookie. With no
  membership ACL, viewing any pod requires only a valid `rm_session` (Google +
  `ALLOWED_EMAIL_DOMAIN`). `rm_workspace` is a pure UI preference — validate it
  only as "a live pod id," fall back to the first pod on garbage. No access
  decision rides on it, so signing is optional.
- **What still needs the admin gate:** editing a pod's **base** filter (shared
  config) is `ADMIN_EMAILS`-gated. A non-admin hitting that PATCH must 403 — the
  base filter defines the whole pod's view. Personal refinement (`view-pref`) is
  open to any caller, self-scoped by email.
- **Lower-case emails consistently** for `user_view_prefs` writes/reads —
  `auth.ts` already lower-cases for admin/domain checks; match it.
- **Don't leak auth-off/local semantics into hosted mode.** `LOCAL_USER` (admin)
  applies only when `authEnabled()` is false. In hosted mode the admin gate is
  real `ADMIN_EMAILS` membership.
- The roadmap_meta re-key removes the planning-collision footgun entirely; a
  dual-labeled issue now plans independently per pod (see above). No unenforced
  convention remains.
