# Plan — Todo/Backlog status backed by GitHub Projects (single source)

## Intention
GitHub Projects v2 (board **#16**) becomes the **single source of truth for Todo vs Backlog**.
Retire the app-only `is_todo` flag as an authority. The Roadmap board's TODO/Backlog meta columns
**read from** Projects Status and **write back to** it. No second store, no drift to reconcile.

Verified against live data (project 16):
- Status options exist and map cleanly: **Todo = `To Do`**, **Backlog = `Backlog`**.
- Other options (`In Progress` / `In Review` / `Approved` / `Done` / `Wont do`) are **not** roadmap-planning
  states — flow engine + closed-state handle them. Out of scope for the two meta columns.
- 476 open issues; **144 not on the board**; **236 on board with no Status**. So:
  - "Untriaged" = Status unset → simply **not shown** in the two meta columns (no new column).
  - Off-board issues (144) need `addProjectV2ItemById` before a status can be written (minority case).

## Scope
**In:** Todo/Backlog meta columns driven by Projects Status (read + optimistic write), add-to-board for
off-board issues, retire `is_todo` as authority, + a `roadmapNotes` editor UI (bundled per owner request).
**Out:** timeline (`plannedMonth`/`week`) stays app-only — future convergence to the board's `Target date`
field is parked. `position` stays app-only (no GitHub equivalent). No drift view (approach abandoned).

---

## Architecture review amendments (2026-06-12, verified against code)

1. **Staleness gap — must fix in A1/A3.** `project_items` refreshes only when the Kanban
   routes are hit (60s freshness gate in `routes/projects.ts` `refreshOne`). A PM living in
   the Roadmap tab never triggers it → meta columns would join stale status indefinitely.
   Fix: refresh the pinned project inside `reconcile()` (boot/nightly/webhook-debounced —
   same pattern as the milestone-due pass), keeping the 60s gate for interactive paths.
2. **Multi-pod semantics — decided (owner):** shared board status across pods is fine —
   pods structurally filter by different labels, so cross-pod triage collision isn't a
   practical concern. Per-pod `todoStatusName`/`backlogStatusName` config (A2, on the now
   per-pod `workspace_config`) is the escape hatch if pods later get distinct boards.
3. **Write-identity integration (plan predates it).** A4/A5 server writes go through
   `runGithubWrite` with the required-leading-`octo` pattern (`updateProjectItemStatus`
   already migrated; `addProjectV2ItemById` must match). The A4 optimistic rollback must
   also handle the `409 github_not_linked` case — same rollback, the shared interceptor
   raises the Connect modal.
4. **Issue `node_id` is NOT mirrored (confirmed).** A5 requires: GraphQL `id` on the issues
   query, PRAGMA-guarded `node_id` column on `issues`, upsert in sync.
5. **Project-row bootstrap.** A5 needs the project's GraphQL node id from the `projects`
   row, which exists only after a project fetch. The add-to-board path must ensure/refresh
   the project row first — free once amendment 1 runs the refresh in reconcile.
6. **Drawer Todo toggle (add to scope).** A3 stops reading `is_todo`, but the Drawer
   planning control still writes it — a visibly dead toggle. Rewire it to the same status
   write as A4 (drawer = same triage act as drag), or remove it.

## Part A — Status ← → Projects (the core)

### A1. Read: join Projects Status onto each issue
- `api/src/routes/issues.ts` list query — `LEFT JOIN project_items ON project_items.content_number = issues.number`;
  select `status_label`, `status_option_id`, and the project **item id** (needed for writes).
- `shared/types.ts` — add to `ApiIssue`/`Issue`: `projectStatus: string | null`, `projectItemId: string | null`.
- **Verify:** `/api/issues` shows `projectStatus` (`To Do`/`Backlog`/etc/null) per issue; `pnpm typecheck` green.

### A2. Config: which option = Todo / Backlog
- `workspace_config` (reuse `routes/config.ts`): `todoStatusName` (default `"To Do"`), `backlogStatusName` (default `"Backlog"`).
- Resolve names → option ids from the project's stored Status options (`projects.fields_json`).
- Defaults match board 16, so zero-config for current board; tunable for other boards/pods later.
- **Verify:** config GET returns the two names; resolver finds the matching option ids.

### A3. Meta columns read from Status (replace `is_todo`)
- `web/src/components/Board.tsx` column placement (`~line 175-177`, `TODO overrides → planned → backlog`):
  - `projectStatus === todoStatusName` → TODO column.
  - `projectStatus === backlogStatusName` → Backlog column.
  - else → not in meta columns (unchanged time-col / off-grid behavior).
- `is_todo` no longer drives placement. Keep the DB column for now (don't break old data) but stop reading it for meta placement; mark deprecated in a comment.
- **Verify:** TODO/Backlog columns populate from real board status (49 To Do / 21 Backlog), not the old flag.

### A4. Write: drag into Todo/Backlog sets Projects Status (optimistic)
- Reuse existing write path: `patchProjectItemStatus` (`web/src/lib/api.ts:282`) → `PATCH /api/projects/:num/items/:itemId` (`projects.ts:295`).
- On drop into TODO/Backlog: resolve target option id (A2), call with the issue's `projectItemId`.
- **Optimistic UI:** flip local card state immediately → fire mutation in background → on success the next
  poll/refetch confirms; **on failure, roll back + toast** (matches owner's spitball; latency hidden).
- **Verify:** drag To Do→Backlog in app → board #16 reflects it on GitHub; failure rolls back.

### A5. Off-board issues (the 144): add-to-board on demand
- New mutation in `api/src/github.ts`: `addProjectV2ItemById(projectId, issueNodeId)` → returns new item id.
- In the status PATCH handler (`projects.ts`): if the issue has **no** `projectItemId`, add it to the board
  first, then set Status. Needs the issue's GraphQL **node id** (confirm it's mirrored; add if missing).
- This fires only for off-board issues (minority). It is a **real shared mutation** (item appears on the team
  board) — that's the intended triage act, not a side effect to hide. `log`/toast it so it's not silent.
- **Verify:** drag an off-board issue into Todo → it's added to board #16 + status set; re-drag just updates status.

---

## Part B — `roadmapNotes` editor UI (bundled)

Field already exists end-to-end (`roadmap_notes` column, `RoadmapPatchBody.roadmapNotes`, openapi) but has
**no editor UI** — only an API docstring mention. Add the rendering/edit flow.

- `web/src/components/Drawer.tsx` — add a **Notes** section in the roadmap/planning area (near the
  Backlog/TODO planning control, ~line 530s). Textarea bound to `issue.roadmapNotes`.
- Save via existing `PATCH /api/issues/:num/roadmap` `{ roadmapNotes }` (app-only write, no GitHub). Debounce or save-on-blur.
- Display: render notes (read state) in the Drawer; optional small note indicator on the card later (defer).
- Stays **app-only** — no Projects/GitHub equivalent, no divergence.
- **Verify:** type a note in the Drawer → reload → persists; appears in `/api/issues`.

---

## Sequence & gates
1. A1 (read/join) → typecheck, data present.  ← blocks A3/A4
2. A2 (config + resolver).
3. A3 (read placement) → columns populate from status.
4. A4 (optimistic write) → round-trips to board #16.
5. A5 (add-to-board) → off-board triage works.
6. B (notes UI) — independent, any time.
7. Final: `pnpm typecheck` green + `pnpm dev` walkthrough: drag Todo↔Backlog (on-board + off-board), edit a note.

## Tradeoff accepted (recorded)
Single authority for status; cost is a GitHub round-trip per status change + 60s poll staleness, both hidden by
optimistic UI. `is_todo` deprecated, not deleted (preserve existing data; remove in a later cleanup).
