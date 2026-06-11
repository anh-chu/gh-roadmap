import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import middie from "@fastify/middie";
import cors from "@fastify/cors";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { initDb } from "./db.js";
import { initGithub, getRateLimitStatus } from "./github.js";
import { reconcile, runDailySnapshot } from "./sync.js";
import { backfillHealthSnapshots } from "./healthBackfill.js";
import { issuesRoutes } from "./routes/issues.js";
import { commentsRoutes } from "./routes/comments.js";
import { webhookRoutes } from "./routes/webhook.js";
import { metaRoutes } from "./routes/meta.js";
import { configRoutes } from "./routes/config.js";
import { projectsRoutes } from "./routes/projects.js";
import { pullsRoutes } from "./routes/pulls.js";
import { flowRoutes } from "./routes/flow.js";
import { healthRoutes } from "./routes/health.js";
import { briefRoutes } from "./routes/brief.js";
import { aiRoutes } from "./routes/ai.js";
import { pmActionsRoutes } from "./routes/pmActions.js";
import { logResolvedModels } from "./ai.js";
import { insightsRoutes } from "./routes/insights.js";
import { accountsRoutes } from "./routes/accounts.js";
import { syncRoutes } from "./routes/sync.js";
import { openapiRoutes } from "./routes/openapi.js";
import { repoFileRoutes } from "./routes/repoFile.js";
import { dataRoutes } from "./routes/data.js";
import { reconcileInsights } from "./insights.js";
import { authRoutes } from "./routes/auth.js";
import { authEnabled, userFromRequest } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const PORT_TRIES = 10;
const PORT_FILE = resolve(__dirname, "..", "..", "..", ".runtime-port");
const DB_PATH = process.env.DB_PATH ?? "./data/roadmap.db";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

