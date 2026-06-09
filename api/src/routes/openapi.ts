import type { FastifyInstance, FastifyRequest } from "fastify";
import { dump as yamlDump } from "js-yaml";
import { buildOpenApiDoc } from "../openapi.js";

function baseUrl(req: FastifyRequest): string {
  const proto = req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() || "http";
  const host = req.headers.host || `localhost:${process.env.PORT ?? 3000}`;
  return `${proto}://${host}`;
}

export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/openapi.json", async (req, reply) => {
    return reply.type("application/json").send(buildOpenApiDoc(baseUrl(req)));
  });

  app.get("/api/openapi.yaml", async (req, reply) => {
    return reply
      .type("application/yaml; charset=utf-8")
      .send(yamlDump(buildOpenApiDoc(baseUrl(req)), { noRefs: true, lineWidth: 120 }));
  });

  app.get("/api/openapi", async (req, reply) => {
    return reply.redirect(`${baseUrl(req)}/api/openapi.json`, 302);
  });
}
