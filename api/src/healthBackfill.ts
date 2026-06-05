import { db } from "./db.js";
import { computeAtRisk, computeConfidence, computeScheduleHealth, utcDateKey } from "./health.js";
import { getMasterFilter } from "./masterFilter.js";

interface ExistingRow {
  snapshot_date: string;
  on_time: number | null;
}

// Replay daily health snapshots for the last N days using the current DB state.
// Idempotent — only writes rows that don't yet exist for a given snapshot_date.
//
// approximate: signals that have no per-day history (CI check rollups, current
// "stalled X days ago" derivation, predictive detectors that read live state)
// are skipped or approximated when replaying. Historic confidence numbers are
// therefore approximate — useful as a directional sparkline, not as a precise
// record. See loadJoins / computeAtRisk in health.ts for the specific clamps.
//
// Configurable thresholds (e.g. todo_stale_days) reflect today's setting for
// all replayed days — we don't track historic config — and that's acceptable.
export function backfillHealthSnapshots(days: number = 30): {
  written: number;
  skipped: number;
} {
  const safeDays = Math.max(1, Math.min(Math.floor(days), 365));
  const todayKey = utcDateKey();

  const existing = new Map(
    (
      db()
        .prepare(`SELECT snapshot_date, on_time FROM health_snapshots`)
        .all() as ExistingRow[]
    ).map((r) => [r.snapshot_date, r.on_time] as const),
  );

  const mf = getMasterFilter();
  let written = 0;
  let skipped = 0;

  const insert = db().prepare(
    `INSERT INTO health_snapshots(snapshot_date, confidence, sample_size, at_risk_json, computed_at, on_time)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(snapshot_date) DO NOTHING`,
  );
  // Pre-existing rows predate the on_time column — fill it without disturbing the
  // recorded confidence / at-risk history.
  const fillOnTime = db().prepare(
    `UPDATE health_snapshots SET on_time = ? WHERE snapshot_date = ?`,
  );

  // Replay oldest → newest. Skip today — live snapshot job owns that row.
  const now = new Date();
  for (let offset = safeDays - 1; offset >= 1; offset--) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const dateKey = d.toISOString().slice(0, 10);
    if (dateKey === todayKey) continue;
    // As-of end-of-day UTC.
    const asOf = `${dateKey}T23:59:59.999Z`;
    if (existing.has(dateKey)) {
      if (existing.get(dateKey) == null) {
        fillOnTime.run(computeScheduleHealth(mf, asOf).onTime, dateKey);
        written++;
      } else {
        skipped++;
      }
      continue;
    }
    const { confidence, sampleSize } = computeConfidence(mf, asOf);
    const atRisk = computeAtRisk(mf, asOf);
    const onTime = computeScheduleHealth(mf, asOf).onTime;
    const computedAt = new Date().toISOString();
    insert.run(dateKey, confidence, sampleSize, JSON.stringify(atRisk), computedAt, onTime);
    written++;
  }

  return { written, skipped };
}
