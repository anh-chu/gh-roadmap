# Plan — Milestone-vs-Plan Drift (Option C alignment)

## Goal
`plannedMonth`/`plannedWeek` stays canonical for the timeline. GitHub milestone `due_on`
becomes a **read-only second opinion** projected onto the same time axis. Disagreement is
**rendered, never auto-resolved**. Only automatic flow: milestone → plan via explicit "snap"
button. Plan → milestone is always a deliberate GitHub write (deferred).

## Out of scope (explicit)
- Team-scoping / multi-writer conflict on planning fields — separate prerequisite, decide before going multi-writer.
- Plan → milestone GitHub writes ("propose milestone change") — needs write-identity (GitHub OAuth phase). Defer.
- Milestones with no `due_on` (version names like `v2.4`) → **unanchored**, render `—`, never fabricate a column (mock-data ban).

## Foundation gap (must do first)
Milestone is mirrored **title-only today** — `due_on` is never pulled. Everything depends on fixing this.

### Step 1 — Mirror milestone `due_on`
- `api/src/github.ts:89` — extend milestone selection in the GraphQL issues query to fetch `dueOn`. Type: `milestone: { title: string; dueOn: string | null } | null`.
- `api/src/db.ts` — add `milestone_due TEXT` to issues table via PRAGMA-guarded `ALTER`.
- `api/src/sync.ts:39` — upsert `milestone_due: i.milestone?.dueOn ?? null`.
- `shared/types.ts:11` — add `milestoneDue: string | null` to `ApiIssue` + mapped `Issue`.
- **Verify:** `pnpm typecheck` green; boot `pnpm dev`, confirm an issue with a dated milestone shows `milestoneDue` in `/api/issues`.

## Projection (the alignment rule)
### Step 2 — `due_on` → column projector
- New helper in `web/src/lib/timeRange.ts` (sits next to `issueColumnKey`): `milestoneColumnKey(dueOn, granularity)`.
  - month → `YYYY-MM`; week → ISO `YYYY-Www`; quarter → first month of quarter (matches existing internal quarter storage).
  - `null` dueOn → `null` (unanchored).
- New `driftState(issue, granularity)` → `'aligned' | 'drift' | 'unanchored' | 'no-plan'`:
  - no `plannedMonth/Week` → `no-plan` (nothing to compare).
  - has plan, no `milestoneDue` → `unanchored`.
  - `issueColumnKey === milestoneColumnKey` → `aligned`, else `drift`.
- **Verify:** pure function — quick inline sanity check across all three granularities + null cases.

## Surfaces (read-only, no GitHub writes)
### Step 3 — Card drift chip
- `web/src/components/Card.tsx` — after insight chip (after line 131), inside `.card-meta`.
- Render only when `driftState === 'drift'`: chip e.g. `⚠ milestone {projected col}` next to existing milestone display. Use `com` class; add a `.card-drift-chip` rule in `styles.css` (card section).
- Aligned/unanchored render nothing (no noise).

### Step 4 — "Snap to milestone" action (milestone → plan, app-only safe write)
- In the issue Drawer (where roadmap fields edit) — button shown only on `drift`.
- Calls existing `PATCH /api/issues/:num/roadmap` (`issues.ts:154`, `RoadmapPatchBody`) with `plannedMonth`/`plannedWeek` derived from `milestoneColumnKey`. **No new endpoint, no GitHub mutation.**
- **Verify:** drift issue → click snap → card moves to milestone column, chip clears.

### Step 5 — Progress "plan drift" rollup line
- `web/src/components/Progress.tsx` — new `hd-card pg-stat` in the secondary rail after Schedule (after line 150).
- Count over master-filtered, scheduled issues (reuse at-risk's planned-only scope — backlog excluded): "N planned earlier than milestone, M later, K unanchored."
- Compute client-side from the same issue list (no backend needed for v1).
- **Verify:** count matches manual tally on a small sample.

## Sequence & gates
1. Step 1 (mirror due_on) → typecheck + boot, confirm data present.  ← blocks everything
2. Step 2 (projector) → unit sanity.
3. Steps 3–5 in any order (all read Step 2).
4. Final: `pnpm typecheck` green + manual `pnpm dev` walkthrough of card chip → snap → Progress line.

## Why this shape
Drift is **signal, not error** — surfacing "my plan vs eng's committed milestone drifted" is a new PM lens.
Collapsing the two stores would trade that signal away and make every drag a shared-state mutation.
Keeping milestone read-only sidesteps the multi-writer landmine entirely for v1.
