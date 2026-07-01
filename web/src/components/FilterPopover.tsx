import { useEffect, useMemo, useRef, useState } from "react";
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

// Bounded-height picker for lists that can grow past a handful of values (assignees,
// milestones): selected show as removable chips, everything else lives behind a
// type-to-filter input instead of being rendered all at once.
interface TagPickerProps {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  placeholder: string;
}

function TagPicker({ label, options, selected, onToggle, placeholder }: TagPickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return pool.slice(0, 30);
  }, [options, query]);

  return (
    <div className="pop-section" ref={rootRef}>
      <div className="pop-label">{label}</div>
      {selected.length > 0 && (
        <div className="pop-chips" style={{ marginBottom: 6 }}>
          {selected.map((v) => (
            <button key={v} className="pop-chip active" onClick={() => onToggle(v)}>
              {v} ×
            </button>
          ))}
        </div>
      )}
      <div className="tag-picker">
        <input
          className="pop-input"
          placeholder={placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        {open && options.length > 0 && (
          <div className="tag-picker-list">
            {matches.length === 0 ? (
              <div className="tag-picker-empty">No match</div>
            ) : (
              matches.map((v) => (
                <button
                  key={v}
                  className={"tag-picker-opt" + (selected.includes(v) ? " active" : "")}
                  onClick={() => {
                    onToggle(v);
                    setQuery("");
                  }}
                >
                  {v}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
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
      <TagPicker
        label="Assignee"
        options={knownAssignees}
        selected={value.assignees}
        onToggle={toggleAssignee}
        placeholder={knownAssignees.length === 0 ? "—" : "Search assignees…"}
      />
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
        <div className="pop-chips">
          {FLOW_STATES.map((s) => (
            <button
              key={s}
              className={"pop-chip" + (value.flowStates.includes(s) ? " active" : "")}
              onClick={() => toggleFlow(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="pop-section">
        <div className="pop-label">Signal</div>
        <div className="pop-chips">
          <button
            className={"pop-chip" + (value.hasPR ? " active" : "")}
            onClick={() => onChange({ ...value, hasPR: !value.hasPR })}
          >
            has PR
          </button>
          <button
            className={"pop-chip" + (value.hasInsights ? " active" : "")}
            onClick={() => onChange({ ...value, hasInsights: !value.hasInsights })}
          >
            has insights
          </button>
        </div>
      </div>
      {knownMilestones.length > 0 && (
        <TagPicker
          label="Milestone"
          options={knownMilestones}
          selected={value.milestones}
          onToggle={toggleMilestone}
          placeholder="Search milestones…"
        />
      )}
      <div className="pop-section">
        <div className="pop-label">Label / query</div>
        <input
          className="pop-input"
          placeholder="label:x -label:y is:open flow:stalled has:pr"
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
