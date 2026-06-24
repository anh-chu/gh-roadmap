import { useMemo } from "react";
import type { HealthSnapshotSummary, Issue, MetaResponse, PmActionCategory, PmActionItem, RiskItem, ScheduleHealth, ScheduleStatus } from "../../../shared/types";
import type { MoveTarget } from "../hooks/useIssues";
import { issueColumnKey, milestoneColumnKey, planPrecision } from "../lib/timeRange";
import { useHealth } from "../hooks/useHealth";
import { usePmActions } from "../hooks/usePmActions";
import { MorningBrief } from "./MorningBrief";
import { AiBlock } from "./AiBlock";
import { useAiProgress } from "../hooks/useAiProgress";
import { EffortChip } from "./EffortChip";

interface ProgressProps {
  issues: Issue[];
  meta: MetaResponse | null;
  onOpen: (i: Issue) => void;
  // Triage an at-risk item without leaving Today (reuses the board's move path).
  onMove?: (num: number, target: MoveTarget) => void;
}

const RISK_VISIBLE = 8;

function severityColor(sev: 1 | 2 | 3): string {
  if (sev === 3) return "var(--r)";
  if (sev === 2) return "var(--accent)";
  return "var(--ink-3)";
}

function scheduleStatusLabel(s: ScheduleStatus): { text: string; color: string } {
  if (s === "on-track") return { text: "on track", color: "var(--green)" };
  if (s === "watch") return { text: "watch", color: "var(--accent)" };
  if (s === "at-risk") return { text: "at risk", color: "var(--r)" };
  if (s === "off-track") return { text: "off track", color: "var(--r)" };
  return { text: "no plan", color: "var(--ink-4)" };
}

// Momentum uses its OWN vocabulary so it never collides with the schedule
// status words ("on track" / "at risk") rendered alongside it.
function momentumLabel(c: number | null): { text: string; color: string } {
  if (c === null) return { text: "no signal", color: "var(--ink-4)" };
  if (c >= 80) return { text: "strong", color: "var(--green)" };
  if (c >= 50) return { text: "mixed", color: "var(--accent)" };
  return { text: "weak", color: "var(--r)" };
}

// One-line plain-English answer to "should I worry today?". Schedule-led — it's
// the metric our data actually supports — with the at-risk count as the tail.
function verdict(
  schedule: ScheduleHealth | null,
  atRisk: RiskItem[],
  closedThisMonth: number | null,
): { text: string; color: string } {
  const needs = atRisk.filter((r) => r.severity >= 2).length;
  const needsTail = needs > 0 ? ` · ${needs} need${needs === 1 ? "s" : ""} attention` : "";
  const positiveTail = closedThisMonth && closedThisMonth > 0 ? ` Still, ${closedThisMonth} closed this month.` : "";
  if (!schedule || schedule.status === "no-plan") {
    return {
      text: `No roadmap commitments yet — nothing to track against dates.${positiveTail}`,
      color: "var(--ink-3)",
    };
  }
  const { status, overdue, dueSoonAtRisk, committed } = schedule;
  const driver: string[] = [];
  if (overdue > 0) driver.push(`${overdue} overdue`);
  if (dueSoonAtRisk > 0) driver.push(`${dueSoonAtRisk} due now, not moving`);
  const lbl = scheduleStatusLabel(status);
  if (status === "on-track") {
    return {
      text: `Roadmap on track — ${committed} committed, dates holding${needsTail}.${positiveTail}`,
      color: lbl.color,
    };
  }
  const head = status === "watch" ? "Roadmap needs a look" : `Roadmap ${lbl.text}`;
  const why = driver.length ? ` — ${driver.join(", ")}` : "";
  return { text: `${head}${why}${needsTail}.${positiveTail}`, color: lbl.color };
}

