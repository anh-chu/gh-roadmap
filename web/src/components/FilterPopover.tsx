import { useEffect, useRef } from "react";
import type { FlowState } from "../../../shared/types";

export type StateFilter = "all" | "open" | "closed";
export type PlanningFilter = "all" | "planned" | "backlog" | "todo";

export const FLOW_STATES: FlowState[] = [
  "shipping",
  "in-review",
  "in-code",
  "discussing",
  "stalled",
  "cold",
  "fresh",
  "closed",
];

export interface RichFilter {
  assignees: string[];
  state: StateFilter;
  planning: PlanningFilter;
  flowStates: FlowState[];
  milestones: string[];
  hasInsights: boolean;
  hasPR: boolean;
  labelQuery: string;
}

export const DEFAULT_RICH_FILTER: RichFilter = {
  assignees: [],
  state: "all",
  planning: "all",
  flowStates: [],
  milestones: [],
  hasInsights: false,
  hasPR: false,
  labelQuery: "",
};

export function isRichFilterActive(f: RichFilter): boolean {
  return (
    f.assignees.length > 0 ||
    f.state !== "all" ||
    f.planning !== "all" ||
    f.flowStates.length > 0 ||
    f.milestones.length > 0 ||
    f.hasInsights ||
    f.hasPR ||
    f.labelQuery.trim() !== ""
  );
}

// Token shortcuts parsed out of the label box. Bounded vocabulary, no real grammar:
// label:x  -label:x  assignee:x  is:open|closed|todo|planned|backlog  flow:<state>
// has:pr|insights  milestone:x. Unknown key: tokens fall through to plain substring.
export interface ParsedLabelQuery {
  labelsInclude: string[];
  labelsExclude: string[];
  assignees: string[];
  state: StateFilter | null;
  planning: PlanningFilter | null;
  flowStates: FlowState[];
  milestones: string[];
  hasPR: boolean;
  hasInsights: boolean;
  text: string; // leftover free substring, matched against labels (legacy behavior)
}

const FLOW_SET = new Set<string>(FLOW_STATES);

export function parseLabelQuery(raw: string): ParsedLabelQuery {
  const out: ParsedLabelQuery = {
    labelsInclude: [],
    labelsExclude: [],
    assignees: [],
    state: null,
    planning: null,
    flowStates: [],
    milestones: [],
    hasPR: false,
    hasInsights: false,
    text: "",
  };
  const leftover: string[] = [];
  for (const tok of raw.trim().split(/\s+/)) {
    if (!tok) continue;
    const m = /^(-)?([a-z]+):(.+)$/i.exec(tok);
    if (!m) {
      leftover.push(tok);
      continue;
    }
    const neg = m[1] === "-";
    const key = (m[2] ?? "").toLowerCase();
    const val = m[3] ?? "";
    if (key === "label") {
      (neg ? out.labelsExclude : out.labelsInclude).push(val);
    } else if (key === "assignee") {
      out.assignees.push(val);
    } else if (key === "milestone") {
      out.milestones.push(val);
    } else if (key === "is") {
      const v = val.toLowerCase();
      if (v === "open" || v === "closed") out.state = v;
      else if (v === "todo" || v === "planned" || v === "backlog") out.planning = v;
      else leftover.push(tok);
    } else if (key === "has") {
      const v = val.toLowerCase();
      if (v === "pr") out.hasPR = true;
      else if (v === "insights" || v === "insight") out.hasInsights = true;
      else leftover.push(tok);
    } else if (key === "flow") {
      const v = val.toLowerCase();
      if (FLOW_SET.has(v)) out.flowStates.push(v as FlowState);
      else leftover.push(tok);
    } else {
      leftover.push(tok);
    }
  }
  out.text = leftover.join(" ");
  return out;
}

interface FilterPopoverProps {
  anchor: DOMRect | null;
  knownAssignees: string[];
  knownMilestones: string[];
  value: RichFilter;
  onChange: (next: RichFilter) => void;
  onClose: () => void;
}

