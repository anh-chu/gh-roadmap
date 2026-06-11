# Per-user GitHub write identity — implementation plan  [LAYER 3, ships after roles]

Closes the masquerade hole: every GitHub write currently goes through one shared
`GITHUB_TOKEN`. After this, user-initiated writes act as the **caller's** GitHub identity;
reads + background jobs keep the service token.

**Layers above this (build first):** 1) Google auth = *who you are* (shipped). 2) roles =
*what you may do* (`docs/authorization-roles-plan.md`). By the time a request reaches the GitHub
identity resolver here, the role layer has already guaranteed the caller is an `editor`/`admin` —
viewers are 403'd upstream and never hit layer 3. So this doc assumes an authorized writer and only
answers "*as whom on GitHub?*". The `users` table created in layer 2 is where the GitHub connection
columns (`github_login`, `github_token_enc`, `github_linked_at`) attach — no separate side-table.

## Decisions (locked)
- **OAuth App** (not GitHub App). Long-lived user token, no refresh rotation, no install/private-key.
- **Unlinked user → block writes, allow reads.** Reads use service token; write endpoints return
  `409 github_not_linked` with a prompt to connect.
- **Background (sync / webhook / boot reconcile) → service token**, unchanged.

## New GitHub-side setup (one-time, manual)
Register an OAuth App (org-owned preferred): callback `https://<host>/api/github/callback`,
scope `repo`. Possibly needs org-admin approval if third-party access policy is on.

## New env
```
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
TOKEN_ENC_KEY=...   # 32-byte hex/base64 → AES-256-GCM at-rest encryption of stored user tokens
```
When `GITHUB_OAUTH_CLIENT_ID`/`SECRET` unset → feature off, all writes use the service token
(preserves current localhost single-user behaviour).

### Boot-time guards (refuse to boot if violated)
- Feature "enabled" = **both** client id AND secret present. Exactly one set → refuse boot
  (partial/misconfig, not limp-along).
- Feature enabled but `TOKEN_ENC_KEY` unset → refuse boot. Never store plaintext tokens.
- `TOKEN_ENC_KEY` validated **only when OAuth is enabled** → decodes to **exactly 32 bytes** +
  one-shot **encrypt→decrypt self-test** at boot; abort on failure. (OAuth off ⇒ key unused, a
  malformed value must not break the zero-friction localhost path.)
- Feature enabled but **Google auth disabled** → refuse boot. Otherwise every GitHub link maps
  onto the single `local` pseudo-user — harmless on localhost, an identity-collapse hole in any
  shared deploy. Per-user GitHub identity only makes sense when the human is authenticated.

### Logging hygiene
Never log: user tokens, encrypted blobs, OAuth `code`/`state`, or raw GitHub response bodies from
the token-exchange / `/user` calls. Redact at the call sites.

---

## Build order

### 1. `getOctokit()` refactor — `api/src/github.ts`  (prereq)
- Keep the module-level service client; expose it as `export function serviceOctokit(): Octokit`.
- Every **write** fn takes a **required** leading/trailing `octo: Octokit` param — **no default**.
  This makes migration coverage *mechanical*: any unthreaded call site fails typecheck, so a missed
  site can't silently masquerade as the service token. Affected fns: `updateIssue`, `createIssue`,
  `createComment`, `updateComment`, `deleteComment`, `updateProjectItemStatus`, `publishInsightPr`,
  `mergeInsightPr`, `mergeInsightsPr`, `closeInsightPr`, `deleteInsightPr`.
- Background callers (sync, webhook, boot reconcile) pass `serviceOctokit()` explicitly.
- Add `export function octokitForToken(token: string): Octokit`.
- Read fns keep using the service client internally (unchanged). Typecheck green before step 4.