function Sparkline({ values }: { values: (number | null)[] }): JSX.Element | null {
  const pts = values.filter((v): v is number => v !== null);
  if (pts.length < 2) return null;
  const w = 160;
  const h = 32;
  const step = w / (pts.length - 1);
  const path = pts
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / 100) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="hd-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={path}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

export function Progress({ issues, meta, onOpen, onMove }: ProgressProps): JSX.Element {
  const { live, history } = useHealth();

  const confidence = live?.confidence ?? null;
  const sampleSize = live?.sampleSize ?? 0;
  const noSignal = live?.noSignal ?? 0;
  const atRisk = live?.atRisk ?? [];
  const schedule = live?.schedule ?? null;

  const sched = schedule ? scheduleStatusLabel(schedule.status) : scheduleStatusLabel("no-plan");
  const mom = momentumLabel(confidence);
  const v = verdict(schedule, atRisk, meta?.closedThisMonth ?? null);

  const issueByNum = useMemo(() => new Map(issues.map((i) => [i.num, i])), [issues]);

  const onTimeSeries = useMemo(
    () => history.map((p: HealthSnapshotSummary) => p.onTime),
    [history],
  );
  const momentumSeries = useMemo(
    () => history.map((p: HealthSnapshotSummary) => p.confidence),
    [history],
  );

  // Actionable = severity ≥ 2 (critical/high). Sev-1 items (low-signal, owed-reply,
  // todo-stale) are watch-only and sort below. Backend already orders sev-desc.
  const actionable = atRisk.filter((r) => r.severity >= 2).length;
  const visibleRisk = atRisk.slice(0, RISK_VISIBLE);
  const hiddenRisk = atRisk.length - visibleRisk.length;
  const foundationCount = atRisk.filter((r) => r.effort === "foundation").length;

  const syncedAgo = meta ? relativeTime(meta.lastSyncAt) : "—";

  // Plan-vs-milestone drift over scheduled (planned-only, backlog excluded) open issues.
  const drift = useMemo(() => {
    let earlier = 0;
    let later = 0;
    let unanchored = 0;
    let aligned = 0;
    for (const i of issues) {
      if (i.state !== "open") continue;
      // Compare at the issue's own planning precision (week if plannedWeek, else month).
      const precision = planPrecision(i);
      if (!precision) continue; // backlog / TODO — nothing committed to compare
      const planCol = issueColumnKey(precision, i.month, i.week);
      if (!planCol) continue;
      const msCol = milestoneColumnKey(i.milestoneDue, precision);
      if (!msCol) {
        if (i.milestone) unanchored++; // milestone exists but has no due date
        continue;
      }
      if (planCol < msCol) earlier++;
      else if (planCol > msCol) later++;
      else aligned++;
    }
    return { earlier, later, unanchored, aligned };
  }, [issues]);

  return (
    <section className="progress active reveal" style={{ animationDelay: "120ms" }}>
      <div className="pg-col">
        {/* 1 — VERDICT */}
        <div className="pg-verdict" style={{ borderColor: v.color }}>
          <span className="pg-verdict-dot" style={{ background: v.color }} />
          <span className="pg-verdict-text">{v.text}</span>
        </div>

        {/* main split: primary action column + secondary rail (collapses < 1000px) */}
        <div className="pg-main">
        <div className="pg-primary">
        {/* 2 — AI READ */}
        <AiReadCard issuesByNum={issueByNum} onOpenIssue={onOpen} />

        {/* 3 — WHAT NEEDS YOU NOW */}
        <div className="hd-card hd-risk">
          <div className="hd-card-head">
            <h3>
              Needs you now · {actionable} to act
              <span style={{ color: "var(--ink-4)", fontWeight: 400 }}> · {atRisk.length} total</span>
              {foundationCount > 0 && (
                <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · {foundationCount} foundation</span>
              )}
            </h3>
          </div>
          {atRisk.length === 0 ? (
            <div className="hd-empty">Nothing needs a nudge right now.</div>
          ) : (
            <>
              <div className="hd-risk-list">
                {visibleRisk.map((r: RiskItem) => {
                  const issue = issueByNum.get(r.issueNumber);
                  return (
                    <div
                      key={r.issueNumber}
                      className={`hd-risk-row sev-${r.severity}`}
                      onClick={() => {
                        if (issue) onOpen(issue);
                      }}
                      style={{ cursor: issue ? "pointer" : "default" }}
                    >
                      <span className="hd-risk-dot" style={{ background: severityColor(r.severity) }} />
                      {r.kind === "preventative" && (
                        <span className="preventative-icon" title={`Preventative: ${r.category}`}>
                          ⏳
                        </span>
                      )}
                      <span className="hd-risk-num">#{r.issueNumber}</span>
                      {r.effort && r.effortSource && (
                        <EffortChip effort={r.effort} source={r.effortSource} />
                      )}
                      <span className="hd-risk-title">{r.title}</span>
                      <span className="hd-risk-reason">{r.reason}</span>
                      {onMove && issue && (
                        <span className="hd-risk-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="hd-risk-act"
                            title="Park in To Do — off the committed plan"
                            onClick={() => onMove(r.issueNumber, { kind: "todo" })}
                          >
                            → To Do
                          </button>
                          <button
                            className="hd-risk-act"
                            title="Send to Backlog"
                            onClick={() => onMove(r.issueNumber, { kind: "backlog" })}
                          >
                            → Backlog
                          </button>
                        </span>
                      )}
                      <span className="hd-risk-chev">▶</span>
                    </div>
                  );
                })}
              </div>
              {hiddenRisk > 0 && (
                <div className="hd-more">+{hiddenRisk} more lower-priority</div>
              )}
            </>
          )}
        </div>

        {/* 3b — ON YOUR PLATE (PM craft work, distinct from the eng-nudge list above) */}
        <OnYourPlateCard issuesByNum={issueByNum} onOpenIssue={onOpen} />

        </div>{/* /pg-primary */}

        {/* 4 — SCHEDULE (headline) + MOMENTUM (secondary) — secondary rail */}
        <div className="pg-rail">
          <div className="hd-card pg-stat">
            <div className="hd-card-head">
              <h3>Schedule</h3>
              <span className="hd-asof">are dates holding?</span>
            </div>
            <div className="hd-row">
              <div className="hd-num-wrap">
                <span className="hd-num">
                  {schedule?.onTime == null ? "—" : `${schedule.onTime}%`}
                </span>
                <span className="hd-label" style={{ color: sched.color }}>{sched.text}</span>
              </div>
              <div className="hd-spark-wrap">
                <Sparkline values={onTimeSeries} />
                <div className="hd-spark-sub">on-time 30d</div>
              </div>
            </div>
            <div className="hd-sub">
              {schedule === null || schedule.status === "no-plan"
                ? "no roadmap commitments"
                : `${schedule.committed} committed · ${schedule.overdue} overdue · ${schedule.dueSoonAtRisk} due now, not moving`}
            </div>
          </div>

          <div className="hd-card pg-stat secondary">
            <div className="hd-card-head">
              <h3>Plan drift</h3>
              <span className="hd-asof">plan vs milestone</span>
            </div>
            <div className="hd-sub">
              {drift.earlier === 0 && drift.later === 0 && drift.unanchored === 0
                ? drift.aligned === 0
                  ? "no dated milestones on scheduled work"
                  : `all ${drift.aligned} aligned`
                : `${drift.earlier} planned earlier than milestone · ${drift.later} later · ${drift.unanchored} unanchored`}
            </div>
          </div>

          <div className="hd-card pg-stat secondary">
            <div className="hd-card-head">
              <h3>Momentum</h3>
              <span className="hd-asof">is work moving?</span>
            </div>
            <div className="hd-row">
              <div className="hd-num-wrap">
                <span className="hd-num hd-num-sm">
                  {confidence === null ? "—" : `${confidence}%`}
                </span>
                <span className="hd-label" style={{ color: mom.color }}>{mom.text}</span>
              </div>
              <div className="hd-spark-wrap">
                <Sparkline values={momentumSeries} />
                <div className="hd-spark-sub">momentum 30d</div>
              </div>
            </div>
            <div className="hd-sub">
              {sampleSize === 0
                ? `no judgeable work${noSignal > 0 ? ` · ${noSignal} no signal` : ""}`
                : `${sampleSize} judged${noSignal > 0 ? ` · ${noSignal} no signal` : ""}`}
            </div>
          </div>

        {/* 5 — DETAIL + SINCE YOU LAST LOOKED */}
        <MorningBrief active={true} issues={issues} onOpen={onOpen} />
        </div>{/* /pg-rail */}
        </div>{/* /pg-main */}

        <div className="pg-foot">
          <span>data synced {syncedAgo}</span>
        </div>
      </div>
    </section>
  );
}

