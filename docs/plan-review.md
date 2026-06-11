# Architecture review — 4 plans in docs/ (2026-06-11)

Plans reviewed: `authorization-roles-plan.md` (L2), `github-oauth-write-identity-plan.md` (L3),
`MULTI-POD-PLAN.md`, `plan-milestone-drift.md`.

Verdict: all four are sound, well-scoped, and consistent with the codebase's curated style.
Recommended order: **milestone-drift → roles → multi-pod → write-identity**. Issues below are
mostly cross-plan seams, not flaws within any single plan.

---

## Cross-plan conflicts (must resolve before building)

### 1. Viewer gate vs multi-pod self-scoped writes — direct contradiction
Roles plan: global gate, `role=viewer` + method ∉ {GET, HEAD} → 403, exempt only `/api/auth/*`.
Multi-pod plan: `POST /api/workspaces/active` (pod switch) and `PATCH /api/view-pref`
(personal refinement) are "open to any caller".

A viewer cannot switch pods or refine their own view — but these are exactly the self-scoped,
non-shared-state actions a read-only sales user should have. **Fix:** define an exempt class
"self-scoped preferences" alongside `/api/auth/*`: `/api/workspaces/active`, `/api/view-pref`,
logout. Keep the global gate; the exempt list grows from 1 entry to 3. Document the rule:
*exempt = writes that touch only the caller's own row/cookie, never shared state.*

### 2. Viewer + insight capture — product tension
Roles plan's concrete driver is sales read-only. But sales hearing customer signal is the prime
source for `POST /api/insights/capture` — the workflow §7 of CLAUDE.md says not to break. Under
the global gate, viewers can't capture. Capture lands in a PM-reviewed inbox (draft, not
published), so it's arguably also "safe" for viewers. **Decision needed from owner:** exempt
capture for viewers, or accept that capture is editor-only. Recommend exempting — the inbox is
the review gate, and blocking the org's main signal source defeats the insights consolidation
mission (§6 reframe).

### 3. AI cache writes via GET slip past the viewer gate
The gate is method-based. Any GET that lazily populates an AI cache (summary fetch on
cache-miss) is a "write" a viewer can trigger. Probably acceptable (derived data, shared
benefit, costs AI tokens though). Just don't claim the gate covers "AI generation" absolutely —
explicit *regenerate* (POST) is blocked; lazy fill on GET is not. Decide: acceptable, or make
cache-miss return 204 for viewers ("frozen on whatever the last editor produced", literally).

### 4. Stale claim: "There is no users table"
Multi-pod plan says auth is stateless with no users table. True today; false once roles ships
(recommended first). Cosmetic, but: `user_view_prefs.email` should follow the same
lowercase-email convention, and conceptually it's a per-user satellite of `users`. No FK needed
(matches repo style), but upsert the `users` row pattern, don't fork a second identity notion.

---

## Per-plan findings

### MULTI-POD-PLAN.md
- **Step 2 file list undercounts.** Plan lists ~8 config/filter consumers. Actual `masterFilter`
  importers today: 16 files — the plan's list misses `pmActions.ts`, `routes/pmActions.ts`
  ("On your plate", shipped after the plan draft), `routes/comments.ts`, `routes/pulls.ts`,
  `routes/projects.ts`, `healthBackfill.ts`. The "forgot-workspaceId = bug class" framing is
  right; make the checklist from a fresh grep at build time, not from the plan.
- **Export/import (e745d10) not mentioned.** Full-workspace backup/restore shipped recently.
  Re-keying `roadmap_meta` and `health_snapshots` and de-singletoning `workspace_config` breaks
  the import path for both old backups and the export shape. Add a step: update export/import
  to the new schemas + accept legacy (pre-workspace) backups by injecting `workspace_id = 1`.
  This is planning data that "cannot be re-derived from GitHub" — the backup path must not rot.
