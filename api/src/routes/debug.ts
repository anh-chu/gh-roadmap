import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getKv } from "../db.js";
import { getRateLimitStatus, probeGitHub } from "../github.js";
import { recentLogs, subscribe } from "../logBuffer.js";
import { getReconcileDiag } from "../sync.js";

type DebugQuery = {
  token?: string;
  n?: string;
};

const DEBUG_TOKEN = process.env.DEBUG_TOKEN ?? "";

function gate(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!DEBUG_TOKEN) return true;
  const token = (req.query as DebugQuery | undefined)?.token;
  if (token === DEBUG_TOKEN) return true;
  reply.code(401).send({ error: "debug token required" });
  return false;
}

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/debug/logs", async (req, reply) => {
    if (!gate(req, reply)) return;
    const raw = (req.query as DebugQuery | undefined)?.n;
    const parsed = Number.parseInt(raw ?? "500", 10);
    const n = Number.isFinite(parsed) ? Math.min(2000, Math.max(1, parsed)) : 500;
    return reply.type("text/plain; charset=utf-8").send(recentLogs(n).join(""));
  });

  app.get("/api/debug/logs/stream", async (req, reply) => {
    if (!gate(req, reply)) return;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    for (const line of recentLogs(200)) {
      reply.raw.write(`data: ${line.replace(/\n$/, "")}\n\n`);
    }
    const unsub = subscribe((line) => {
      try {
        reply.raw.write(`data: ${line.replace(/\n$/, "")}\n\n`);
      } catch {
      }
    });
    const hb = setInterval(() => {
      try {
        reply.raw.write(": hb\n\n");
      } catch {
      }
    }, 15_000);
    req.raw.on("close", () => {
      clearInterval(hb);
      unsub();
      try {
        reply.raw.end();
      } catch {
      }
    });
    return reply;
  });

  app.get("/api/debug/sync", async (req, reply) => {
    if (!gate(req, reply)) return;
    return reply.send({
      now: new Date().toISOString(),
      env: {
        githubAuthMode: process.env.GITHUB_APP_ID ? "app" : process.env.GITHUB_TOKEN ? "pat" : "none",
        owner: !!process.env.GITHUB_OWNER,
        repo: !!process.env.GITHUB_REPO,
        projectNumber: !!process.env.GITHUB_PROJECT_NUMBER,
        proxy: {
          HTTPS_PROXY: !!process.env.HTTPS_PROXY,
          HTTP_PROXY: !!process.env.HTTP_PROXY,
          NO_PROXY: !!process.env.NO_PROXY,
        },
      },
      lastSyncAt: getKv("lastSyncAt"),
      reconcile: getReconcileDiag(),
      rateLimit: getRateLimitStatus(),
      probe: await probeGitHub(),
    });
  });
}