const PM_CAT_LABEL: Record<PmActionCategory, string> = {
  "thin-spec": "spec",
  "pre-release": "pre-release",
  "post-release": "post-release",
  "decision-owed": "decision",
};

// "On your plate" — PM craft work an item owes (spec depth, release artifacts, a call).
// Detector-backed; AI reorders + phrases when configured. Always renders something.
function OnYourPlateCard({
  issuesByNum,
  onOpenIssue,
}: {
  issuesByNum: Map<number, Issue>;
  onOpenIssue: (i: Issue) => void;
}): JSX.Element {
  const { data, loading, error, refresh } = usePmActions();
  const items = data?.items ?? [];

  return (
    <div className="hd-card hd-plate">
      <div className="hd-card-head">
        <h3>
          On your plate
          <span style={{ color: "var(--ink-4)", fontWeight: 400 }}> · {items.length} item{items.length === 1 ? "" : "s"}</span>
        </h3>
        {data?.aiRanked && (
          <button
            className="hd-regen"
            onClick={() => void refresh()}
            disabled={loading}
            title="Regenerate ranking"
          >
            {loading ? "…" : "↻"}
          </button>
        )}
      </div>
      {error ? (
        <div className="hd-empty">Couldn't load PM actions.</div>
      ) : items.length === 0 ? (
        <div className="hd-empty">Nothing on your plate — specs and releases look covered.</div>
      ) : (
        <div className="hd-risk-list">
          {items.map((it: PmActionItem) => {
            const issue = issuesByNum.get(it.issueNumber);
            return (
              <div
                key={it.issueNumber}
                className="hd-risk-row hd-plate-row"
                onClick={() => {
                  if (issue) onOpenIssue(issue);
                }}
                style={{ cursor: issue ? "pointer" : "default" }}
              >
                <span className={`pm-cat pm-cat-${it.category}`}>{PM_CAT_LABEL[it.category]}</span>
                <span className="hd-risk-num">#{it.issueNumber}</span>
                <span className="hd-risk-title">{it.title}</span>
                <span className="hd-risk-reason">{it.action}</span>
                <span className="hd-risk-chev">▶</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AiReadCard({
  issuesByNum,
  onOpenIssue,
}: {
  issuesByNum: Map<number, Issue>;
  onOpenIssue: (i: Issue) => void;
}): JSX.Element | null {
  const { summary, loading, error, disabled, refresh } = useAiProgress();
  if (disabled) return null;
  return (
    <div className="hd-card">
      <AiBlock
        label="AI read"
        content={summary?.analysis ?? ""}
        model={summary?.model ?? ""}
        generatedAt={summary?.generatedAt ?? ""}
        loading={loading}
        error={error}
        onRefresh={() => void refresh()}
        issuesByNum={issuesByNum}
        onOpenIssue={onOpenIssue}
      />
    </div>
  );
}
