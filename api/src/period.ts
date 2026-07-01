// Server-side roadmap period math: granularity-aware ordinals + column generation.
// Mirrors web/src/lib/timeRange.ts (which is render-only); kept separate so the
// scoring layer doesn't import frontend code. Native Date (UTC) only.

import type { RangeGranularity } from "../../shared/types.js";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ── ISO week ──────────────────────────────────────────────────────
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const d = new Date(week1Monday);
  d.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return d;
}
function isoWeekParts(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

// Project an ISO date-time (e.g. a milestone due_on) onto its ISO-week key (YYYY-Www).
export function dateToWeekKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { year, week } = isoWeekParts(d);
  return `${year}-W${pad2(week)}`;
}

// ── Parsing ───────────────────────────────────────────────────────
function parseMonthKey(key: string): { year: number; month0: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month0: Number(m[2]) - 1 };
}
function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

// ── Ordinals: integers where +1 = the next period in that granularity ──
function monthOrdinal(year: number, month0: number): number {
  return year * 12 + month0;
}
function weekOrdinalFromDate(d: Date): number {
  // Monday-of-week epoch, in whole weeks. Stable for differencing across years.
  const { year, week } = isoWeekParts(d);
  const monday = isoWeekMonday(year, week);
  return Math.floor(monday.getTime() / (7 * 86_400_000));
}
function quarterOrdinal(year: number, month0: number): number {
  return year * 4 + Math.floor(month0 / 3);
}

export function currentPeriodOrdinal(g: RangeGranularity, now = new Date()): number {
  if (g === "week") return weekOrdinalFromDate(now);
  if (g === "quarter") return quarterOrdinal(now.getUTCFullYear(), now.getUTCMonth());
  return monthOrdinal(now.getUTCFullYear(), now.getUTCMonth());
}

// Map an issue's planned_month / planned_week to the ordinal for the active
// granularity. Prefers the field matching the granularity, falls back across.
export function issuePeriodOrdinal(
  g: RangeGranularity,
  plannedMonth: string | null,
  plannedWeek: string | null,
): number | null {
  if (g === "week") {
    if (plannedWeek) {
      const p = parseWeekKey(plannedWeek);
      if (p) return weekOrdinalFromDate(isoWeekMonday(p.year, p.week));
    }
    if (plannedMonth) {
      const p = parseMonthKey(plannedMonth);
      if (p) return weekOrdinalFromDate(new Date(Date.UTC(p.year, p.month0, 1)));
    }
    return null;
  }
  if (g === "quarter") {
    if (plannedMonth) {
      const p = parseMonthKey(plannedMonth);
      if (p) return quarterOrdinal(p.year, p.month0);
    }
    if (plannedWeek) {
      const p = parseWeekKey(plannedWeek);
      if (p) {
        const monday = isoWeekMonday(p.year, p.week);
        return quarterOrdinal(monday.getUTCFullYear(), monday.getUTCMonth());
      }
    }
    return null;
  }
  // month
  if (plannedMonth) {
    const p = parseMonthKey(plannedMonth);
    if (p) return monthOrdinal(p.year, p.month0);
  }
  if (plannedWeek) {
    const p = parseWeekKey(plannedWeek);
    if (p) {
      const monday = isoWeekMonday(p.year, p.week);
      return monthOrdinal(monday.getUTCFullYear(), monday.getUTCMonth());
    }
  }
  return null;
}

// Signed periods until an issue is due: <0 overdue, 0 due this period, >0 future.
// null = no usable plan.
export function periodsUntilDue(
  g: RangeGranularity,
  plannedMonth: string | null,
  plannedWeek: string | null,
  now = new Date(),
): number | null {
  const issueOrd = issuePeriodOrdinal(g, plannedMonth, plannedWeek);
  if (issueOrd === null) return null;
  return issueOrd - currentPeriodOrdinal(g, now);
}

export interface PeriodColumn {
  key: string;
  label: string;
  ordinal: number;
  isCurrent: boolean;
}

// Generate the visible roadmap columns for the active range config.
export function periodColumns(
  g: RangeGranularity,
  count: number,
  offset: number,
  now = new Date(),
): PeriodColumn[] {
  const n = Math.max(1, Math.min(12, count));
  const off = Math.max(-6, Math.min(6, offset));
  const cols: PeriodColumn[] = [];
  if (g === "month") {
    const baseY = now.getUTCFullYear();
    const baseM = now.getUTCMonth();
    const curOrd = monthOrdinal(baseY, baseM);
    for (let i = 0; i < n; i++) {
      const total = baseY * 12 + baseM + i + off;
      const year = Math.floor(total / 12);
      const month0 = ((total % 12) + 12) % 12;
      const ordinal = monthOrdinal(year, month0);
      cols.push({
        key: `${year}-${pad2(month0 + 1)}`,
        label: `${MONTH_SHORT[month0]} ${year}`,
        ordinal,
        isCurrent: ordinal === curOrd,
      });
    }
    return cols;
  }
  if (g === "week") {
    const cur = isoWeekParts(now);
    const curOrd = weekOrdinalFromDate(now);
    for (let i = 0; i < n; i++) {
      const monday = isoWeekMonday(cur.year, cur.week);
      monday.setUTCDate(monday.getUTCDate() + (i + off) * 7);
      const parts = isoWeekParts(monday);
      const ordinal = weekOrdinalFromDate(monday);
      cols.push({
        key: `${parts.year}-W${pad2(parts.week)}`,
        label: `W${pad2(parts.week)} ${parts.year}`,
        ordinal,
        isCurrent: ordinal === curOrd,
      });
    }
    return cols;
  }
  // quarter
  const curY = now.getUTCFullYear();
  const curQ0 = Math.floor(now.getUTCMonth() / 3);
  const curOrd = quarterOrdinal(curY, now.getUTCMonth());
  for (let i = 0; i < n; i++) {
    const total = curY * 4 + curQ0 + i + off;
    const year = Math.floor(total / 4);
    const q0 = ((total % 4) + 4) % 4;
    const ordinal = year * 4 + q0;
    cols.push({
      key: `${year}-Q${q0 + 1}`,
      label: `Q${q0 + 1} ${year}`,
      ordinal,
      isCurrent: ordinal === curOrd,
    });
  }
  return cols;
}
