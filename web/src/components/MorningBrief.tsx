import { useEffect, useMemo, useState } from "react";
import type {
  BriefActivityRef,
  BriefChangeRef,
  BriefChanges,
  BriefFlowMix,
  BriefIssueRef,
  BriefPullRef,
  BriefSnapshot,
  FlowState,
  Issue,
} from "../../../shared/types";
import { useBrief } from "../hooks/useBrief";

interface MorningBriefProps {
  active: boolean;
  issues: Issue[];
  onOpen: (i: Issue) => void;
}

type Tab = "snapshot" | "changes";
const TAB_KEY = "ghRoadmap.briefTab";

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v === "snapshot" || v === "changes") return v;
  } catch {
    /* ignore */
  }
  return "snapshot";
}

function writeTab(t: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    /* ignore */
  }
}

const FLOW_ORDER: FlowState[] = [
  "shipping",
  "in-review",
  "in-code",
  "discussing",
  "fresh",
  "stalled",
  "cold",
];

const FLOW_LABEL: Record<FlowState, string> = {
  shipping: "ship",
  "in-review": "rev",
  "in-code": "code",
  discussing: "disc",
  fresh: "fresh",
  stalled: "stall",
  cold: "cold",
  closed: "done",
};

const FLOW_COLOR: Record<FlowState, string> = {
  shipping: "var(--green)",
  "in-review": "var(--accent)",
  "in-code": "var(--n)",
  discussing: "var(--purple)",
  fresh: "var(--e)",
  stalled: "var(--ink-3)",
  cold: "var(--ink-4)",
  closed: "var(--ink-4)",
};

function formatAsOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

function relativeFromNow(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round(Math.abs(b - a) / (24 * 60 * 60 * 1000)));
}

