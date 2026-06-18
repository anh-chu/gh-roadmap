import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import {
  listRepoProjects,
  fetchProjectItems,
  updateProjectItemStatus,
  addProjectV2ItemById,
  getRepoSlug,
  type GhProjectSummary,
  type GhProjectItemRaw,
} from "../github.js";
import { runGithubWrite } from "../githubWriteIdentity.js";
import { getMasterFilter, passesMasterFilter, type MasterFilter } from "../masterFilter.js";
import type { ProjectFull, ProjectItem, ProjectStatusOption, ProjectSummary } from "../../../shared/types.js";

const FRESH_MS = 60_000;

// Turn opaque Octokit GraphQL errors into something a human can act on.
function explainGhError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: string; status?: number; errors?: Array<{ message?: string; type?: string }> };
  const msg = e.message ?? "";
  if (e.status === 401 || /bad credentials/i.test(msg)) {
    return "GitHub returned 401 — token invalid or expired";
  }
  if (e.status === 403 || /scope|forbidden|insufficient|sso/i.test(msg)) {
    return "Token missing `project` scope (classic PAT) or `read:project`+`write:project` (fine-grained). Regenerate with project scope.";
  }
  if (Array.isArray(e.errors) && e.errors.length) {
    return e.errors.map((x) => x.message ?? x.type ?? "").filter(Boolean).join("; ");
  }
  return msg || "unknown error";
}

interface ProjectRow {
  number: number;
  node_id: string;
  title: string;
  status_field_id: string | null;
  fields_json: string;
  last_synced_at: string;
}

interface ItemRow {
  item_id: string;
  project_number: number;
  content_type: string;
  content_number: number | null;
  content_title: string;
  content_repo: string | null;
  status_option_id: string | null;
  status_label: string | null;
  assignees_json: string;
  raw_json: string;
  last_synced_at: string;
}

function getProjectRow(num: number): ProjectRow | undefined {
  return db().prepare("SELECT * FROM projects WHERE number = ?").get(num) as ProjectRow | undefined;
}

function getAllProjectRows(): ProjectRow[] {
  return db().prepare("SELECT * FROM projects ORDER BY number ASC").all() as ProjectRow[];
}

function statusOptionsFromRow(r: ProjectRow): ProjectStatusOption[] {
  if (!r.status_field_id) return [];
  try {
    const fields = JSON.parse(r.fields_json) as Array<{
      __typename: string;
      id?: string;
      options?: ProjectStatusOption[];
    }>;
    const sf = fields.find((f) => f.id === r.status_field_id);
    return sf?.options ?? [];
  } catch {
    return [];
  }
}

function upsertProject(p: GhProjectSummary, now: string): void {
  db()
    .prepare(
      `INSERT INTO projects(number, node_id, title, status_field_id, fields_json, last_synced_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(number) DO UPDATE SET
         node_id=excluded.node_id, title=excluded.title,
         status_field_id=excluded.status_field_id, fields_json=excluded.fields_json,
         last_synced_at=excluded.last_synced_at`,
    )
    .run(p.number, p.nodeId, p.title, p.statusFieldId, p.fieldsJson, now);
}

