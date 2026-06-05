import { forwardRef, useEffect, useRef, useState } from "react";
import type { WorkspaceConfig } from "../../../shared/types";

const LABEL_RE = /^[a-zA-Z0-9:_-]{1,32}$/;
const MAX_ENTRIES = 20;

interface ScopePillProps {
  config: WorkspaceConfig;
  onChange: (patch: { masterFilterInclude?: string[]; masterFilterExclude?: string[] }) => void;
}

function summarise(include: string[], exclude: string[]): { text: string; faded: boolean } {
  if (include.length === 0 && exclude.length === 0) return { text: "Scope: all", faded: true };
  const parts: string[] = [];
  if (include.length > 0) {
    parts.push(include[0] + (include.length > 1 ? ` +${include.length - 1}` : ""));
  }
  if (exclude.length > 0) {
    parts.push("− " + exclude[0] + (exclude.length > 1 ? ` +${exclude.length - 1}` : ""));
  }
  return { text: "Scope: " + parts.join(" "), faded: false };
}

export function ScopePill({ config, onChange }: ScopePillProps): JSX.Element {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const include = config.masterFilterInclude;
  const exclude = config.masterFilterExclude;
  const { text, faded } = summarise(include, exclude);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  const handleOpen = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        className={"scope-pill" + (faded ? " faded" : "")}
        onClick={handleOpen}
        title="Workspace label scope — applied to every issue, count, and aggregation"
      >
        {text}
      </button>
      {open && anchor && (
        <ScopePopover
          ref={popRef}
          anchor={anchor}
          include={include}
          exclude={exclude}
          onChange={onChange}
        />
      )}
    </>
  );
}

interface PopoverProps {
  anchor: DOMRect;
  include: string[];
  exclude: string[];
  onChange: (patch: { masterFilterInclude?: string[]; masterFilterExclude?: string[] }) => void;
}

const ScopePopover = forwardRef<HTMLDivElement, PopoverProps>(function ScopePopover(
  { anchor, include, exclude, onChange },
  ref,
) {
  const [incDraft, setIncDraft] = useState("");
  const [excDraft, setExcDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addTag = (kind: "include" | "exclude", raw: string): void => {
    const v = raw.trim();
    if (!v) return;
    if (!LABEL_RE.test(v)) {
      setError("Label must be 1–32 chars, alphanumeric + : _ -");
      return;
    }
    const list = kind === "include" ? include : exclude;
    if (list.includes(v)) {
      setError("Already added");
      return;
    }
    if (list.length >= MAX_ENTRIES) {
      setError(`Max ${MAX_ENTRIES} entries`);
      return;
    }
    setError(null);
    const next = [...list, v];
    onChange(kind === "include" ? { masterFilterInclude: next } : { masterFilterExclude: next });
    if (kind === "include") setIncDraft("");
    else setExcDraft("");
  };

  const removeTag = (kind: "include" | "exclude", v: string): void => {
    const list = kind === "include" ? include : exclude;
    const next = list.filter((x) => x !== v);
    onChange(kind === "include" ? { masterFilterInclude: next } : { masterFilterExclude: next });
  };

  const reset = (): void => {
    onChange({ masterFilterInclude: [], masterFilterExclude: [] });
    setError(null);
  };

  const hasAny = include.length > 0 || exclude.length > 0;

  return (
    <div
      ref={ref}
      className="popover scope-pop"
      style={{ top: anchor.bottom + 6, left: anchor.left }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">Scope filter · Include (AND)</div>
        <div className="tag-row">
          {include.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button onClick={() => removeTag("include", t)} aria-label={`remove ${t}`}>×</button>
            </span>
          ))}
        </div>
        <input
          className="tag-input"
          placeholder="add label, Enter to add"
          value={incDraft}
          onChange={(e) => setIncDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag("include", incDraft);
            }
          }}
        />
      </div>
      <div className="pop-section">
        <div className="pop-label">Exclude (NONE)</div>
        <div className="tag-row">
          {exclude.map((t) => (
            <span key={t} className="tag-chip exclude">
              {t}
              <button onClick={() => removeTag("exclude", t)} aria-label={`remove ${t}`}>×</button>
            </span>
          ))}
        </div>
        <input
          className="tag-input"
          placeholder="add label, Enter to add"
          value={excDraft}
          onChange={(e) => setExcDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag("exclude", excDraft);
            }
          }}
        />
      </div>
      <div className="pop-section scope-help">
        {error ? (
          <span style={{ color: "var(--r)" }}>{error}</span>
        ) : (
          <span>Issues outside this scope are hidden everywhere — counts, progress, drag-drop.</span>
        )}
      </div>
      {hasAny && (
        <div className="pop-foot">
          <button className="pop-reset" onClick={reset}>Reset to default</button>
        </div>
      )}
    </div>
  );
});
