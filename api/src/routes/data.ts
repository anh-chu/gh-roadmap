import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireAdmin } from "../auth.js";

// Full-database export/import. Single-user local tool: this is the "back up / move my
// whole workspace" affordance. Export dumps every user table (including the GitHub mirror,
// AI caches, and the app-only planning layer that can't be re-derived). Import is a
// replace-all restore: each table in the file is wiped and reloaded in one transaction.
//
// Column-agnostic on purpose — tables and columns are read from the live schema, so an
// export taken on an older/newer schema still round-trips (unknown columns are dropped,
// missing columns fall back to their defaults).

const EXPORT_VERSION = 1;

// 64 MB — a full mirror (issue/PR raw JSON blobs) easily exceeds Fastify's 1 MB default.
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

function userTables(): string[] {
  const rows = db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableColumns(table: string): string[] {
  return (db().prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}

// Legacy (pre-multi-pod) backup compatibility: older exports have a singleton
// workspace_config row (no slug/name) and roadmap_meta / health_snapshots rows keyed
// without workspace_id. Inject the workspace-1 ('mht') defaults the schema migration
// would have applied, so old backups still round-trip — the planning layer in
// roadmap_meta cannot be re-derived from GitHub.
function normalizeLegacyRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "workspace_config" && row.slug === undefined) {
    return { ...row, slug: "mht", name: "MHT" };
  }
  if ((table === "roadmap_meta" || table === "health_snapshots") && row.workspace_id === undefined) {
    return { ...row, workspace_id: 1 };
  }
  return row;
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/export", { preHandler: requireAdmin }, async (_req, reply) => {
    const tables: Record<string, unknown[]> = {};
    for (const t of userTables()) {
      tables[t] = db().prepare(`SELECT * FROM "${t}"`).all();
    }
    const exportedAt = new Date().toISOString();
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="roadmap-export-${exportedAt.slice(0, 10)}.json"`);
    return { version: EXPORT_VERSION, exportedAt, tables };
  });

  app.post<{ Body: { version?: number; tables?: Record<string, unknown[]> } }>(
    "/api/import",
    {
      preHandler: requireAdmin,
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["tables"],
          additionalProperties: true,
          properties: {
            version: { type: "number" },
            tables: { type: "object" },
          },
        },
      },
    },
    async (req, reply) => {
      const { tables } = req.body;
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        return reply.code(400).send({ error: "tables must be an object keyed by table name" });
      }

      const existing = new Set(userTables());
      const conn = db();
      const imported: Record<string, number> = {};
      const skipped: string[] = [];

      const apply = conn.transaction(() => {
        for (const [table, rows] of Object.entries(tables)) {
          if (!existing.has(table)) {
            skipped.push(table);
            continue;
          }
          if (!Array.isArray(rows)) {
            skipped.push(table);
            continue;
          }
          conn.prepare(`DELETE FROM "${table}"`).run();
          const tableCols = new Set(tableColumns(table));
          let n = 0;
          for (const raw of rows) {
            if (!raw || typeof raw !== "object") continue;
            const row = normalizeLegacyRow(table, raw as Record<string, unknown>);
            const cols = Object.keys(row).filter((c) => tableCols.has(c));
            if (cols.length === 0) continue;
            const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
              .map(() => "?")
              .join(", ")})`;
            const values = cols.map((c) => {
              const v = (row as Record<string, unknown>)[c];
              // better-sqlite3 only binds null / number / string / bigint / Buffer.
              if (typeof v === "boolean") return v ? 1 : 0;
              if (v === undefined) return null;
              return v;
            });
            conn.prepare(sql).run(...values);
            n++;
          }
          imported[table] = n;
        }
      });

      try {
        apply();
      } catch (e) {
        return reply
          .code(400)
          .send({ error: "import failed — no changes applied", detail: e instanceof Error ? e.message : String(e) });
      }

      return { imported, skipped };
    },
  );
}
