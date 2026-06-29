import { useEffect, useRef, useState } from "react";
import type { EffortRating, FlowState } from "../../../shared/types";
import { FlowPill } from "./FlowPill";
import { EffortChip } from "./EffortChip";
import type { TabKey } from "./Toolbar";

interface Anchor {
  top: number;
  left: number;
}

interface HelpSection {
  heading: string;
  body: string[];
  // Monospace lines rendered verbatim — the literal formula behind a number.
  formula?: string[];
}

interface HelpContent {
  title: string;
  intro: string;
  sections: HelpSection[];
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

// Plain-language orientation for new users. Keyed by tab; only the three
// surfaces that confuse newcomers carry content (roadmap / insights / progress).
// The flow + effort legend renders under every tab regardless.
const HELP: Partial<Record<TabKey, HelpContent>> = {
  roadmap: {
    title: "Reading the roadmap",
    intro:
      "Each card is a GitHub issue. Where a card sits tells you when it is planned for and which area it belongs to.",
    sections: [
      {
        heading: "Columns are time",
        body: [
          "The columns across the top are time buckets — weeks, months, or quarters (switch in the View control).",
          "A card lands under a column because someone gave it a planned week or planned month here.",
          "TODO and Backlog are holding columns, not dates: TODO is flagged-but-unscheduled, Backlog is everything else with no plan yet.",
        ],
      },
      {
        heading: "Your plan vs the GitHub milestone",
        body: [
          "The column position is your plan (planned week / month). It lives only in this tool and is never written back to GitHub.",
          "GitHub milestones carry their own due date — that is the team's committed release date. The board lines your plan up against it and flags any disagreement right on the card.",
          "⚠ with a date = drift: the milestone is due in a different column than where you parked the card. 'no milestone' = you planned it but it is not attached to any milestone yet. No chip = the plan and the milestone agree.",
        ],
      },
      {
        heading: "Rows are the area",
        body: [
          "The rows group cards by a label prefix (default area:*), or by assignee or milestone — your choice in Group by.",
          "Set Group by to None and the rows collapse to a single track.",
        ],
      },
      {
        heading: "Dragging a card",
        body: [
          "Drag across columns to reschedule — that updates the in-tool plan only.",
          "Drag across rows when grouping by label and it writes the area label back to GitHub. Every other move stays local.",
        ],
      },
    ],
  },
  insights: {
    title: "How insights work",
    intro:
      "An insight is something you heard from a customer, captured once and then linked to the issues and accounts it touches.",
    sections: [
      {
        heading: "Where they come from",
        body: [
          "Insights are markdown files in the product repo's insights/ folder. This tool mirrors them read-only on each sync — no local checkout.",
          "The Inbox at the top holds drafts you have captured but not yet published.",
        ],
      },
      {
        heading: "The capture loop",
        body: [
          "Capture a raw note (paste modal, or the API). AI extracts the fields and a body draft, and it lands in the Inbox.",
          "Edit the draft, then Publish — that opens a pull request on the product repo. Merge it (in-app or on GitHub).",
          "The next sync reads the merged file and it shows up here as a real insight.",
        ],
      },
      {
        heading: "What linking does",
        body: [
          "An insight links to issues (what to build) and accounts (who asked). Links come from the file's frontmatter or #123 mentions in the body.",
          "Those links surface on issue cards (📎 N), bump at-risk severity, and feed the account timelines.",
        ],
      },
    ],
  },
  progress: {
    title: "Reading the progress page",
    intro:
      "A PM lens on today: what needs a nudge right now. Not a velocity dashboard — no burndown or cycle time here.",
    sections: [
      {
        heading: "Verdict + AI Read",
        body: [
          "The top line is a one-glance verdict. Below it, the AI Read is a written summary of where things stand, regenerated on demand.",
        ],
      },
      {
        heading: "Needs you now (at-risk)",
        body: [
          "The primary list: planned or TODO items that look stuck. Backlog items are deliberately left out — they are not committed yet.",
          "An item with no linked PR and no recent events is filed as low-signal rather than a hard stall, so genuine stalls stay visible.",
        ],
      },
      {
        heading: "Schedule % — the formula",
        body: [
          "The headline. Of every committed item (has a planned week or month), the share that is tracking to its date:",
          "An item counts as on-schedule when it is in the future with runway (unless it has gone cold), or due now AND actively moving. Overdue, or due-now-but-not-moving, counts against.",
        ],
        formula: ["on-time % = on-schedule items / committed items × 100", "moving = shipping · in-review · in-code"],
      },
      {
        heading: "Momentum — the formula",
        body: [
          "Secondary, and ship-probability based. Each flow state maps to a probability the work ships; momentum is the average across items that have real signal (a linked PR, event, or comment). Items with no signal are excluded and shown as 'no signal'.",
        ],
        formula: [
          "momentum = mean(ship-prob of judged items) × 100",
          "shipping .95 · in-review .90 · in-code .75",
          "discussing/fresh .50 · stalled .20 · cold .10",
        ],
      },
    ],
  },
};

const POP_WIDTH = 384;

function computeAnchor(button: HTMLButtonElement | null): Anchor {
  const rect = button?.getBoundingClientRect();
  if (!rect) return { top: 0, left: 0 };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = rect.bottom + 6;
  let left = rect.left;

  if (left + POP_WIDTH > vw - 8) left = Math.max(8, rect.right - POP_WIDTH);
  if (top + 380 > vh - 8) top = Math.max(8, rect.top - 6 - 380);

  return { top, left };
}

export function HelpPopover({ tab }: { tab: TabKey }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const content = HELP[tab];

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

  const title = content?.title ?? "Flow & effort legend";

  return (
    <div className="flow-legend-wrap">
      <button
        ref={buttonRef}
        className="btn icon-only flow-legend-trigger"
        type="button"
        aria-label={title}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && anchor && (
        <div
          ref={popRef}
          className="popover help-pop"
          role="dialog"
          aria-label={title}
          style={{ top: anchor.top, left: anchor.left, width: POP_WIDTH }}
        >
          {content && (
            <>
              <div className="pop-section">
                <div className="pop-label">{content.title}</div>
                <div className="scope-help help-intro">{content.intro}</div>
              </div>
              {content.sections.map((s) => (
                <div key={s.heading} className="pop-section">
                  <div className="help-heading">{s.heading}</div>
                  {s.body.map((p, i) => (
                    <p key={i} className="help-para">
                      {p}
                    </p>
                  ))}
                  {s.formula && (
                    <div className="help-formula">
                      {s.formula.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
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
                  <EffortChip effort={effort} source="label" display="bars" />
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