### 2. GitHub connection columns on the `users` table — `api/src/db.ts`
The `users` table already exists from layer 2 (roles). Add the GitHub connection as columns on it
(PRAGMA-guarded `ALTER`, the repo's migration pattern) — GitHub is *one connection on a user*, not a
separate identity store:
```sql
ALTER TABLE users ADD COLUMN github_login      TEXT;     -- null = unlinked
ALTER TABLE users ADD COLUMN github_token_enc  TEXT;     -- AES-256-GCM(iv:tag:ciphertext)
ALTER TABLE users ADD COLUMN github_linked_at  TEXT;
```
- Helpers: `getUserGithub(email)`, `linkUserGithub(email, login, tokenEnc)`, `unlinkUserGithub(email)`.

### 3. Token crypto + OAuth flow
- `api/src/crypto.ts` (new): `encryptToken` / `decryptToken` using `TOKEN_ENC_KEY` (AES-256-GCM).
- `api/src/githubOauth.ts` (new): `buildGithubAuthUrl(req,reply)` (uses its **own** state cookie
  name — `rm_gh_oauth_state`, NOT shared with Google's — scope `repo`),
  `exchangeCodeForGithubToken(code)` → `{ token, login, scopes }`. Mirrors the Google flow shape
  but lives in its own module.
- `api/src/routes/githubAuth.ts` (new):
  - `GET /api/github/login` → redirect to GitHub consent (must be signed-in).
  - `GET /api/github/callback` → exchange code → token. **Validate before storing:**
    (a) granted scopes include `repo` (users can grant fewer than requested — inspect
    `X-OAuth-Scopes`); (b) fetch `/user` for login; (c) verify the token **has access to the
    configured target repo** (single check — `GET /repos/{owner}/{repo}` with the user token; this
    subsumes "org member / collaborator" without rejecting legitimate outside collaborators). Any
    check fails → redirect with an error, do NOT store. Success → encrypt + `linkUserGithub`.
  - `POST /api/github/unlink` → `unlinkUserGithub`.
- Register in `server.ts`; these stay **behind** the Google session gate (the human is already
  logged in). Only Google's `/api/auth/*` is public.

### 4. Single write-identity resolver + `runGithubWrite` wrapper — the elegance core
All write routes go through **one** policy module so no route ever branches on auth mode.

- `api/src/githubWriteIdentity.ts` (new) — owns the whole policy (keep `auth.ts` about human
  sessions only):
  - `githubOAuthEnabled(): boolean`
  - `resolveWriteOctokit(req): Promise<Octokit>` — the single path:
    - OAuth **disabled** → `serviceOctokit()` *(no-auth localhost & Google-only deploys behave
      exactly like today — same code path as every other write)*.
    - OAuth **enabled** + user **linked** → decrypt token → `octokitForToken(...)` (decrypt &
      instantiate per call; **no per-user Octokit cache** — avoids token-lifetime/invalidation state).
    - OAuth **enabled** + **unlinked** → `throw new GithubLinkRequired()`.
  - typed errors `GithubLinkRequired` / `GithubReauthRequired` (no `null` ceremony at call sites).
- `runGithubWrite(req, reply, async (octo) => {...})` — one wrapper used by all ~12 sites:
  - resolves the Octokit, runs the body, returns its result;
  - `GithubLinkRequired` → `409 { error: "github_not_linked" }`;
  - GitHub **`401` Bad credentials** (token revoked) → `unlinkUserGithub` + `409 { error:
    "github_reauth_required" }`. **Only `401`** — never unlink on `403` (that's branch protection /
    rate limit / org policy, a normal denial, not a dead token).
- Write fns in `github.ts` take a **required `octo: Octokit` as the FIRST param** — every write
  call visibly starts with its identity, and typecheck proves migration coverage.

### 5. Surface link state + connect-on-attempt — `/api/auth/me` + `shared/types.ts` + frontend

**UX principle: keep ALL write controls live and discoverable. Do not hide/disable/grey any
write button based on link state.** The server is the only gate. Enforcement is the single 409 →
contextual connect prompt, so the ask appears at the moment of the action, explaining why.

- **Link state goes on `/api/auth/me` (`AuthMe`), NOT `MetaResponse`** — it's "who am I" identity,
  not repo metadata; keep one source of truth for identity. `AuthMe` gains
  `githubLinked: boolean` + `githubLogin: string | null` + `githubOauthEnabled: boolean`.
  (For the passive status chip + prompt copy only — never for gating a button.)
- `UserMenu.tsx`: passive status only — "Connect GitHub" (→ `/api/github/login`) when
  enabled+unlinked; `@login · Disconnect` when linked.
- **The gate = one shared interceptor in `lib/api.ts`.** On `409 github_not_linked` **or**
  `github_reauth_required`, swallow the generic error path and raise a single app-level
  Connect/Reconnect prompt (small modal): reason + Connect button (→ `/api/github/login`) + Cancel.
- No per-action wiring, no disabled states, no link-state checks at call sites. Buttons stay hot.

### 6. OpenAPI + README + .env.example
- Document the 3 new endpoints + new env vars. Update `api/src/openapi.ts` contract.

## Verify
- `pnpm typecheck` green after step 1 and again at end.
- Manual: with feature off → unchanged. With feature on, unlinked user → reads work, a comment
  POST returns 409. After connect → comment lands authored as that user on GitHub.

## Out of scope / deferred
- **App-level CSRF token on mutations.** Current posture = SameSite=lax cookies + non-GET mutations.
  A real CSRF-token/header layer would harden *every existing* cookie-auth write endpoint, not just
  this feature — track as separate hardening, don't bundle into this PR.
- `POST /api/insights/capture` agent-friendliness (already gated behind session post-Google-auth).
- Per-user rate-limit display (meta shows service-token budget only).
- GitHub App migration (narrower per-repo scope) — revisit if this outgrows the trusted pod.
