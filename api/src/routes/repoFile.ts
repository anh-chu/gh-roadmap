import type { FastifyInstance } from "fastify";
import { fetchRepoFile } from "../github.js";

// Read-only view of a single file in the issues repo, for files referenced in an
// issue body. Never writes. GitHub is the source of truth — nothing is cached locally.
export async function repoFileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path?: string; ref?: string } }>(
    "/api/repo-file",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1 },
            ref: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const path = req.query.path?.trim();
      if (!path) return reply.code(400).send({ error: "path required" });
      try {
        return await fetchRepoFile(path, req.query.ref);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) return reply.code(404).send({ error: "file not found" });
        if (status === 422) {
          return reply.code(422).send({ error: "cannot display", detail: (err as Error).message });
        }
        if (err instanceof Error && err.message.includes("github not initialised")) {
          return reply.code(503).send({ error: "github not configured" });
        }
        req.log.error({ err }, "repo file fetch failed");
        return reply.code(502).send({ error: "repo file fetch failed" });
      }
    },
  );
}
