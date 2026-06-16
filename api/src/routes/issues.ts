import type { FastifyInstance } from "fastify";
import { q } from "../db.js";
import { createIssue, getRepoSlug, updateIssue, type IssueCreate, type IssuePatch } from "../github.js";
import { runGithubWrite } from "../githubWriteIdentity.js";
import { upsertIssue } from "../sync.js";
import { getMasterFilter, masterFilterSql } from "../masterFilter.js";
import { getWorkspace } from "../workspace.js";
import { projectFilter } from "./projects.js";

// Join the env-pinned project's items so each issue carries its board Status.
// pin is a validated finite number (projectFilter), so inlining is safe. When no
// project is pinned, select NULLs so the response shape stays constant.
function pinnedProjectJoin(): { select: string; join: string } {
  const pin = projectFilter();
  if (pin === null) {
    return { select: "NULL AS project_status, NULL AS project_item_id", join: "" };
  }
  // content_repo guards against same-numbered issues from other repos on the
  // board; NULL keeps legacy rows mirrored before content_repo was stored.
  const slug = (getRepoSlug() ?? "").replace(/'/g, "''");
  return {
    select: "p.status_label AS project_status, p.item_id AS project_item_id",
    join: `LEFT JOIN project_items p ON p.content_number = i.number AND p.content_type = 'Issue' AND p.project_number = ${pin} AND (p.content_repo = '${slug}' OR p.content_repo IS NULL)`,
  };
}

type IssueJoinedRow = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  assignee: string | null;
  milestone: string | null;
  milestone_due: string | null;
  labels: string;
  updated_at: string;
  planned_month: string | null;
  planned_week: string | null;
  roadmap_notes: string | null;
  position: number | null;
  is_todo: number | null;
  project_status: string | null;
  project_item_id: string | null;
};

function rowToJson(r: IssueJoinedRow) {
  return {
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    assignee: r.assignee,
    milestone: r.milestone,
    milestoneDue: r.milestone_due,
    labels: JSON.parse(r.labels) as string[],
    updatedAt: r.updated_at,
    plannedMonth: r.planned_month,
    plannedWeek: r.planned_week,
    roadmapNotes: r.roadmap_notes,
    position: r.position,
    isTodo: !!r.is_todo,
    projectStatus: r.project_status,
    projectItemId: r.project_item_id,
  };
}