const NIGHTLY_MS = 24 * 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    app.log.warn("GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO not set — sync disabled");
  }

  initDb(DB_PATH);
  if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
    initGithub(GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO);
  }
  logResolvedModels((msg, meta) => app.log.info(meta ?? {}, msg));

  await app.register(cors, { origin: true });
  await app.register(fastifyCookie);

  if (authEnabled()) {
    app.log.info("Google OAuth login enabled — app requires sign-in");
  } else {
    app.log.warn("auth disabled (GOOGLE_CLIENT_ID/SECRET unset) — single-user localhost mode");
  }

  // Resolve the user on every request and gate /api/* behind a session when auth is on.
  // Public paths: the auth endpoints themselves (login/callback/me/logout). Everything else
  // under /api requires a valid session. /webhook is HMAC-verified separately and stays open.
  app.addHook("onRequest", async (req, reply) => {
    const user = userFromRequest(req);
    if (user) req.user = user;
    if (!authEnabled()) return;

    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return; // SPA + assets load so the login screen can render
    if (url.startsWith("/api/auth/")) return; // login flow must be reachable while logged out
    if (!user) return reply.code(401).send({ error: "authentication required" });
  });

  // API routes mount first so anything under /api or /webhook is handled by Fastify;
  // the SPA (vite middleware in dev, static dist in prod) catches everything else.
  await app.register(authRoutes);
  await app.register(issuesRoutes);
  await app.register(commentsRoutes);
  await app.register(metaRoutes);
  await app.register(configRoutes);
  await app.register(projectsRoutes);
  await app.register(pullsRoutes);
  await app.register(flowRoutes);
  await app.register(healthRoutes);
  await app.register(briefRoutes);
  await app.register(aiRoutes);
  await app.register(pmActionsRoutes);
  await app.register(insightsRoutes);
  await app.register(accountsRoutes);
  await app.register(syncRoutes);
  await app.register(repoFileRoutes);
  await app.register(dataRoutes);
  await app.register(openapiRoutes);
  await app.register(webhookRoutes, { secret: GITHUB_WEBHOOK_SECRET });

  const isBuilt = __dirname.includes(`${"/"}dist${"/"}`);
  if (isBuilt) {
    const webDist =
      process.env.WEB_DIST ??
      resolve(__dirname, "..", "..", "..", "..", "web", "dist");
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: false,
    });
  } else {
    // Dev: mount vite as middleware on this same port. HMR, source maps, single URL.
    await app.register(middie);
    const { createServer: createViteServer } = await import("vite");
    // __dirname is server/api/src in dev (tsx) — two `..` reaches server/, then web/.
    const webRoot = resolve(__dirname, "..", "..", "web");
    const vite = await createViteServer({
      configFile: resolve(webRoot, "vite.config.ts"),
      root: webRoot,
      server: { middlewareMode: true },
      appType: "spa",
    });
    // Skip vite for API/webhook paths so Fastify routes handle them; otherwise vite
    // serves the SPA HTML for every URL including /api/issues.
    app.use((req, _res, next) => {
      const url = req.url ?? "";
      if (url.startsWith("/api") || url.startsWith("/webhook")) return next();
      vite.middlewares(req, _res, next);
    });
    app.log.info("vite dev middleware mounted — frontend and API share this port");
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error({ err }, "unhandled route error");
    reply.code(err.statusCode ?? 500).send({ error: err.message ?? "internal error" });
  });

  const chosenPort = await listenWithRetry(app, PORT, PORT_TRIES);
  writePortFile(chosenPort, app);

  if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
    reconcile()
      .then((r) => {
        app.log.info({ ...r }, "boot reconcile done");
        const rate = getRateLimitStatus();
        if (rate.limit > 0 && rate.remaining / rate.limit < 0.1) {
          app.log.warn({ rate }, "GitHub rate limit below 10%");
        }
        // Backfill must run AFTER reconcile (needs DB populated) and BEFORE the
        // initial daily snapshot (today is owned by runDailySnapshot, not backfill).
        try {
          const b = backfillHealthSnapshots(30);
          app.log.info({ ...b }, "boot health backfill done");
        } catch (err) {
          app.log.error({ err }, "boot health backfill failed");
        }
        try {
          const s = runDailySnapshot();
          app.log.info({ ...s }, "boot health snapshot done");
        } catch (err) {
          app.log.error({ err }, "boot health snapshot failed");
        }
        // Insights mirror — GitHub-API-sourced, runs after the issue reconcile.
        reconcileInsights()
          .then((r) => app.log.info({ ...r }, "boot insights reconcile done"))
          .catch((err) => app.log.error({ err }, "boot insights reconcile failed"));
      })
      .catch((err) => app.log.error({ err }, "boot reconcile failed"));

    setInterval(() => {
      reconcile()
        .then((r) => app.log.info({ ...r }, "periodic reconcile done"))
        .catch((err) => app.log.error({ err }, "periodic reconcile failed"));
      reconcileInsights()
        .then((r) => app.log.info({ ...r }, "periodic insights reconcile done"))
        .catch((err) => app.log.error({ err }, "periodic insights reconcile failed"));
    }, RECONCILE_INTERVAL_MS);

    // Health snapshot loop — every 24h. Upserts keyed by UTC date so the most recent
    // "today" reading is always reflected even if the server reboots mid-day.
    setInterval(() => {
      try {
        const s = runDailySnapshot();
        app.log.info({ ...s }, "daily health snapshot done");
      } catch (err) {
        app.log.error({ err }, "daily health snapshot failed");
      }
    }, NIGHTLY_MS);
  } else {
    // Sync disabled — still backfill against whatever's in the DB so the sparkline
    // works in offline / no-token environments. Returns {0,0} on an empty DB.
    try {
      const b = backfillHealthSnapshots(30);
      app.log.info({ ...b }, "boot health backfill done (sync disabled)");
    } catch (err) {
      app.log.error({ err }, "boot health backfill failed (sync disabled)");
    }
  }
}

async function listenWithRetry(
  app: FastifyInstance,
  start: number,
  tries: number,
): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    try {
      await app.listen({ port, host: "0.0.0.0" });
      if (i > 0) app.log.warn(`port ${start} busy — bound to ${port} instead`);
      return port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
      app.log.info(`port ${port} in use, trying ${port + 1}`);
    }
  }
  throw new Error(`no free port in range ${start}-${start + tries - 1}`);
}

function writePortFile(port: number, app: FastifyInstance): void {
  try {
    writeFileSync(PORT_FILE, String(port), "utf8");
  } catch (err) {
    app.log.warn({ err }, "could not write .runtime-port");
    return;
  }
  const cleanup = (): void => {
    try { unlinkSync(PORT_FILE); } catch { /* already gone */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