function SnapshotView({ snap }: { snap: BriefSnapshot }): JSX.Element {
  // Momentum / on-time / at-risk live in the Progress headline section now; this
  // panel keeps the detail that has no home elsewhere: flow mix, this period, queue.
  return (
    <div className="brief-body">
      <div className="brief-row brief-row-stack">
        <span className="brief-row-label">Flow mix</span>
        <FlowMixStrip mix={snap.flowMix} />
      </div>

      <div className="brief-row">
        <span className="brief-row-label">This period</span>
        <span className="brief-row-count">{snap.currentPeriod.total}</span>
        <span className="brief-row-sample">
          {snap.currentPeriod.done} done · {snap.currentPeriod.active} active ·{" "}
          {snap.currentPeriod.stalled} stalled
        </span>
      </div>

      <div className="brief-row">
        <span className="brief-row-label">Queue</span>
        <span className="brief-row-sample">
          TODO {snap.queue.todo} · Backlog {snap.queue.backlog}
        </span>
      </div>

      {snap.crossPodRefs.length > 0 && (
        <div className="brief-row">
          <span className="brief-row-label">Cross-pod refs</span>
          <span className="brief-row-sample">
            {snap.crossPodRefs.map((c) => `${c.count} on ${c.scope}`).join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
}

function FlowMixStrip({ mix }: { mix: BriefFlowMix }): JSX.Element {
  const entries = FLOW_ORDER.map((s) => ({ state: s, count: mix[s] ?? 0 })).filter(
    (e) => e.count > 0,
  );
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (total === 0) {
    return <span className="brief-row-sample">no open work</span>;
  }
  return (
    <div className="flow-mix-wrap">
      <div className="flow-mix-strip">
        {entries.map((e) => (
          <div
            key={e.state}
            className="flow-mix-seg"
            style={{
              flex: e.count,
              background: FLOW_COLOR[e.state],
            }}
            title={`${FLOW_LABEL[e.state]} ${e.count}`}
          />
        ))}
      </div>
      <div className="flow-mix-labels">
        {entries.map((e) => (
          <span key={e.state} className="flow-mix-lab">
            <span className="flow-mix-dot" style={{ background: FLOW_COLOR[e.state] }} />
            {FLOW_LABEL[e.state]} {e.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChangesView({
  changes,
  issueByNum,
  onOpen,
  onMarkSeen,
}: {
  changes: BriefChanges;
  issueByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
  onMarkSeen: () => void;
}): JSX.Element {
  if (changes.since === null) {
    return (
      <div className="brief-body">
        <div className="brief-empty">
          No baseline yet. Click <strong>Mark pod seen</strong> to start tracking changes.
        </div>
        <div className="brief-foot">
          <span className="brief-foot-spacer" />
          <button type="button" className="brief-mark-btn" onClick={onMarkSeen}>
            Mark pod seen
          </button>
        </div>
      </div>
    );
  }

  const allZero =
    changes.totals.enteredAtRisk === 0 &&
    changes.totals.exitedAtRisk === 0 &&
    changes.totals.resolved === 0 &&
    changes.totals.newActivity === 0 &&
    changes.totals.prsMerged === 0 &&
    changes.totals.newIssues === 0;

  const openByNum = (n: number): void => {
    const i = issueByNum.get(n);
    if (i) onOpen(i);
  };

  return (
    <div className="brief-body">
      {changes.cappedAt && (
        <div className="brief-cap">
          Showing last 7d (capped from {daysBetween(changes.cappedAt, new Date().toISOString())}d)
        </div>
      )}

      {allZero ? (
        <div className="brief-empty">
          Since {relativeFromNow(changes.since)}: nothing changed. Quiet.
        </div>
      ) : (
        <>
          {changes.totals.enteredAtRisk > 0 && (
            <ChangeRow
              icon="▲"
              label="Entered at risk"
              total={changes.totals.enteredAtRisk}
              sample={changes.enteredAtRisk.slice(0, 2)}
              renderSample={(items) =>
                (items as BriefChangeRef[])
                  .map((r) => `#${r.num} ${truncate(r.title, 24)}`)
                  .join(" · ")
              }
              onClick={() => {
                if (changes.enteredAtRisk[0]) openByNum(changes.enteredAtRisk[0].num);
              }}
            />
          )}
          {changes.totals.exitedAtRisk > 0 && (
            <ChangeRow
              icon="▼"
              label="Exited at risk"
              total={changes.totals.exitedAtRisk}
              sample={changes.exitedAtRisk.slice(0, 2)}
              renderSample={(items) =>
                (items as BriefChangeRef[])
                  .map((r) => `#${r.num} ${truncate(r.title, 24)}`)
                  .join(" · ")
              }
              onClick={() => {
                if (changes.exitedAtRisk[0]) openByNum(changes.exitedAtRisk[0].num);
              }}
            />
          )}
          {changes.totals.resolved > 0 && (
            <ChangeRow
              icon="▼"
              label="Resolved"
              total={changes.totals.resolved}
              sample={changes.resolved.slice(0, 2)}
              renderSample={(items) =>
                (items as Array<{ num: number; title: string }>)
                  .map((r) => `#${r.num}`)
                  .join(" · ")
              }
              onClick={() => {
                if (changes.resolved[0]) openByNum(changes.resolved[0].num);
              }}
            />
          )}
          {changes.totals.newActivity > 0 && (
            <ChangeRow
              icon="●"
              label="New activity"
              total={changes.totals.newActivity}
              sample={changes.newActivity.slice(0, 2)}
              renderSample={(items) =>
                (items as BriefActivityRef[])
                  .map((r) => `#${r.num} (${r.lastActor})`)
                  .join(", ")
              }
              onClick={() => {
                if (changes.newActivity[0]) openByNum(changes.newActivity[0].num);
              }}
            />
          )}
          {changes.totals.prsMerged > 0 && (
            <ChangeRow
              icon="⇪"
              label="PRs merged"
              total={changes.totals.prsMerged}
              sample={changes.prsMerged.slice(0, 2)}
              renderSample={(items) =>
                (items as BriefPullRef[])
                  .map((p) =>
                    p.linkedIssues.length > 0
                      ? `#${p.prNum} → #${p.linkedIssues[0]}`
                      : `#${p.prNum}`,
                  )
                  .join(" · ")
              }
              onClick={() => {
                const first = changes.prsMerged[0];
                if (first && first.linkedIssues[0] !== undefined) openByNum(first.linkedIssues[0]);
              }}
            />
          )}
          {changes.totals.newIssues > 0 && (
            <ChangeRow
              icon="+"
              label="New issues"
              total={changes.totals.newIssues}
              sample={changes.newIssues.slice(0, 2)}
              renderSample={(items) =>
                (items as BriefIssueRef[])
                  .map((r) => `#${r.num}${r.author ? ` (${r.author})` : ""}`)
                  .join(" · ")
              }
              onClick={() => {
                if (changes.newIssues[0]) openByNum(changes.newIssues[0].num);
              }}
            />
          )}
        </>
      )}

      <div className="brief-foot">
        <span className="brief-foot-spacer">Since {relativeFromNow(changes.since)}</span>
        <button type="button" className="brief-mark-btn" onClick={onMarkSeen}>
          Mark pod seen
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function ChangeRow({
  icon,
  label,
  total,
  sample,
  renderSample,
  onClick,
}: {
  icon: string;
  label: string;
  total: number;
  sample: unknown[];
  renderSample: (items: unknown[]) => string;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="brief-row brief-row-click" onClick={onClick}>
      <span className="brief-row-icon">{icon}</span>
      <span className="brief-row-label">{label}</span>
      <span className="brief-row-count">{total}</span>
      <span className="brief-row-sample">{renderSample(sample)}</span>
    </div>
  );
}

export function MorningBrief({ active, issues, onOpen }: MorningBriefProps): JSX.Element {
  const [tab, setTab] = useState<Tab>(() => readTab());
  const { snapshot, changes, loading, error, markSeen } = useBrief(active);
  const issueByNum = useMemo(() => new Map(issues.map((i) => [i.num, i])), [issues]);

  useEffect(() => {
    writeTab(tab);
  }, [tab]);

  const heading =
    tab === "snapshot"
      ? snapshot
        ? `Where we are · ${formatAsOf(snapshot.asOf)}`
        : "Where we are"
      : changes && changes.since
        ? `Since pod last looked · ${relativeFromNow(changes.since)}`
        : "Since pod last looked";

  return (
    <section className="brief-card">
      <div className="brief-head">
        <span className="brief-title">{heading}</span>
        <div className="brief-tabs">
          <button
            type="button"
            className={`brief-tab${tab === "snapshot" ? " active" : ""}`}
            onClick={() => setTab("snapshot")}
          >
            Snapshot
          </button>
          <button
            type="button"
            className={`brief-tab${tab === "changes" ? " active" : ""}`}
            onClick={() => setTab("changes")}
          >
            Changes
          </button>
        </div>
      </div>

      {error && !snapshot && !changes ? (
        <div className="brief-empty brief-error">couldn’t load brief</div>
      ) : loading && !snapshot && !changes ? (
        <div className="brief-empty">loading…</div>
      ) : tab === "snapshot" ? (
        snapshot ? (
          <SnapshotView snap={snapshot} />
        ) : (
          <div className="brief-empty">no snapshot</div>
        )
      ) : changes ? (
        <ChangesView
          changes={changes}
          issueByNum={issueByNum}
          onOpen={onOpen}
          onMarkSeen={() => void markSeen()}
        />
      ) : (
        <div className="brief-empty">no changes</div>
      )}
    </section>
  );
}
