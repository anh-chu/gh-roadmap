import type { FastifyInstance } from "fastify";
import { handleWebhook, verifySignature } from "../sync.js";

export async function webhookRoutes(app: FastifyInstance, opts: { secret: string }): Promise<void> {
  // We need the raw body to verify GitHub's HMAC signature. Fastify parses JSON
  // by default, so we register a content-type parser that keeps the buffer.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        const json = JSON.parse((body as Buffer).toString("utf8"));
        (json as { __raw?: Buffer }).__raw = body as Buffer;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post("/webhook/github", async (req, reply) => {
    const event = req.headers["x-github-event"];
    const sig = req.headers["x-hub-signature-256"];
    const body = req.body as { __raw?: Buffer } | undefined;
    if (!body?.__raw) return reply.code(400).send({ error: "missing body" });
    if (typeof event !== "string") return reply.code(400).send({ error: "missing event" });

    if (!verifySignature(opts.secret, body.__raw, typeof sig === "string" ? sig : undefined)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    try {
      handleWebhook(event, body);
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, "webhook handler failed");
      return reply.code(500).send({ error: "handler failed" });
    }
  });
}