export function FilterPopover(props: FilterPopoverProps): JSX.Element | null {
  const { anchor, knownAssignees, knownMilestones, value, onChange, onClose } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  useEffect(() => {
    const fn = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const id = window.setTimeout(() => document.addEventListener("click", fn), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", fn);
    };
  }, [onClose]);

  if (!anchor) return null;

  const toggleAssignee = (a: string): void => {
    const next = value.assignees.includes(a)
      ? value.assignees.filter((x) => x !== a)
      : [...value.assignees, a];
    onChange({ ...value, assignees: next });
  };

  const toggleMilestone = (m: string): void => {
    const next = value.milestones.includes(m)
      ? value.milestones.filter((x) => x !== m)
      : [...value.milestones, m];
    onChange({ ...value, milestones: next });
  };

  const toggleFlow = (s: FlowState): void => {
    const next = value.flowStates.includes(s)
      ? value.flowStates.filter((x) => x !== s)
      : [...value.flowStates, s];
    onChange({ ...value, flowStates: next });
  };

  return (
    <div
      ref={ref}
      className="popover"
      style={{ top: anchor.bottom + 6, left: anchor.right - 280 }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">Assignee</div>
        <div className="pop-checks">
          {knownAssignees.length === 0 ? (
            <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>
          ) : (
            knownAssignees.map((a) => (
              <label key={a} className="pop-check">
                <input
                  type="checkbox"
                  checked={value.assignees.includes(a)}
                  onChange={() => toggleAssignee(a)}
                />
                <span>{a}</span>
              </label>
            ))
          )}
        </div>
      </div>
      <div className="pop-section">
        <div className="pop-label">State</div>
        <div className="pop-segment">
          {(["all", "open", "closed"] as const).map((s) => (
            <button
              key={s}
              className={"pop-seg" + (value.state === s ? " active" : "")}
              onClick={() => onChange({ ...value, state: s })}
            >
              {s === "all" ? "All" : s === "open" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
      </div>
      <div className="pop-section">
        <div className="pop-label">Planning</div>
        <div className="pop-segment">
          {(["all", "planned", "backlog", "todo"] as const).map((s) => (
            <button
              key={s}
              className={"pop-seg" + (value.planning === s ? " active" : "")}
              onClick={() => onChange({ ...value, planning: s })}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="pop-section">
        <div className="pop-label">Flow</div>
        <div className="pop-checks">
          {FLOW_STATES.map((s) => (
            <label key={s} className="pop-check">
              <input
                type="checkbox"
                checked={value.flowStates.includes(s)}
                onChange={() => toggleFlow(s)}
              />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="pop-section">
        <div className="pop-label">Signal</div>
        <div className="pop-checks">
          <label className="pop-check">
            <input
              type="checkbox"
              checked={value.hasPR}
              onChange={() => onChange({ ...value, hasPR: !value.hasPR })}
            />
            <span>has PR</span>
          </label>
          <label className="pop-check">
            <input
              type="checkbox"
              checked={value.hasInsights}
              onChange={() => onChange({ ...value, hasInsights: !value.hasInsights })}
            />
            <span>has insights</span>
          </label>
        </div>
      </div>
      {knownMilestones.length > 0 && (
        <div className="pop-section">
          <div className="pop-label">Milestone</div>
          <div className="pop-checks">
            {knownMilestones.map((m) => (
              <label key={m} className="pop-check">
                <input
                  type="checkbox"
                  checked={value.milestones.includes(m)}
                  onChange={() => toggleMilestone(m)}
                />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="pop-section">
        <div className="pop-label">Label / query</div>
        <input
          className="pop-input"
          placeholder="label substring · or label:x -label:y is:open flow:stalled has:pr"
          value={value.labelQuery}
          onChange={(e) => onChange({ ...value, labelQuery: e.target.value })}
        />
      </div>
      <div className="pop-foot">
        <button className="pop-reset" onClick={() => onChange(DEFAULT_RICH_FILTER)}>
          Reset
        </button>
      </div>
    </div>
  );
}