- **Migration `INSERT ... SELECT *, 'mht', 'MHT', NULL`** — positional `SELECT *` against a
  rebuilt table is fragile (column-order coupling, and the old row has `id=1` which must be
  preserved so backfilled snapshot/meta rows pointing at workspace 1 line up — they do, since
  explicit id insert into AUTOINCREMENT is legal, but write explicit column lists).
- **RESOLVED (owner, 2026-06-11): personal refinement cut entirely.** Owner chose
  browse-surfaces-only scoping, then observed the existing client-side `FilterPopover` already
  covers that. `user_view_prefs` / `PATCH /api/view-pref` / `masterFilter` email variant all
  dropped; `ScopePill` stays admin-only. Multi-pod shrinks to pure tenancy threading.
- **RESOLVED (owner): viewers may `POST /api/insights/capture`** (exempt from viewer gate) and
  lazy AI cache-fill on GET stays allowed for viewers.
- Shared `ai_summaries` decision is correct *only because* prompt context is per-issue, not
  per-filter. The account-read "decide explicitly" flag: account read pulls cares-about issues
  cross-pod by design → keep global, and assert it never applies the active pod's filter.

### authorization-roles-plan.md
- Smallest, cleanest plan. One global guard beats a route matrix — right altitude.
- **Deploy-day inversion:** when this ships to the hosted instance, every existing non-admin
  user silently becomes a viewer. Plan acknowledges it; add an operational step: promote known
  editors in the same deploy window, or seed `users` rows via migration/curl before flipping.
- Last-admin lock-out guard: also reject demotion when the target is the *only* admin counting
  `ADMIN_EMAILS` ∪ db-admins — the env list makes true lock-out impossible, so the guard is
  belt-and-suspenders; keep it simple (env admins immutable suffices).
- Viewer UX (hide controls) vs write-identity UX (keep buttons hot, 409 prompt) are
  *deliberately opposite* and both correct — viewer's write is never achievable, unlinked
  editor's is. Worth a code comment where the two patterns meet so a future change doesn't
  "unify" them.

### github-oauth-write-identity-plan.md
- Strongest plan of the four. Required-leading-`octo` param making coverage typecheck-provable,
  single `resolveWriteOctokit`, 401-only unlink, boot guards — all right.
- One gap: write fns list (step 1) predates recent commits — re-grep `github.ts` write surface
  at build time (same staleness class as multi-pod Step 2).
- `repo` scope on a classic OAuth App grants the user-token access to *every* repo the user can
  reach — broad, but plan already defers GitHub App migration. Fine for trusted pod; keep the
  deferred note.
- Multi-pod interaction: none on schema (correct), but the `pod:${slug}` auto-label on
  `POST /api/issues` will, post-L3, be written *as the caller* — a user whose GitHub token
  lacks label permission gets a partial failure mode. Trivial, but worth a test case.

### plan-milestone-drift.md
- Smallest, fully independent, immediate PM value, no auth/tenancy interactions. **Ship first.**
- Two seam notes: (a) "snap" uses the roadmap PATCH — post-multi-pod that PATCH is
  workspace-keyed; drift is computed client-side per active pod view, so it composes for free.
  (b) Snap is a mutation → viewers won't see the button (consistent with hide-controls UX).
- `milestone_due` confirmed absent today (`dueOn` not in github.ts) — Step 1 foundation gap real.

---

## Recommended sequence + why

1. **Milestone drift** — ~1 day, zero coupling, delivers PM value while the auth plans settle.
2. **Roles** — creates the `users` substrate L3 needs; resolve conflicts #1/#2 above *in this
   plan's exempt list* before building (cheap now, breaking change later).
3. **Multi-pod** — bigger but mechanical; lands before write-identity so the broad Step-2
   threading doesn't collide with the broad `octo`-param threading in `github.ts`/routes
   (different files mostly, but both touch every write route — don't run concurrently).
4. **Write-identity** — last, as both plans already state.

Each step ends green (`pnpm typecheck` + boot) per repo convention; no plan needs a test suite
it doesn't have.
