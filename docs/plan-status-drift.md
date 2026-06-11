# Plan — Status-vs-Plan Drift (Projects Todo/Backlog ↔ app isTodo/backlog)

Companion to `plan-milestone-drift.md`. Same pattern, **status axis** instead of time axis.
App stays canonical; GitHub Projects status is a **read-only second opinion**; drift is rendered,
never auto-resolved; only auto-flow is Projects → app via an explicit "snap" button.

## Why this is the cheap one
Projects status is **already mirrored** — no new GitHub work:
- `project_items` table has `status_label` + `status_option_id`, keyed by `content_number` (issue #) — `db.ts:120-132`.
- Query already pulls it: `PROJECT_ITEMS_QUERY`, `github.ts:737-782` (`statusLabel`/`statusOptionId`).
- Gap is only that it's **not joined** to roadmap meta. The two live as parallel systems.

## App's current status model (the canonical side)
- `roadmap_meta.is_todo` (0/1).
- **Backlog** = open AND `is_todo=0` AND `planned_month IS NULL` AND `planned_week IS NULL` (`brief.ts:200-203`).
- **Todo** = `is_todo=1` (mutually exclusive with time placement, `issues.ts:199-209`).
- So app status is effectively: `todo | backlog | scheduled` (scheduled = has plannedMonth/Week).

## The mapping problem (decide first)
Projects status labels are **arbitrary per board** ("Backlog", "Todo", "In Progress", "Done", "In Review"…)
and richer than the app's `todo|backlog|scheduled`. Need an explicit label→concept map; do **not** guess.

- Add a small config in `workspace_config` (reuse existing config GET/PATCH, `routes/config.ts`):
  `statusMap: { backlog: string[], todo: string[] }` — which Projects labels mean app-backlog / app-todo.
  Everything else (In Progress / Done / In Review / unset) → **not comparable** (those are flow/closed concepts the app tracks elsewhere).
- Default: best-effort case-insensitive match on the literal words "backlog" and "todo" / "to do". PM tunes in the AI/View config popover.

## Out of scope (explicit)
- App → Projects writes (moving the GitHub board column) — GitHub mutation, defer to write-identity phase.
- Mapping In Progress/Done/In Review onto app state — app derives "in progress" from the flow engine, not from board columns. Don't double-source it.
- Issues with no `project_items` row, or status outside the map → **unanchored**, render `—`, no guess.

## Steps

### Step 1 — Join Projects status onto the issue read
- `api/src/routes/issues.ts` list query: `LEFT JOIN project_items ON project_items.content_number = issues.number`,
  select `status_label` (and `status_option_id`). Note: a project item exists only if the issue is on the pinned board.
- `shared/types.ts` — add `projectStatus: string | null` to `ApiIssue` + `Issue`.
- **Verify:** `pnpm typecheck`; `/api/issues` shows `projectStatus` for issues on the board, `null` otherwise.

### Step 2 — Status projector + drift state
- New helper (web `lib`, alongside the milestone projector): given `projectStatus` + `statusMap` → app-concept `'backlog' | 'todo' | null` (null = outside map / unanchored).
- `statusDriftState(issue, statusMap)` → `'aligned' | 'drift' | 'unanchored' | 'no-status'`:
  - no `projectStatus` or maps to null → `unanchored`.
  - projected concept == app concept (todo vs backlog vs scheduled) → `aligned`, else `drift`.
  - e.g. app=backlog, Projects="Todo" → drift ("eng queued it, you have it in backlog").
- **Verify:** pure-function sanity over the cases above.

### Step 3 — Card status chip
- `Card.tsx`, in `.card-meta` (near the milestone drift chip from the companion plan).
- Render only on `drift`: `⚠ board: {projectStatus}`. Aligned/unanchored render nothing.
- `.card-status-chip` rule in `styles.css`.

### Step 4 — "Snap to board status" action (Projects → app, app-only write)
- Issue Drawer, shown only on `drift` where projected concept ∈ {backlog, todo}.
- Calls existing `PATCH /api/issues/:num/roadmap` (`issues.ts:154`, `RoadmapPatchBody`):
  - board=Todo → `{ isTodo: true }` (clears plannedMonth/Week per existing mutual-exclusion).
  - board=Backlog → `{ isTodo: false, plannedMonth: null, plannedWeek: null }`.
- **No new endpoint, no GitHub write.**
- **Verify:** drift issue → snap → card moves to TODO/Backlog meta column, chip clears.

### Step 5 — Progress rollup line
- `Progress.tsx`, secondary rail (next to the milestone-drift line).
- Over master-filtered issues: "N items where board status ≠ your plan" with a 1-line breakdown
  (e.g. "3 you have in backlog are Todo on the board").
- Client-side from the issue list.
- **Verify:** count matches a manual tally.

## Sequence & gates
1. Step 1 (join) → typecheck + data present.  ← blocks rest
2. Decide `statusMap` default + config (Step 2 prerequisite).
3. Step 2 projector → sanity.
4. Steps 3–5 read Step 2, any order.
5. Final: typecheck green + `pnpm dev` walkthrough (chip → snap → Progress line).

## Relationship to milestone-drift plan
- Independent axes — can ship either first. Status axis needs **no GitHub mirroring change**, so it's the lower-risk first ship.
- Shared scaffolding: both add a card chip in `.card-meta`, a Drawer snap button, and a Progress rail line. Build the first one's pattern cleanly so the second reuses it.
- Both deliberately read-only against GitHub → neither touches the multi-writer/team-scoping question (still a separate prerequisite before multi-writer).
