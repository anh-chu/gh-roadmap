// Column builder + ISO-week helpers for the roadmap board's time axis.
// No external date libs — uses native Date (UTC) only.

import type { RangeGranularity, WorkspaceConfig } from "../../../shared/types";

export interface RangeColumn {
  key: string;        // "YYYY-MM" | "YYYY-Www" | "YYYY-Qn"
  label: string;      // short header
  sublabel: string;   // smaller header line
  isCurrent: boolean; // matches "today" in this granularity
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// --- Month helpers ---

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymKey(year: number, month1: number): string {
  return `${year}-${pad2(month1)}`;
}

function addMonths(year: number, month0: number, delta: number): { year: number; month0: number } {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

// --- ISO week helpers ---

// Convert a UTC date to its ISO-8601 (year, week) tuple.
function isoWeekParts(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Monday=1..Sunday=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // nearest Thursday
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

// Inverse: Monday (UTC) of a given ISO (year, week).
function isoWeekMonday(year: number, week: number): Date {
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const d = new Date(week1Monday);
  d.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return d;
}

function weekKey(year: number, week: number): string {
  return `${year}-W${pad2(week)}`;
}

function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

// Add `delta` ISO weeks to a (year, week); returns next valid (year, week).
function addWeeks(year: number, week: number, delta: number): { year: number; week: number } {
  const monday = isoWeekMonday(year, week);
  monday.setUTCDate(monday.getUTCDate() + delta * 7);
  return isoWeekParts(monday);
}

// --- Quarter helpers ---

function quarterFromMonth0(month0: number): number {
  return Math.floor(month0 / 3) + 1;
}

function qKey(year: number, q: number): string {
  return `${year}-Q${q}`;
}

function addQuarters(year: number, q: number, delta: number): { year: number; q: number } {
  // q is 1..4
  const total = year * 4 + (q - 1) + delta;
  return { year: Math.floor(total / 4), q: ((total % 4) + 4) % 4 + 1 };
}

// --- Public utilities ---

export function monthToQuarter(yyyymm: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm);
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  return qKey(year, quarterFromMonth0(month0));
}

// Returns YYYY-MM of the Monday of the ISO week.
export function weekToMonth(yyyyWww: string): string | null {
  const p = parseWeekKey(yyyyWww);
  if (!p) return null;
  const monday = isoWeekMonday(p.year, p.week);
  return ymKey(monday.getUTCFullYear(), monday.getUTCMonth() + 1);
}

// Returns YYYY-MM of the Sunday of the ISO week.
function weekSundayMonth(yyyyWww: string): string | null {
  const p = parseWeekKey(yyyyWww);
  if (!p) return null;
  const sunday = isoWeekMonday(p.year, p.week);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return ymKey(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1);
}

export function weekToQuarter(yyyyWww: string): string | null {
  const ym = weekToMonth(yyyyWww);
  return ym ? monthToQuarter(ym) : null;
}

export interface MonthSpan {
  startIdx: number;
  endIdx: number;
  startLine: number;
  endLine: number;
  clipStart: boolean;
  clipEnd: boolean;
  boundStart: boolean;
  boundEnd: boolean;
}

// Map a month key onto the visible week columns.
export function monthSpanInWeekCols(monthKey: string, weekCols: RangeColumn[]): MonthSpan | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m || weekCols.length === 0) return null;

  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const startDate = new Date(Date.UTC(year, month0, 1));
  const endDate = new Date(Date.UTC(year, month0 + 1, 0));
  const startParts = isoWeekParts(startDate);
  const endParts = isoWeekParts(endDate);
  const startWeek = weekKey(startParts.year, startParts.week);
  const endWeek = weekKey(endParts.year, endParts.week);

  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < weekCols.length; i++) {
    const col = weekCols[i];
    if (!col) continue;
    const key = col.key;
    if (key < startWeek || key > endWeek) continue;
    if (startIdx === -1) startIdx = i;
    endIdx = i;
  }
  if (startIdx === -1) return null;

  const first = weekCols[0]!;
  const last = weekCols[weekCols.length - 1]!;
  const clipStart = first.key > startWeek;
  const clipEnd = last.key < endWeek;
  const firstKey = weekCols[startIdx]!.key;
  const lastKey = weekCols[endIdx]!.key;
  const boundStart = !clipStart && weekToMonth(firstKey) !== monthKey;
  const boundEnd = !clipEnd && weekSundayMonth(lastKey) !== monthKey;
  const startLine = 2 * startIdx + 1 + (boundStart ? 1 : 0);
  const endLine = 2 * endIdx + 3 - (boundEnd ? 1 : 0);

  return {
    startIdx,
    endIdx,
    startLine,
    endLine,
    clipStart,
    clipEnd,
    boundStart,
    boundEnd,
  };
}

// First month (YYYY-MM) of a given quarter key.
export function quarterFirstMonth(yyyyQn: string): string | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(yyyyQn);
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  return ymKey(year, (q - 1) * 3 + 1);
}

