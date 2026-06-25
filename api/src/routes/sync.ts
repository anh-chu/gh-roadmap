import type { FastifyInstance } from "fastify";
import { getKv } from "../db.js";
import { reconcile } from "../sync.js";
import { reconcileInsights } from "../insights.js";
import { isGithubConfigured } from "../github.js";
import type { SyncResult } from "../../../shared/types.js";

// Manual sync — same work the boot/nightly loop does, on demand from the
// header "Synced" pill. Incremental by default; pass full:true for a cache-ignoring re-pull.
// GitHub reconcile + local insights reconcile.
let _syncing = false;

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { full?: boolean } }>("/api/sync", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { full: { type: "boolean" } },
      },
    },
  }, async (req, reply): Promise<SyncResult | undefined> => {
    if (!isGithubConfigured()) {
      reply.code(503).send({ error: "GitHub not configured — set GITHUB_OWNER/REPO + GITHUB_TOKEN or GitHub App credentials" });
      return;
    }
    if (_syncing) {
      reply.code(409).send({ error: "sync already in progress" });
      return;
    }
    _syncing = true;
    try {
      const github = await reconcile({ full: req.body?.full === true });
      const insights = await reconcileInsights();
      return { ok: true, lastSyncAt: getKv("lastSyncAt"), github, insights };
    } catch (err) {
      req.log.error({ err }, "manual sync failed");
      reply.code(502).send({
        error: "sync failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    } finally {
      _syncing = false;
    }
  });
}
