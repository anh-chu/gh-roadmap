import { useEffect, useRef, useState } from "react";
import type { EffortRating, FlowState } from "../../../shared/types";
import { FlowPill } from "./FlowPill";

interface Anchor {
  top: number;
  left: number;
}

const FLOW_STATES: Array<{ state: FlowState; label: string; description: string }> = [
  { state: "shipping", label: "Shipping", description: "Recently merged PR, or open PR approved with green CI." },
  { state: "in-review", label: "In review", description: "Review event on an open PR within the review window." },
  { state: "in-code", label: "In code", description: "Open non-draft PR with a recent commit." },
  { state: "discussing", label: "Discussing", description: "No open PRs, but recent issue comments." },
  { state: "stalled", label: "Stalled", description: "Has historical activity, but nothing recent." },
  { state: "cold", label: "Cold", description: "Open a long time with effectively no engagement." },
  { state: "fresh", label: "Fresh", description: "Newly created; not enough time to age yet." },
  { state: "closed", label: "Closed", description: "Issue is closed." },
];

const EFFORTS: Array<{ effort: EffortRating; label: string; description: string }> = [
  { effort: "lightning", label: "Lightning", description: "Quick / small." },
  { effort: "incremental", label: "Incremental", description: "Normal / standard." },
  { effort: "foundation", label: "Foundation", description: "Heavy / structural." },
];

const POP_WIDTH = 388;

function computeAnchor(button: HTMLButtonElement | null): Anchor {
  const rect = button?.getBoundingClientRect();
  if (!rect) return { top: 0, left: 0 };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = rect.bottom + 6;
  let left = rect.left;

  if (left + POP_WIDTH > vw - 8) left = Math.max(8, rect.right - POP_WIDTH);
  if (top + 320 > vh - 8) top = Math.max(8, rect.top - 6 - 320);

  return { top, left };
}

export function FlowLegendPopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const update = (): void => setAnchor(computeAnchor(buttonRef.current));
    update();

    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="flow-legend-wrap">
      <button
        ref={buttonRef}
        className="btn icon-only flow-legend-trigger"
        type="button"
        aria-label="Flow and effort legend"
        title="Flow and effort legend"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && anchor && (
        <div ref={popRef} className="popover flow-legend-pop" role="dialog" aria-label="Flow and effort legend" style={{ top: anchor.top, left: anchor.left, width: POP_WIDTH }}>
          <div className="pop-section">
            <div className="pop-label">Flow states</div>
            <div className="scope-help flow-legend-note">
              Deterministic rules assign flow; hover any pill to see evidence signals.
            </div>
            <div className="flow-legend-list">
              {FLOW_STATES.map(({ state, label, description }) => (
                <div key={state} className="flow-legend-item">
                  <FlowPill result={{ state, score: 0, signals: [] }} size="md" />
                  <div className="flow-legend-copy">
                    <div className="flow-legend-title">{label}</div>
                    <div className="flow-legend-desc">{description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-label">Effort labels</div>
            <div className="flow-legend-list">
              {EFFORTS.map(({ effort, label, description }) => (
                <div key={effort} className="flow-legend-item">
                  <span className={`effort-chip effort-${effort}`}>{effort}</span>
                  <div className="flow-legend-copy">
                    <div className="flow-legend-title">{label}</div>
                    <div className="flow-legend-desc">{description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pop-foot">
            <button className="pop-reset" type="button" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
