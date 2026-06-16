import type { FastifyInstance } from "fastify";
import { q } from "../db.js";
import { computeAtRisk, computeConfidence, computeScheduleHealth } from "../health.js";
import { backfillHealthSnapshots } from "../healthBackfill.js";
import type {
  HealthHistorical,
  HealthLive,
  HealthSnapshotSummary,
  RiskItem,
} from "../../../shared/types.js";

interface HistoryRow {
  snapshot_date: string;
  confidence: number | null;
  on_time: number | null;
  sample_size: number;
  at_risk_json: string;
}

interface SnapshotRow extends HistoryRow {
  computed_at: string;
}

function parseRisk(json: string): RiskItem[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is RiskItem => {
      if (!x || typeof x !== "object") return false;
      const o = x as Record<string, unknown>;
      return (
        typeof o.issueNumber === "number" &&
        typeof o.title === "string" &&
        typeof o.reason === "string" &&
        (o.severity === 1 || o.severity === 2 || o.severity === 3)
      );
    });
  } catch {
    return [];
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async (req): Promise<HealthLive> => {
    const workspaceId = req.workspaceId;
    const { confidence, sampleSize, noSignal } = computeConfidence(workspaceId);
    const atRisk = computeAtRisk(workspaceId);
    const schedule = computeScheduleHealth(workspaceId);
    return { asOf: "now", confidence, sampleSize, noSignal, atRisk, schedule };
  });

  app.get<{ Querystring: { days?: string } }>(
    "/api/health/history",
    async (req): Promise<HealthSnapshotSummary[]> => {
      const raw = Number(req.query.days ?? 30);
      const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 365) : 30;
      const rows = q(
          `SELECT snapshot_date, confidence, on_time, sample_size, at_risk_json
           FROM health_snapshots
           WHERE workspace_id = ?
           ORDER BY snapshot_date DESC
           LIMIT ?`,
        )
        .all(req.workspaceId, days) as HistoryRow[];
      const out: HealthSnapshotSummary[] = rows.map((r) => ({
        date: r.snapshot_date,
        confidence: r.confidence,
        onTime: r.on_time,
        sampleSize: r.sample_size,
        atRiskCount: parseRisk(r.at_risk_json).length,
      }));
      out.sort((a, b) => a.date.localeCompare(b.date));
      return out;
    },
  );

  app.post<{ Querystring: { days?: string } }>(
    "/api/health/backfill",
    async (req): Promise<{ written: number; skipped: number }> => {
      const raw = Number(req.query.days ?? 30);
      const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 90) : 30;
      return backfillHealthSnapshots(req.workspaceId, days);
    },
  );

  app.get<{ Params: { date: string } }>(
    "/api/health/snapshot/:date",
    async (req, reply): Promise<HealthHistorical | undefined> => {
      const date = req.params.date;
      if (!DATE_RE.test(date)) {
        return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
      }
      const row = q(
          `SELECT snapshot_date, confidence, sample_size, at_risk_json, computed_at
           FROM health_snapshots WHERE workspace_id = ? AND snapshot_date = ?`,
        )
        .get(req.workspaceId, date) as SnapshotRow | undefined;
      if (!row) {
        return reply.code(404).send({ error: "no snapshot for that date" });
      }
      // Schedule health is recomputed as-of the snapshot date (it's cheap and the
      // health_snapshots table predates it). at-risk stays the stored snapshot.
      return {
        asOf: row.snapshot_date,
        confidence: row.confidence,
        sampleSize: row.sample_size,
        atRisk: parseRisk(row.at_risk_json),
        schedule: computeScheduleHealth(req.workspaceId, undefined, row.snapshot_date),
      };
    },
  );
}
