import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { detectPmActions } from "../pmActions.js";
import { getMasterFilter } from "../masterFilter.js";
import {
  aiDisabledReason,
  applyPmActionRanking,
  isAiEnabled,
  rankPmActions,
  type PmActionRank,
} from "../ai.js";
import type { PmActionItem, PmActionsResponse } from "../../../shared/types.js";

interface CacheRow {
  content: string;
  model: string;
  generated_at: string;
  source_hash: string | null;
}

function disabled(reply: FastifyReply, workspaceId: number): FastifyReply {
  return reply.code(503).send({ error: aiDisabledReason(workspaceId) });
}

// Hash the candidate set so the cached AI ranking invalidates when a candidate is added,
// removed, or its evidence changes (e.g. a spec gets fleshed out).
function candidateHash(items: PmActionItem[]): string {
  const sig = items
    .map((i) => `${i.issueNumber}:${i.category}:${i.reason}`)
    .sort()
    .join("|");
  return createHash("sha256").update(sig).digest("hex");
}

function parseRanking(json: string): PmActionRank[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is PmActionRank => {
      if (!x || typeof x !== "object") return false;
      const o = x as Record<string, unknown>;
      return typeof o.issueNumber === "number" && typeof o.action === "string";
    });
  } catch {
    return [];
  }
}

function readCache(workspaceId: number): CacheRow | undefined {
  return db()
    .prepare(
      "SELECT content, model, generated_at, source_hash FROM ai_insights WHERE kind = ?",
    )
    .get(`pm-actions:${workspaceId}`) as CacheRow | undefined;
}

async function generateAndStore(
  candidates: PmActionItem[],
  hash: string,
  workspaceId: number,
): Promise<PmActionsResponse> {
  const { ranking, model } = await rankPmActions(candidates, workspaceId);
  const generatedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO ai_insights(kind, content, model, generated_at, source_hash)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET
         content=excluded.content,
         model=excluded.model,
         generated_at=excluded.generated_at,
         source_hash=excluded.source_hash`,
    )
    .run(`pm-actions:${workspaceId}`, JSON.stringify(ranking), model, generatedAt, hash);
  return {
    items: applyPmActionRanking(candidates, ranking),
    aiRanked: true,
    model,
    generatedAt,
  };
}

export async function pmActionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pm-actions", async (req): Promise<PmActionsResponse> => {
    const candidates = detectPmActions(req.workspaceId, getMasterFilter(req.workspaceId));

    // AI off, or nothing to rank: serve the raw detector output. The card still works.
    if (!isAiEnabled(req.workspaceId) || candidates.length === 0) {
      return { items: candidates, aiRanked: false, model: null, generatedAt: null };
    }

    const hash = candidateHash(candidates);
    const cached = readCache(req.workspaceId);
    if (cached && cached.source_hash === hash) {
      return {
        items: applyPmActionRanking(candidates, parseRanking(cached.content)),
        aiRanked: true,
        model: cached.model,
        generatedAt: cached.generated_at,
      };
    }

    try {
      return await generateAndStore(candidates, hash, req.workspaceId);
    } catch (err) {
      req.log.error({ err }, "pm-actions ranking failed");
      // Degrade to raw detectors rather than 503 — the candidates are real either way.
      return { items: candidates, aiRanked: false, model: null, generatedAt: null };
    }
  });

  app.post("/api/pm-actions/refresh", async (req, reply): Promise<PmActionsResponse | undefined> => {
    if (!isAiEnabled(req.workspaceId)) {
      disabled(reply, req.workspaceId);
      return;
    }
    const candidates = detectPmActions(req.workspaceId, getMasterFilter(req.workspaceId));
    if (candidates.length === 0) {
      return { items: candidates, aiRanked: false, model: null, generatedAt: null };
    }
    try {
      return await generateAndStore(candidates, candidateHash(candidates), req.workspaceId);
    } catch (err) {
      req.log.error({ err }, "pm-actions refresh failed");
      reply.code(503).send({
        error: "pm-actions ranking failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  });
}
