import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { createIssue, updateIssue, type IssueCreate, type IssuePatch } from "../github.js";
import { upsertIssue } from "../sync.js";
import { getMasterFilter, masterFilterSql } from "../masterFilter.js";

type IssueJoinedRow = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  assignee: string | null;
  milestone: string | null;
  labels: string;
  updated_at: string;
  planned_month: string | null;
  planned_week: string | null;
  roadmap_notes: string | null;
  position: number | null;
  is_todo: number | null;
};

function rowToJson(r: IssueJoinedRow) {
  return {
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    assignee: r.assignee,
    milestone: r.milestone,
    labels: JSON.parse(r.labels) as string[],
    updatedAt: r.updated_at,
    plannedMonth: r.planned_month,
    plannedWeek: r.planned_week,
    roadmapNotes: r.roadmap_notes,
    position: r.position,
    isTodo: !!r.is_todo,
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
      try {
        const created = await createIssue({ ...req.body, title });
        upsertIssue(created);
        const row = db()
          .prepare(
            `SELECT i.*, m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo
             FROM issues i LEFT JOIN roadmap_meta m ON m.issue_number = i.number
             WHERE i.number = ?`,
          )
          .get(created.number) as IssueJoinedRow;
        return rowToJson(row);
      } catch (err) {
        req.log.error({ err }, "github issue create failed");
        return reply.code(502).send({ error: "github issue create failed" });
      }
    },
  );

  app.get("/api/issues", async () => {
    const mf = masterFilterSql(getMasterFilter());
    const where = mf ? `WHERE ${mf.sql}` : "";
    const params = mf ? mf.params : [];
    const rows = db()
      .prepare(
        `SELECT i.number, i.title, i.body, i.state, i.assignee, i.milestone, i.labels, i.updated_at,
                m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo
         FROM issues i
         LEFT JOIN roadmap_meta m ON m.issue_number = i.number
         ${where}
         ORDER BY i.updated_at DESC`,
      )
      .all(...params) as IssueJoinedRow[];
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
        const cur = db().prepare("SELECT body FROM issues WHERE number = ?").get(num) as
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
        const updated = await updateIssue(num, patch);
        upsertIssue(updated);
        const row = db()
          .prepare(
            `SELECT i.*, m.planned_month, m.planned_week, m.roadmap_notes, m.position, m.is_todo
             FROM issues i LEFT JOIN roadmap_meta m ON m.issue_number = i.number
             WHERE i.number = ?`,
          )
          .get(num) as IssueJoinedRow;
        return rowToJson(row);
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

      const exists = db().prepare("SELECT 1 FROM issues WHERE number = ?").get(num);
      if (!exists) return reply.code(404).send({ error: "issue not found" });

      const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
      if (req.body.plannedWeek !== undefined && req.body.plannedWeek !== null && !WEEK_RE.test(req.body.plannedWeek)) {
        return reply.code(400).send({ error: "plannedWeek must match YYYY-Www (ISO week)" });
      }

      const current = db().prepare("SELECT * FROM roadmap_meta WHERE issue_number = ?").get(num) as
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

      db()
        .prepare(
          `INSERT INTO roadmap_meta(issue_number,planned_month,planned_week,roadmap_notes,position,is_todo,app_updated_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(issue_number) DO UPDATE SET
             planned_month=excluded.planned_month, planned_week=excluded.planned_week,
             roadmap_notes=excluded.roadmap_notes, position=excluded.position, is_todo=excluded.is_todo,
             app_updated_at=excluded.app_updated_at`,
        )
        .run(num, merged.planned_month, merged.planned_week, merged.roadmap_notes, merged.position, merged.is_todo, new Date().toISOString());

      return { number: num, ...merged, isTodo: !!merged.is_todo };
    },
  );
}
