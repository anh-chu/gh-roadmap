# Authorization (roles) — implementation plan  [LAYER 2, ships first]

Adds an **app-level authority layer** between authentication (Google login, shipped) and the
GitHub write-identity work (separate doc, ships after). Concrete driver: company members (e.g.
sales) who should **read the whole app but mutate nothing** — a need GitHub's own permissions can't
express, because most app-only writes (roadmap placement, notes, config, accounts) never touch
GitHub.

## The three layers (orient before reading)
```
1. Authentication  — who are you            Google OAuth            ✅ shipped
2. Authorization   — what may you do         role: viewer/editor/admin   ← THIS doc
3. GitHub identity — as whom on GitHub       per-user OAuth connection    → github-oauth-write-identity-plan.md
```
A viewer is rejected at layer 2 and **never reaches layer 3**. Role check first ("may you write at
all?"), GitHub identity second ("as whom?").

## Roles
- `viewer` — read-only. GET/HEAD only. The default for any signed-in user not promoted.
- `editor` — may perform all app writes (DB planning layer + GitHub mutations). Today's default behaviour.
- `admin` — editor + may manage roles + AI model settings + data export/import.

### Role resolution (single helper `roleFor(email)`)
```
email ∈ ADMIN_EMAILS (env)  → admin     (immutable bootstrap — cannot be demoted in-app, can't lock out)
else users.role (if row)    → that role (set via in-app UI by an admin)
else                        → viewer    (default; new signed-in user can read, nothing more)
```
- **No-auth localhost mode** (Google auth off): the single `local` user is `admin`, the role system
  is dormant — behaves exactly like today. The viewer-gate is a no-op when auth is off.
- **Default-viewer inverts today's auth-on behaviour** (everyone was an implicit editor). That's why
  `ADMIN_EMAILS` is the immutable bootstrap: on first deploy the env admins seed the system and
  promote others; no one can get locked out of their own instance.

## Data — `api/src/db.ts`
```sql
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'viewer',  -- viewer | editor | admin
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```
- Row is upserted on each successful Google login (email + name; role left as-is, default viewer on
  first sight). This table is also the substrate the **GitHub connection** columns attach to later
  (layer 3) — "GitHub is one connection on a user", not a side-table.
- Helpers: `getUser(email)`, `upsertUserOnLogin(email, name)`, `setUserRole(email, role)`, `listUsers()`.

## Enforcement — `api/src/auth.ts` + `server.ts`
- `SessionUser` gains `role: Role`. Keep `isAdmin` as a derived getter (`role === "admin"`) so
  existing admin gating (AI settings, data export/import) is untouched.
- **One global guard**, no per-route matrix. In the existing `onRequest` hook, after the user is
  resolved: if `user.role === "viewer"` AND method ∉ {GET, HEAD} AND path ∉ exempt → `403`.
  - Exempt: `/api/auth/*` (a viewer must be able to **logout** — a POST). Nothing else.
  - This single rule covers **every** mutating endpoint we enumerated — GitHub writes, app-only DB
    writes, AI generation (writes the shared cache), sync/refresh — with zero per-route work.
    Viewers are frozen on whatever the last editor/sync produced.
- `requireAdmin` (exists) stays for admin-only routes. No `requireEditor` needed — the global
  viewer-gate already blocks non-editors from mutations.

## Role management API — `api/src/routes/users.ts` (new, admin-only)
- `GET  /api/users` — list users + roles (admin).
- `PATCH /api/users/:email/role` — set role to viewer/editor/admin (admin). **Reject** edits to an
  `ADMIN_EMAILS` member (immutable) and reject self-demotion of the last admin (lock-out guard).

## Frontend
- `AuthMe` / `AuthUser` gains `role`.
- **Read-only UX for viewers** — unlike the GitHub-link case (achievable → keep button live + prompt
  to connect), a viewer's write is **never** achievable, so showing dead buttons that always 403 is
  bad UX. Viewers: **hide/disable write affordances** (new-issue, drag, edit, comment box, config
  controls, AI regenerate). Server still enforces (defense in depth); UI just doesn't dangle them.
- **Admin "Users" panel** — a settings surface (mirror `AiSettings`/`DataSettings` popover pattern in
  `Header.tsx`) listing members with a role dropdown. Admin-only, hidden otherwise.

## OpenAPI + .env.example + README
- Document `GET /api/users`, `PATCH /api/users/:email/role`, the `role` field on `/api/auth/me`,
  and clarify `ADMIN_EMAILS` is now the immutable bootstrap-admin list.

## Verify
- `pnpm typecheck` green.
- Manual: with auth off → unchanged (local admin, gate dormant). With auth on: a non-`ADMIN_EMAILS`
  user logging in fresh = viewer, sees all tabs, every write returns 403 / controls hidden; admin
  promotes them to editor in the Users panel → writes work; sync/refresh blocked for viewers.

## Explicitly NOT in this layer
- Per-action capability matrix (only 3 coarse roles — a pod doesn't need finer).
- User-scoped AI generation (personalization — a separate feature axis, not a permission concern).
- GitHub write-identity (layer 3, separate doc).
- Multi-tenant / SaaS productization (a different app; shelved as a note, not code).
