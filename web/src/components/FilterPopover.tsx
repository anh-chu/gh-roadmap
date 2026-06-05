import { useEffect, useRef } from "react";

export type StateFilter = "all" | "open" | "closed";

export interface RichFilter {
  assignees: string[];
  state: StateFilter;
  labelQuery: string;
}

export const DEFAULT_RICH_FILTER: RichFilter = {
  assignees: [],
  state: "all",
  labelQuery: "",
};

export function isRichFilterActive(f: RichFilter): boolean {
  return f.assignees.length > 0 || f.state !== "all" || f.labelQuery.trim() !== "";
}

interface FilterPopoverProps {
  anchor: DOMRect | null;
  knownAssignees: string[];
  value: RichFilter;
  onChange: (next: RichFilter) => void;
  onClose: () => void;
}

export function FilterPopover(props: FilterPopoverProps): JSX.Element | null {
  const { anchor, knownAssignees, value, onChange, onClose } = props;
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
        <div className="pop-label">Label</div>
        <input
          className="pop-input"
          placeholder="filter by label substring"
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
