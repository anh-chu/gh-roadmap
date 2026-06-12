import type { FastifyInstance } from "fastify";
import type { Workspace } from "../../../shared/types.js";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { getWorkspace, listWorkspaces, setActiveWorkspaceCookie } from "../workspace.js";

const SLUG_RE = /^[a-z0-9-]+$/;

function workspaceRow(id: number): Workspace | undefined {
  return db()
    .prepare("SELECT id, slug, name, archived_at AS archivedAt FROM workspace_config WHERE id = ?")
    .get(id) as Workspace | undefined;
}

function liveCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM workspace_config WHERE archived_at IS NULL").get() as { n: number };
  return row.n;
}

// List + switch are open to any signed-in user; create / rename / archive are admin-only.
// No delete — lifecycle is archive-only (nothing cascades; unarchive fully rehydrates).
export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces", async (req): Promise<{ workspaces: Workspace[]; activeId: number }> => {
    return { workspaces: listWorkspaces(), activeId: req.workspaceId };
  });

  app.post<{ Body: { id: number } }>(
    "/api/workspaces/active",
    {
      schema: {
        body: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "integer" } },
        },
      },
    },
    async (req, reply) => {
      const ws = getWorkspace(req.body.id);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });
      setActiveWorkspaceCookie(req, reply, ws.id);
      return ws;
    },
  );

  // Create a pod. New pods get the column defaults plus a master filter of
  // include: ["pod:<slug>"] — the pod-label convention the rest of the app assumes.
  app.post<{ Body: { slug: string; name: string } }>(
    "/api/workspaces",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          required: ["slug", "name"],
          additionalProperties: false,
          properties: { slug: { type: "string" }, name: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const slug = req.body.slug.trim();
      const name = req.body.name.trim();
      if (!SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: "slug must be lowercase letters, digits, and hyphens" });
      }
      if (!name) return reply.code(400).send({ error: "name is required" });
      const exists = db().prepare("SELECT id FROM workspace_config WHERE slug = ?").get(slug);
      if (exists) return reply.code(409).send({ error: `a pod with slug '${slug}' already exists` });
      const res = db()
        .prepare(
          `INSERT INTO workspace_config (slug, name, master_filter_include, updated_at)
           VALUES (?, ?, ?, datetime('now'))`,
        )
        .run(slug, name, JSON.stringify([`pod:${slug}`]));
      return reply.code(201).send(workspaceRow(Number(res.lastInsertRowid)));
    },
  );

  // Rename and/or archive/unarchive. Archiving the last live pod is rejected —
  // active-workspace resolution assumes there is always ≥1 non-archived pod.
  app.patch<{ Params: { id: string }; Body: { name?: string; archived?: boolean } }>(
    "/api/workspaces/:id",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, archived: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const ws = workspaceRow(id);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });

      if (req.body.name !== undefined) {
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: "name must be non-empty" });
        db().prepare("UPDATE workspace_config SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
      }
      if (req.body.archived !== undefined) {
        if (req.body.archived && ws.archivedAt === null && liveCount() <= 1) {
          return reply.code(409).send({ error: "cannot archive the last live pod" });
        }
        db()
          .prepare(
            req.body.archived
              ? "UPDATE workspace_config SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL"
              : "UPDATE workspace_config SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?",
          )
          .run(id);
      }
      return workspaceRow(id);
    },
  );
}