// Build the column list based on config.
export function buildColumns(config: Pick<WorkspaceConfig, "rangeGranularity" | "rangeCount" | "rangeOffset">): RangeColumn[] {
  const { rangeGranularity, rangeCount, rangeOffset } = config;
  const count = Math.max(1, Math.min(12, rangeCount));
  const offset = Math.max(-6, Math.min(6, rangeOffset));
  const now = new Date();
  const cols: RangeColumn[] = [];

  if (rangeGranularity === "month") {
    const startYear = now.getUTCFullYear();
    const startMonth0 = now.getUTCMonth();
    for (let i = 0; i < count; i++) {
      const { year, month0 } = addMonths(startYear, startMonth0, i + offset);
      const key = ymKey(year, month0 + 1);
      const currKey = ymKey(startYear, startMonth0 + 1);
      cols.push({
        key,
        label: MONTH_SHORT[month0] ?? "",
        sublabel: String(year),
        isCurrent: key === currKey,
      });
    }
    return cols;
  }

  if (rangeGranularity === "week") {
    const cur = isoWeekParts(now);
    for (let i = 0; i < count; i++) {
      const { year, week } = addWeeks(cur.year, cur.week, i + offset);
      const key = weekKey(year, week);
      const monday = isoWeekMonday(year, week);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      const sub = `${MONTH_SHORT[monday.getUTCMonth()] ?? ""} ${monday.getUTCDate()} – ${MONTH_SHORT[sunday.getUTCMonth()] ?? ""} ${sunday.getUTCDate()}`;
      cols.push({
        key,
        label: `W${pad2(week)}`,
        sublabel: sub,
        isCurrent: year === cur.year && week === cur.week,
      });
    }
    return cols;
  }

  // quarter
  const curQ = quarterFromMonth0(now.getUTCMonth());
  const curYear = now.getUTCFullYear();
  for (let i = 0; i < count; i++) {
    const { year, q } = addQuarters(curYear, curQ, i + offset);
    const key = qKey(year, q);
    const firstMonth0 = (q - 1) * 3;
    const lastMonth0 = firstMonth0 + 2;
    cols.push({
      key,
      label: `Q${q}`,
      sublabel: `${MONTH_SHORT[firstMonth0] ?? ""} – ${MONTH_SHORT[lastMonth0] ?? ""} ${year}`,
      isCurrent: year === curYear && q === curQ,
    });
  }
  return cols;
}

// Return the issue's column key for a given granularity. Null = backlog.
export function issueColumnKey(
  granularity: RangeGranularity,
  plannedMonth: string | null,
  plannedWeek: string | null,
): string | null {
  if (granularity === "week") {
    if (plannedWeek) return plannedWeek;
    // Month-planned issues bucket into the first week of that month (for visibility).
    if (plannedMonth) {
      const m = /^(\d{4})-(\d{2})$/.exec(plannedMonth);
      if (m) {
        const monthStart = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
        const { year, week } = isoWeekParts(monthStart);
        return weekKey(year, week);
      }
    }
    return null;
  }
  if (granularity === "month") {
    if (plannedMonth) return plannedMonth;
    if (plannedWeek) return weekToMonth(plannedWeek);
    return null;
  }
  // quarter
  if (plannedMonth) return monthToQuarter(plannedMonth);
  if (plannedWeek) return weekToQuarter(plannedWeek);
  return null;
}

// Project a milestone due_on date onto the time axis. Null = unanchored (no due date).
export function milestoneColumnKey(dueOn: string | null, granularity: RangeGranularity): string | null {
  if (!dueOn) return null;
  const d = new Date(dueOn);
  if (Number.isNaN(d.getTime())) return null;
  if (granularity === "week") {
    const { year, week } = isoWeekParts(d);
    return weekKey(year, week);
  }
  if (granularity === "month") return ymKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
  return qKey(d.getUTCFullYear(), quarterFromMonth0(d.getUTCMonth()));
}

export type DriftState = "aligned" | "drift" | "unanchored" | "no-plan";

// The precision the issue is actually planned at: week beats month. Null = no plan.
export function planPrecision(issue: { month: string | null; week: string | null }): "week" | "month" | null {
  if (issue.week) return "week";
  if (issue.month) return "month";
  return null;
}

// Compare plan vs milestone at the issue's own planning precision (plannedWeek → ISO week,
// plannedMonth → month). View granularity does not affect drift. Drift is signal, not error.
export function driftState(
  issue: { month: string | null; week: string | null; milestoneDue: string | null },
): DriftState {
  const precision = planPrecision(issue);
  if (!precision) return "no-plan";
  const planCol = issueColumnKey(precision, issue.month, issue.week);
  if (!planCol) return "no-plan";
  const msCol = milestoneColumnKey(issue.milestoneDue, precision);
  if (!msCol) return "unanchored";
  return planCol === msCol ? "aligned" : "drift";
}

// Grid template per granularity.
export function gridMinWidth(granularity: RangeGranularity): string {
  if (granularity === "week") return "minmax(160px, 1fr)";
  if (granularity === "quarter") return "minmax(280px, 1fr)";
  return "minmax(220px, 1fr)";
}