export async function issuesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IssueCreate }>(
    "/api/issues",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            body: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            assignee: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      const title = req.body.title?.trim();
      if (!title) return reply.code(400).send({ error: "title required" });
      // New issues belong to the active pod: auto-apply its pod:<slug> label so the
      // issue lands inside the pod's master filter (owner decision, slug-derived).
      const slug = getWorkspace(req.workspaceId)?.slug;
      const labels = req.body.labels ?? [];
      if (slug && !labels.includes(`pod:${slug}`)) labels.push(`pod:${slug}`);
      try {
        return await runGithubWrite(req, reply, async (octo) => {
          const created = await createIssue(octo, { ...req.body, title, labels });
          upsertIssue(created);
          const pj = pinnedProjectJoin();
          const row = q(
              `SELECT i.*, m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo, ${pj.select}
               FROM issues i LEFT JOIN roadmap_meta m ON m.issue_number = i.number AND m.workspace_id = ?
               ${pj.join}
               WHERE i.number = ?`,
            )
            .get(req.workspaceId, created.number) as IssueJoinedRow;
          return rowToJson(row);
        });
      } catch (err) {
        req.log.error({ err }, "github issue create failed");
        return reply.code(502).send({ error: "github issue create failed" });
      }
    },
  );

  app.get("/api/issues", async (req) => {
    const mf = masterFilterSql(getMasterFilter(req.workspaceId));
    const where = mf ? `WHERE ${mf.sql}` : "";
    const params = mf ? mf.params : [];
    const pj = pinnedProjectJoin();
    const rows = q(
        `SELECT i.number, i.title, i.body, i.state, i.assignee, i.milestone, i.milestone_due, i.labels, i.updated_at,
                m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo, ${pj.select}
         FROM issues i
         LEFT JOIN roadmap_meta m ON m.issue_number = i.number AND m.workspace_id = ?
         ${pj.join}
         ${where}
         ORDER BY i.updated_at DESC`,
      )
      .all(req.workspaceId, ...params) as IssueJoinedRow[];
    return rows.map(rowToJson);
  });

  app.patch<{ Params: { num: string }; Body: IssuePatch & { baseBody?: string | null } }>(
    "/api/issues/:num",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] },
            labels: { type: "array", items: { type: "string" } },
            assignee: { type: ["string", "null"] },
            milestone: { type: ["string", "null"] },
            baseBody: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid issue number" });

      // Optimistic concurrency on the body field: if the caller is editing the body
      // and tells us the version it started from, reject when the stored body has
      // since diverged (another teammate saved first). Content-based, not timestamp-based,
      // so routine sync churn (comments, label/state changes) never triggers a false 409.
      const { baseBody, ...patch } = req.body;
      if (patch.body !== undefined && baseBody !== undefined) {
        const cur = q("SELECT body FROM issues WHERE number = ?").get(num) as
          | { body: string | null }
          | undefined;
        if (cur && (cur.body ?? "") !== (baseBody ?? "")) {
          return reply.code(409).send({
            error: "conflict",
            detail: "This issue's description was changed by someone else. Reload to see the latest before editing.",
          });
        }
      }
      try {
        return await runGithubWrite(req, reply, async (octo) => {
          const updated = await updateIssue(octo, num, patch);
          upsertIssue(updated);
          const pj = pinnedProjectJoin();
          const row = q(
              `SELECT i.*, m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo, ${pj.select}
               FROM issues i LEFT JOIN roadmap_meta m ON m.issue_number = i.number AND m.workspace_id = ?
               ${pj.join}
               WHERE i.number = ?`,
            )
            .get(req.workspaceId, num) as IssueJoinedRow;
          return rowToJson(row);
        });
      } catch (err) {
        req.log.error({ err }, "github update failed");
        return reply.code(502).send({ error: "github update failed" });
      }
    },
  );

  app.patch<{
    Params: { num: string };
    Body: { plannedMonth?: string | null; plannedWeek?: string | null; roadmapNotes?: string | null; position?: number | null; isTodo?: boolean };
  }>(
    "/api/issues/:num/roadmap",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            plannedMonth: { type: ["string", "null"] },
            plannedWeek: { type: ["string", "null"] },
            roadmapNotes: { type: ["string", "null"] },
            position: { type: ["number", "null"] },
            isTodo: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid issue number" });

      const exists = q("SELECT 1 FROM issues WHERE number = ?").get(num);
      if (!exists) return reply.code(404).send({ error: "issue not found" });

      const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
      if (req.body.plannedWeek !== undefined && req.body.plannedWeek !== null && !WEEK_RE.test(req.body.plannedWeek)) {
        return reply.code(400).send({ error: "plannedWeek must match YYYY-Www (ISO week)" });
      }

      const workspaceId = req.workspaceId;
      const current = q("SELECT * FROM roadmap_meta WHERE workspace_id = ? AND issue_number = ?").get(workspaceId, num) as
        | { planned_month: string | null; planned_week: string | null; roadmap_notes: string | null; position: number | null; is_todo: number | null }
        | undefined;

      // Use `in` check to distinguish "absent" from "explicitly null" so callers can clear fields.
      let planned_month = "plannedMonth" in req.body ? req.body.plannedMonth ?? null : current?.planned_month ?? null;
      let planned_week = "plannedWeek" in req.body ? req.body.plannedWeek ?? null : current?.planned_week ?? null;
      let is_todo = "isTodo" in req.body ? (req.body.isTodo ? 1 : 0) : (current?.is_todo ?? 0);

      // Mutual exclusion: TODO and a time placement cannot coexist.
      // If caller sets isTodo=true, force-clear planned_month/planned_week defensively.
      if ("isTodo" in req.body && req.body.isTodo === true) {
        planned_month = null;
        planned_week = null;
      }
      // If caller sets a non-null plannedMonth or plannedWeek, force-clear is_todo.
      if (
        ("plannedMonth" in req.body && req.body.plannedMonth !== null && req.body.plannedMonth !== undefined) ||
        ("plannedWeek" in req.body && req.body.plannedWeek !== null && req.body.plannedWeek !== undefined)
      ) {
        is_todo = 0;
      }

      const merged = {
        planned_month,
        planned_week,
        roadmap_notes: "roadmapNotes" in req.body ? req.body.roadmapNotes ?? null : current?.roadmap_notes ?? null,
        position: "position" in req.body ? req.body.position ?? null : current?.position ?? null,
        is_todo,
      };

      q(
          `INSERT INTO roadmap_meta(workspace_id,issue_number,planned_month,planned_week,roadmap_notes,position,is_todo,app_updated_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(workspace_id,issue_number) DO UPDATE SET
             planned_month=excluded.planned_month, planned_week=excluded.planned_week,
             roadmap_notes=excluded.roadmap_notes, position=excluded.position, is_todo=excluded.is_todo,
             app_updated_at=excluded.app_updated_at`,
        )
        .run(workspaceId, num, merged.planned_month, merged.planned_week, merged.roadmap_notes, merged.position, merged.is_todo, new Date().toISOString());

      return { number: num, ...merged, isTodo: !!merged.is_todo };
    },
  );
}
