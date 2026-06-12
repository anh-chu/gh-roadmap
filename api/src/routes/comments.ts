import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { createComment, deleteComment, updateComment } from "../github.js";
import { runGithubWrite } from "../githubWriteIdentity.js";
import { deleteCommentRow, upsertComment } from "../sync.js";
import { getMasterFilter, passesMasterFilter } from "../masterFilter.js";

export async function commentsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { num: string } }>("/api/issues/:num/comments", async (req, reply) => {
    const num = Number(req.params.num);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid issue number" });
    // If the issue itself is filtered out of scope, return [] (keeps the drawer UI happy).
    const issue = db().prepare("SELECT labels FROM issues WHERE number = ?").get(num) as
      | { labels: string }
      | undefined;
    if (issue) {
      const labels = JSON.parse(issue.labels) as string[];
      if (!passesMasterFilter(labels, getMasterFilter(req.workspaceId))) return [];
    }
    return db()
      .prepare("SELECT * FROM comments WHERE issue_number = ? ORDER BY created_at ASC")
      .all(num);
  });

  app.post<{ Params: { num: string }; Body: { body: string } }>(
    "/api/issues/:num/comments",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: { body: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const num = Number(req.params.num);
      if (!Number.isFinite(num)) return reply.code(400).send({ error: "invalid issue number" });
      try {
        return await runGithubWrite(req, reply, async (octo) => {
          const c = await createComment(octo, num, req.body.body);
          upsertComment(c);
          return c;
        });
      } catch (err) {
        req.log.error({ err }, "github comment create failed");
        return reply.code(502).send({ error: "github comment create failed" });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { body: string } }>(
    "/api/comments/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: { body: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid comment id" });
      const existing = db().prepare("SELECT issue_number FROM comments WHERE id = ?").get(id) as
        | { issue_number: number }
        | undefined;
      if (!existing) return reply.code(404).send({ error: "comment not found" });
      try {
        return await runGithubWrite(req, reply, async (octo) => {
          const c = await updateComment(octo, id, req.body.body);
          c.issue_number = existing.issue_number;
          upsertComment(c);
          return c;
        });
      } catch (err) {
        req.log.error({ err }, "github comment update failed");
        return reply.code(502).send({ error: "github comment update failed" });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid comment id" });
    try {
      return await runGithubWrite(req, reply, async (octo) => {
        await deleteComment(octo, id);
        deleteCommentRow(id);
        return { ok: true };
      });
    } catch (err) {
      req.log.error({ err }, "github comment delete failed");
      return reply.code(502).send({ error: "github comment delete failed" });
    }
  });
}