function replaceItems(projectNumber: number, items: GhProjectItemRaw[], now: string): void {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM project_items WHERE project_number = ?").run(projectNumber);
    const stmt = d.prepare(
      `INSERT INTO project_items(item_id, project_number, content_type, content_number, content_title,
         content_repo, status_option_id, status_label, assignees_json, raw_json, last_synced_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const it of items) {
      stmt.run(
        it.itemId,
        projectNumber,
        it.contentType,
        it.contentNumber,
        it.contentTitle,
        it.contentRepo,
        it.statusOptionId,
        it.statusLabel,
        JSON.stringify(it.assignees),
        JSON.stringify(it.raw),
        now,
      );
    }
  });
  tx();
}

// Lock the Kanban view to a single project when GITHUB_PROJECT_NUMBER is set —
// mirrors the single-repo lock via GITHUB_OWNER/GITHUB_REPO.
export function projectFilter(): number | null {
  const raw = process.env.GITHUB_PROJECT_NUMBER ?? "";
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function syncAllProjects(): Promise<void> {
  const all = await listRepoProjects();
  const pin = projectFilter();
  const projects = pin === null ? all : all.filter((p) => p.number === pin);
  const now = new Date().toISOString();
  for (const p of projects) {
    upsertProject(p, now);
    const items = await fetchProjectItems(p.nodeId, p.statusFieldId);
    replaceItems(p.number, items, now);
  }
  // Drop any cached projects that no longer exist on GH (or fall outside the pin).
  const keep = new Set(projects.map((p) => p.number));
  const rows = getAllProjectRows();
  for (const r of rows) {
    if (!keep.has(r.number)) {
      db().prepare("DELETE FROM project_items WHERE project_number = ?").run(r.number);
      db().prepare("DELETE FROM projects WHERE number = ?").run(r.number);
    }
  }
}

async function refreshOne(num: number): Promise<ProjectRow | null> {
  const projects = await listRepoProjects();
  const match = projects.find((p) => p.number === num);
  if (!match) return null;
  const now = new Date().toISOString();
  upsertProject(match, now);
  const items = await fetchProjectItems(match.nodeId, match.statusFieldId);
  replaceItems(num, items, now);
  return getProjectRow(num) ?? null;
}

// Stale-while-revalidate: refresh a board in the background, de-duped so concurrent
// reads don't stack GitHub round-trips. Failures are logged, never surfaced (the
// caller already served the cached board).
const refreshing = new Set<number>();
function backgroundRefresh(app: FastifyInstance, num: number): void {
  if (refreshing.has(num)) return;
  refreshing.add(num);
  void refreshOne(num)
    .catch((err) => app.log.warn({ err, num }, "background project refresh failed"))
    .finally(() => refreshing.delete(num));
}

// Reconcile hook: force-refresh the env-pinned project mirror (no 60s freshness
// gate — that gate only guards interactive Kanban paths). Silent no-op when
// GITHUB_PROJECT_NUMBER is unset. Also guarantees the projects row (node id +
// fields_json) exists for status writes.
export async function refreshPinnedProject(): Promise<void> {
  const pin = projectFilter();
  if (pin === null) return;
  await refreshOne(pin);
}

function isFresh(row: ProjectRow): boolean {
  const t = Date.parse(row.last_synced_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < FRESH_MS;
}

function itemRowToJson(r: ItemRow): ProjectItem {
  return {
    itemId: r.item_id,
    contentType: r.content_type as ProjectItem["contentType"],
    contentNumber: r.content_number,
    contentRepo: r.content_repo,
    contentTitle: r.content_title,
    statusOptionId: r.status_option_id,
    statusLabel: r.status_label,
    assignees: JSON.parse(r.assignees_json) as string[],
  };
}

function applyMasterFilter(items: ProjectItem[], mf: MasterFilter): ProjectItem[] {
  if (mf.include.length === 0 && mf.exclude.length === 0) return items;
  // Look up labels for issues by content_number. PRs and drafts pass through.
  const issueLabels = new Map<number, string[]>();
  const numbers = items
    .filter((i) => i.contentType === "Issue" && i.contentNumber !== null)
    .map((i) => i.contentNumber as number);
  if (numbers.length > 0) {
    const placeholders = numbers.map(() => "?").join(",");
    const rows = db()
      .prepare(`SELECT number, labels FROM issues WHERE number IN (${placeholders})`)
      .all(...numbers) as { number: number; labels: string }[];
    for (const r of rows) {
      try {
        issueLabels.set(r.number, JSON.parse(r.labels) as string[]);
      } catch {
        issueLabels.set(r.number, []);
      }
    }
  }
  return items.filter((i) => {
    if (i.contentType !== "Issue" || i.contentNumber === null) return true;
    const labels = issueLabels.get(i.contentNumber);
    if (!labels) {
      // Issue isn't in our DB — drop it because we cannot evaluate the filter.
      return mf.include.length === 0;
    }
    return passesMasterFilter(labels, mf);
  });
}

function projectFull(row: ProjectRow, workspaceId: number): ProjectFull {
  const items = db()
    .prepare("SELECT * FROM project_items WHERE project_number = ? ORDER BY item_id ASC")
    .all(row.number) as ItemRow[];
  const mf = getMasterFilter(workspaceId);
  const mapped = items.map(itemRowToJson);
  const filtered = applyMasterFilter(mapped, mf);
  return {
    number: row.number,
    title: row.title,
    statusFieldId: row.status_field_id,
    statusOptions: statusOptionsFromRow(row),
    items: filtered,
    lastSyncedAt: row.last_synced_at,
  };
}

function projectSummary(row: ProjectRow): ProjectSummary {
  const countRow = db()
    .prepare("SELECT COUNT(*) AS c FROM project_items WHERE project_number = ?")
    .get(row.number) as { c: number };
  return {
    number: row.number,
    title: row.title,
    statusOptions: statusOptionsFromRow(row),
    itemCount: countRow.c,
  };
}

export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects", async (_req, reply) => {
    let rows = getAllProjectRows();
    if (rows.length === 0) {
      try {
        await syncAllProjects();
      } catch (err) {
        const detail = explainGhError(err);
        app.log.error({ err, detail }, "projects sync failed");
        return reply.code(502).send({ error: "github projects fetch failed", detail });
      }
      rows = getAllProjectRows();
    }
    return rows.map(projectSummary);
  });

  app.get<{ Params: { num: string } }>("/api/projects/:num", async (req, reply) => {
    const num = Number(req.params.num);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid project number" });
    const pin = projectFilter();
    if (pin !== null && num !== pin) return reply.code(404).send({ error: "project not in pinned scope" });
    let row = getProjectRow(num);
    if (!row) {
      // Cold: nothing cached, must block on GitHub.
      try {
        const refreshed = await refreshOne(num);
        if (!refreshed) return reply.code(404).send({ error: "project not found" });
        row = refreshed;
      } catch (err) {
        app.log.error({ err }, "project refresh failed");
        return reply.code(502).send({ error: "github project fetch failed" });
      }
    } else if (!isFresh(row)) {
      // Stale: serve the cached board instantly, revalidate in the background so the
      // Kanban tab never blocks on a GitHub round-trip. The client SWR-revalidates next open.
      void backgroundRefresh(app, num);
    }
    return projectFull(row, req.workspaceId);
  });

  app.post<{ Params: { num: string } }>("/api/projects/:num/refresh", async (req, reply) => {
    const num = Number(req.params.num);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid project number" });
    const pin = projectFilter();
    if (pin !== null && num !== pin) return reply.code(404).send({ error: "project not in pinned scope" });
    try {
      const row = await refreshOne(num);
      if (!row) return reply.code(404).send({ error: "project not found" });
      return projectFull(row, req.workspaceId);
    } catch (err) {
      app.log.error({ err }, "project refresh failed");
      return reply.code(502).send({ error: "github project refresh failed" });
    }
  });

  app.patch<{
    Params: { num: string; itemId: string };
    Body: { statusOptionId: string | null };
  }>(
    "/api/projects/:num/items/:itemId",
    {
      schema: {
        body: {
          type: "object",
          required: ["statusOptionId"],
          additionalProperties: false,
          properties: {
            statusOptionId: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid project number" });
      const pin = projectFilter();
      if (pin !== null && num !== pin) return reply.code(404).send({ error: "project not in pinned scope" });
      const projectRow = getProjectRow(num);
      if (!projectRow) return reply.code(404).send({ error: "project not found" });
      if (!projectRow.status_field_id) {
        return reply.code(400).send({ error: "project has no Status field" });
      }
      const itemRow = db()
        .prepare("SELECT * FROM project_items WHERE item_id = ? AND project_number = ?")
        .get(req.params.itemId, num) as ItemRow | undefined;
      if (!itemRow) return reply.code(404).send({ error: "item not found" });

      const newOptionId = req.body.statusOptionId;
      const options = statusOptionsFromRow(projectRow);
      let newLabel: string | null = null;
      if (newOptionId !== null) {
        const opt = options.find((o) => o.id === newOptionId);
        if (!opt) return reply.code(400).send({ error: "invalid statusOptionId" });
        newLabel = opt.name;
      }

      try {
        await runGithubWrite(req, reply, (octo) =>
          updateProjectItemStatus(
            octo,
            projectRow.node_id,
            itemRow.item_id,
            projectRow.status_field_id!,
            newOptionId,
          ),
        );
        if (reply.sent) return; // 409 link/reauth already sent by the wrapper
      } catch (err) {
        req.log.error({ err }, "project status update failed");
        return reply.code(502).send({ error: "github status update failed" });
      }

      const now = new Date().toISOString();
      db()
        .prepare(
          `UPDATE project_items SET status_option_id = ?, status_label = ?, last_synced_at = ?
           WHERE item_id = ?`,
        )
        .run(newOptionId, newLabel, now, itemRow.item_id);

      const updated = db()
        .prepare("SELECT * FROM project_items WHERE item_id = ?")
        .get(itemRow.item_id) as ItemRow;
      return itemRowToJson(updated);
    },
  );

  // Set the pinned board's Status for an issue by *status name* (the Roadmap meta-column
  // write path). Resolves the option id server-side from the project's stored Status
  // options. Side effect: when the issue is not yet on the board, it is first added via
  // addProjectV2ItemById — a real shared mutation (the item appears on the team board);
  // the response flags it as `addedToBoard` and it is logged, never silent.
  app.patch<{
    Params: { issueNum: string };
    Body: { statusName: string | null };
  }>(
    "/api/projects/pinned/issues/:issueNum/status",
    {
      schema: {
        body: {
          type: "object",
          required: ["statusName"],
          additionalProperties: false,
          properties: {
            statusName: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      const issueNum = Number(req.params.issueNum);
      if (!Number.isFinite(issueNum)) return reply.code(400).send({ error: "invalid issue number" });
      const pin = projectFilter();
      if (pin === null) {
        return reply.code(400).send({ error: "no pinned project (GITHUB_PROJECT_NUMBER unset)" });
      }
      // Ensure the project row (node id + Status options) exists — the add-to-board
      // path needs it even if the Kanban tab was never opened.
      let projectRow = getProjectRow(pin);
      if (!projectRow) {
        try {
          projectRow = await refreshOne(pin) ?? undefined;
        } catch (err) {
          const detail = explainGhError(err);
          req.log.error({ err, detail }, "pinned project fetch failed");
          return reply.code(502).send({ error: "github project fetch failed", detail });
        }
      }
      if (!projectRow) return reply.code(404).send({ error: "pinned project not found" });
      if (!projectRow.status_field_id) {
        return reply.code(400).send({ error: "project has no Status field" });
      }

      const statusName = req.body.statusName;
      const options = statusOptionsFromRow(projectRow);
      let newOptionId: string | null = null;
      if (statusName !== null) {
        const opt = options.find((o) => o.name === statusName);
        if (!opt) {
          return reply.code(400).send({
            error: `no Status option named "${statusName}" on board #${pin}`,
          });
        }
        newOptionId = opt.id;
      }
      const newLabel = statusName;

      const itemRow = db()
        .prepare(
          "SELECT * FROM project_items WHERE project_number = ? AND content_type = 'Issue' AND content_number = ? AND (content_repo = ? OR content_repo IS NULL)",
        )
        .get(pin, issueNum, getRepoSlug() ?? "") as ItemRow | undefined;

      const issue = db()
        .prepare("SELECT number, title, node_id FROM issues WHERE number = ?")
        .get(issueNum) as { number: number; title: string; node_id: string | null } | undefined;
      if (!issue) return reply.code(404).send({ error: "issue not found" });
      if (!itemRow && !issue.node_id) {
        // Old row mirrored before node_id was synced — a manual sync repairs it.
        return reply.code(404).send({ error: "issue node id not mirrored yet — run a sync, then retry" });
      }

      let itemId = itemRow?.item_id ?? null;
      let addedToBoard = false;
      try {
        await runGithubWrite(req, reply, async (octo) => {
          if (!itemId) {
            itemId = await addProjectV2ItemById(octo, projectRow!.node_id, issue.node_id!);
            addedToBoard = true;
            req.log.info({ issueNum, project: pin, itemId }, "issue added to project board");
          }
          await updateProjectItemStatus(
            octo,
            projectRow!.node_id,
            itemId,
            projectRow!.status_field_id!,
            newOptionId,
          );
        });
        if (reply.sent) return; // 409 link/reauth already sent by the wrapper
      } catch (err) {
        const detail = explainGhError(err);
        req.log.error({ err, detail }, "project status update failed");
        return reply.code(502).send({ error: "github status update failed", detail });
      }

      const now = new Date().toISOString();
      if (addedToBoard) {
        db()
          .prepare(
            `INSERT INTO project_items(item_id, project_number, content_type, content_number, content_title,
               content_repo, status_option_id, status_label, assignees_json, raw_json, last_synced_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(item_id) DO UPDATE SET
               status_option_id=excluded.status_option_id, status_label=excluded.status_label,
               last_synced_at=excluded.last_synced_at`,
          )
          .run(itemId, pin, "Issue", issueNum, issue.title, null, newOptionId, newLabel, "[]", "{}", now);
      } else {
        db()
          .prepare(
            `UPDATE project_items SET status_option_id = ?, status_label = ?, last_synced_at = ?
             WHERE item_id = ?`,
          )
          .run(newOptionId, newLabel, now, itemId);
      }

      return { itemId, statusOptionId: newOptionId, statusLabel: newLabel, addedToBoard };
    },
  );
}
