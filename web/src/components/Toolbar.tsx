import { useEffect, useRef, useState } from "react";
import type { BucketingField, RangeGranularity, WorkspaceConfig } from "../../../shared/types";
import { buildColumns } from "../lib/timeRange";
import { canEdit } from "../lib/role";
import { HelpPopover } from "./HelpPopover";

export type FilterKey = "all" | "mine";
export type TabKey = "roadmap" | "list" | "kanban" | "milestones" | "insights" | "accounts" | "progress";

// IA: seven artifacts collapse to the four questions a PM actually asks.
// Roadmap/List/Kanban are three lenses on the same issues → one "Work" group with
// a view toggle. Insights/Accounts are one customer axis → "Customers".
type NavGroup = "today" | "work" | "releases" | "customers";

const PRIMARY_NAV: { group: NavGroup; label: string; landing: TabKey; icon: string }[] = [
  { group: "today", label: "Today", landing: "progress", icon: '<svg class="icon" viewBox="0 0 16 16" fill="none"><path d="M2 13 L6 7 L9 10 L14 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { group: "work", label: "Work", landing: "roadmap", icon: '<svg class="icon" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13M5.5 2.5v11" stroke="currentColor" stroke-width="1.4"/></svg>' },
  { group: "releases", label: "Releases", landing: "milestones", icon: '<svg class="icon" viewBox="0 0 16 16" fill="none"><path d="M3 2.5v11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 3.5h8.5l-1.8 2.2 1.8 2.2H3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>' },
  { group: "customers", label: "Customers", landing: "insights", icon: '<svg class="icon" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="5.5" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 13.5c0-2.485 2.015-4.5 4.5-4.5s4.5 2.015 4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="6" r="1.8" stroke="currentColor" stroke-width="1.3"/><path d="M12 9c1.657 0 3 1.343 3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
];

const WORK_VIEWS: { tab: TabKey; label: string }[] = [
  { tab: "roadmap", label: "Board" },
  { tab: "list", label: "List" },
  { tab: "kanban", label: "Kanban" },
];
const CUSTOMER_VIEWS: { tab: TabKey; label: string }[] = [
  { tab: "insights", label: "Insights" },
  { tab: "accounts", label: "Accounts" },
];

function groupOf(tab: TabKey): NavGroup {
  if (tab === "progress") return "today";
  if (tab === "milestones") return "releases";
  if (tab === "insights" || tab === "accounts") return "customers";
  return "work";
}

interface ToolbarProps {
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  search: string;
  onSearch: (s: string) => void;
  totalShown: number;
  config: WorkspaceConfig;
  onConfigChange: (patch: {
    bucketingField?: BucketingField;
    bucketingValue?: string;
    rangeGranularity?: RangeGranularity;
    rangeCount?: number;
    rangeOffset?: number;
    pinMetaCols?: boolean;
  }) => void;
}

const FIELD_LABELS: Record<BucketingField, string> = {
  none: "None",
  label: "Label",
  assignee: "Assignee",
  milestone: "Milestone",
};

function groupByLabel(cfg: WorkspaceConfig): string {
  if (cfg.bucketingField === "label") {
    const cap = cfg.bucketingValue.charAt(0).toUpperCase() + cfg.bucketingValue.slice(1);
    return cap || "Label";
  }
  return FIELD_LABELS[cfg.bucketingField];
}

interface GroupByDropdownProps {
  config: WorkspaceConfig;
  onChange: (patch: { bucketingField?: BucketingField; bucketingValue?: string }) => void;
}

function GroupByDropdown({ config, onChange }: GroupByDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState(config.bucketingValue || "area");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    setLabelDraft(config.bucketingValue || "area");
  }, [config.bucketingValue]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickField = (field: BucketingField): void => {
    if (field === "label") {
      onChange({ bucketingField: "label", bucketingValue: labelDraft.replace(/:$/, "") || "area" });
    } else {
      onChange({ bucketingField: field });
    }
  };

  const onLabelInput = (v: string): void => {
    setLabelDraft(v);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const cleaned = v.replace(/:$/, "").trim();
      if (/^[a-zA-Z0-9-]{1,32}$/.test(cleaned)) {
        onChange({ bucketingField: "label", bucketingValue: cleaned });
      }
    }, 400);
  };

  return (
    <div className="groupby" ref={rootRef}>
      {/* Writes shared workspace config — viewers see the value, can't open the editor. */}
      <button className="btn groupby-trigger" onClick={() => canEdit() && setOpen((o) => !o)}>
        Group by: <b>{groupByLabel(config)}</b>
        <svg className="icon" viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path d="M2.5 4.5 L6 8 L9.5 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="popover groupby-pop" role="dialog">
          <div className="pop-section">
            <div className="pop-label">Group by</div>
            <div className="pop-checks">
              {(["none", "label", "assignee", "milestone"] as const).map((f) => (
                <label key={f} className="pop-check">
                  <input
                    type="radio"
                    name="groupby"
                    checked={config.bucketingField === f}
                    onChange={() => pickField(f)}
                  />
                  {FIELD_LABELS[f]}
                </label>
              ))}
            </div>
          </div>
          {config.bucketingField === "label" && (
            <div className="pop-section">
              <div className="pop-label">Label prefix</div>
              <input
                className="pop-input"
                value={labelDraft}
                onChange={(e) => onLabelInput(e.target.value)}
                placeholder="e.g. area, team, type"
                spellCheck={false}
              />
            </div>
          )}
          <div className="pop-foot">
            <button className="pop-reset" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

const GRANULARITY_NOUN: Record<RangeGranularity, { single: string; plural: string }> = {
  week: { single: "week", plural: "weeks" },
  month: { single: "month", plural: "months" },
  quarter: { single: "quarter", plural: "quarters" },
};

interface RangeControlProps {
  config: WorkspaceConfig;
  onChange: (patch: { rangeGranularity?: RangeGranularity; rangeCount?: number; rangeOffset?: number; pinMetaCols?: boolean }) => void;
}

function RangeControl({ config, onChange }: RangeControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const noun = GRANULARITY_NOUN[config.rangeGranularity];
  const triggerLabel = `${config.rangeCount} ${config.rangeCount === 1 ? noun.single : noun.plural}`;
  const preview = buildColumns(config).map((c) => `${c.label} ${c.sublabel}`.trim()).join(", ");

  const pickGranularity = (g: RangeGranularity): void => {
    onChange({ rangeGranularity: g });
  };

  return (
    <div className="range-control" ref={rootRef}>
      {/* Writes shared workspace config — viewers see the value, can't open the editor. */}
      <button className="btn groupby-trigger" onClick={() => canEdit() && setOpen((o) => !o)}>
        View: <b>{triggerLabel}</b>
        <svg className="icon" viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path d="M2.5 4.5 L6 8 L9.5 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="popover range-pop" role="dialog">
          <div className="pop-section">
            <div className="pop-label">Granularity</div>
            <div className="tabs range-seg">
              {(["week", "month", "quarter"] as const).map((g) => (
                <button
                  key={g}
                  className={"tab" + (config.rangeGranularity === g ? " active" : "")}
                  onClick={() => pickGranularity(g)}
                >
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-label">
              Columns <span style={{ opacity: 0.6, fontWeight: 400 }}>({config.rangeCount})</span>
            </div>
            <div className="range-row">
              <input
                type="range"
                min={1}
                max={12}
                value={config.rangeCount}
                onChange={(e) => onChange({ rangeCount: Number(e.target.value) })}
              />
              <input
                type="number"
                className="pop-input range-num"
                min={1}
                max={12}
                value={config.rangeCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1 && n <= 12) onChange({ rangeCount: n });
                }}
              />
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-label">
              Offset <span style={{ opacity: 0.6, fontWeight: 400 }}>({config.rangeOffset >= 0 ? "+" : ""}{config.rangeOffset})</span>
            </div>
            <div className="range-hint">First column is this many periods from current. Negative = past.</div>
            <div className="range-row">
              <input
                type="range"
                min={-6}
                max={6}
                value={config.rangeOffset}
                onChange={(e) => onChange({ rangeOffset: Number(e.target.value) })}
              />
              <input
                type="number"
                className="pop-input range-num"
                min={-6}
                max={6}
                value={config.rangeOffset}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= -6 && n <= 6) onChange({ rangeOffset: n });
                }}
              />
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-label">Preview</div>
            <div className="range-preview">{preview}</div>
          </div>
          <div className="pop-section">
            <label className="pop-check">
              <input
                type="checkbox"
                checked={config.pinMetaCols}
                onChange={(e) => onChange({ pinMetaCols: e.target.checked })}
              />
              Pin TODO + Backlog to the right
            </label>
          </div>
          <div className="pop-foot">
            <button className="pop-reset" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const { filter, onFilter, tab, onTab, search, onSearch, totalShown, config, onConfigChange } = props;
  const showWorkspaceControls = tab === "roadmap" || tab === "list";
  const showRoadmapControls = tab === "roadmap";
  const group = groupOf(tab);
  const subTabs = group === "work" ? WORK_VIEWS : group === "customers" ? CUSTOMER_VIEWS : null;

  return (
    <div className="toolbar reveal" style={{ animationDelay: "60ms" }}>
      <div className="toolbar-left">
        {/* Primary nav — four questions a PM asks, not seven artifacts. */}
        <div className="tabs">
          {PRIMARY_NAV.map((g) => (
            <button
              key={g.group}
              className={"tab" + (group === g.group ? " active" : "")}
              onClick={() => onTab(g.landing)}
            >
              <span className="tab-ico" dangerouslySetInnerHTML={{ __html: g.icon }} />
              {g.label}
            </button>
          ))}
        </div>
        {/* Secondary view toggle for the groups that hold more than one lens. */}
        {subTabs && (
          <div className="subtabs">
            {subTabs.map((v) => (
              <button
                key={v.tab}
                className={"subtab" + (tab === v.tab ? " active" : "")}
                onClick={() => onTab(v.tab)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        <HelpPopover tab={tab} />
        {showRoadmapControls && <GroupByDropdown config={config} onChange={onConfigChange} />}
        {showRoadmapControls && <RangeControl config={config} onChange={onConfigChange} />}
      </div>

      {showWorkspaceControls && (
        <div className="filters">
          <div className="search">
            <input placeholder="Search issues..." value={search} onChange={(e) => onSearch(e.target.value)} />
          </div>
          <button className={"chip" + (filter === "all" ? " active" : "")} data-filter="all" onClick={() => onFilter("all")}>
            All <span style={{ fontFamily: "var(--mono)", color: "inherit", opacity: 0.6 }}>{totalShown}</span>
          </button>
          <button className={"chip" + (filter === "mine" ? " active" : "")} data-filter="mine" onClick={() => onFilter("mine")}>
            Mine
          </button>
        </div>
      )}
    </div>
  );
}
