import { forwardRef, useEffect, useRef, useState } from "react";
import type { MetaResponse, WorkspaceConfig } from "../../../shared/types";

type AiConfigPatch = {
  aiModelSummary?: string | null;
  aiModelProgress?: string | null;
  aiModelExtract?: string | null;
  aiModelRelease?: string | null;
  aiMaxTokensPerRequest?: number;
  aiRateLimitRpm?: number;
  aiDailyTokenBudget?: number;
};

interface AiSettingsProps {
  config: WorkspaceConfig;
  envDefault: string | null;
  meta: MetaResponse | null;
  onChange: (patch: AiConfigPatch) => void;
}

export function AiSettings({ config, envDefault, meta, onChange }: AiSettingsProps): JSX.Element {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const hasOverride =
    !!config.aiModelSummary ||
    !!config.aiModelProgress ||
    !!config.aiModelExtract ||
    !!config.aiModelRelease;

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
        className={"btn" + (hasOverride ? " has-dot" : "")}
        onClick={handleOpen}
        title="AI model overrides per task"
      >
        <span>AI</span>
      </button>
      {open && anchor && (
        <AiPopover
          ref={popRef}
          anchor={anchor}
          config={config}
          envDefault={envDefault}
          meta={meta}
          onChange={onChange}
        />
      )}
    </>
  );
}

interface PopoverProps {
  anchor: DOMRect;
  config: WorkspaceConfig;
  envDefault: string | null;
  meta: MetaResponse | null;
  onChange: (patch: AiConfigPatch) => void;
}

interface RowProps {
  label: string;
  desc: string;
  value: string | null;
  envDefault: string | null;
  onCommit: (next: string | null) => void;
}

function AiModelRow({ label, desc, value, envDefault, onCommit }: RowProps): JSX.Element {
  const [draft, setDraft] = useState<string>(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === value) return;
    onCommit(next);
  };

  const clear = (): void => {
    setDraft("");
    if (value !== null) onCommit(null);
  };

  return (
    <div className="pop-section">
      <div className="pop-label">{label}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="tag-input"
          style={{ flex: 1 }}
          placeholder={envDefault ?? "(no env default — required)"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {value !== null && (
          <button
            onClick={clear}
            aria-label={`clear ${label} override`}
            title="Clear override (use env default)"
            className="tag-chip"
            style={{ cursor: "pointer" }}
          >
            ×
          </button>
        )}
      </div>
      <div className="scope-help" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>{desc}</div>
    </div>
  );
}

interface CostRowProps {
  label: string;
  desc: string;
  value: number;
  unit: string;
  onCommit: (next: number) => void;
}

// Numeric cost-control input. 0 = unlimited/uncapped. Commits a non-negative integer.
function CostRow({ label, desc, value, unit, onCommit }: CostRowProps): JSX.Element {
  const [draft, setDraft] = useState<string>(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (): void => {
    const n = Math.trunc(Number(draft));
    const next = Number.isFinite(n) && n >= 0 ? n : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="pop-section">
      <div className="pop-label">{label}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="tag-input"
          style={{ flex: 1 }}
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="scope-help" style={{ fontSize: 11, opacity: 0.7 }}>{unit}</span>
      </div>
      <div className="scope-help" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>{desc}</div>
    </div>
  );
}

function UsageLine({ label, used, limit }: { label: string; used: number; limit: number }): JSX.Element {
  const over = limit > 0 && used >= limit;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 11,
        opacity: over ? 1 : 0.8,
        color: over ? "var(--red, #c83c3c)" : undefined,
      }}
    >
      <span>{label}</span>
      <span>
        {used.toLocaleString()}
        {limit > 0 ? ` / ${limit.toLocaleString()}` : ""}
      </span>
    </div>
  );
}

// Read-only live usage meter (from /api/meta). Lines turn red when a limit is reached.
function UsageBlock({ meta }: { meta: MetaResponse | null }): JSX.Element {
  return (
    <div
      className="pop-section"
      style={{ borderTop: "1px solid var(--border, #e2e2e2)", marginTop: 4, paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div className="pop-label">Usage</div>
      {meta ? (
        <>
          <UsageLine label="Requests (last min)" used={meta.aiRequestsLastMinute} limit={meta.aiRateLimitRpm} />
          <UsageLine label="Tokens (today)" used={meta.aiTokensUsedToday} limit={meta.aiDailyTokenBudget} />
          <UsageLine label="Tokens (this month)" used={meta.aiTokensUsedThisMonth} limit={0} />
        </>
      ) : (
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.7 }}>—</div>
      )}
    </div>
  );
}
const AiPopover = forwardRef<HTMLDivElement, PopoverProps>(function AiPopover(
  { anchor, config, envDefault, meta, onChange },
  ref,
) {
  const envLabel = envDefault ?? "(unset)";

  return (
    <div
      ref={ref}
      className="popover scope-pop"
      style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right), minWidth: 320 }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">AI models</div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          Pick a model per task. Empty = use AI_MODEL env default (<code>{envLabel}</code>).
        </div>
      </div>
      <AiModelRow
        label="Summary"
        desc="Per-issue summary in drawer + hover"
        value={config.aiModelSummary}
        envDefault={envDefault}
        onCommit={(v) => onChange({ aiModelSummary: v })}
      />
      <AiModelRow
        label="Progress"
        desc="AI read on the Progress tab"
        value={config.aiModelProgress}
        envDefault={envDefault}
        onCommit={(v) => onChange({ aiModelProgress: v })}
      />
      <AiModelRow
        label="Insight extract"
        desc="Capture-to-draft AI in the Insights inbox"
        value={config.aiModelExtract}
        envDefault={envDefault}
        onCommit={(v) => onChange({ aiModelExtract: v })}
      />
      <AiModelRow
        label="Release notes"
        desc="Per-milestone release notes on the Milestones tab"
        value={config.aiModelRelease}
        envDefault={envDefault}
        onCommit={(v) => onChange({ aiModelRelease: v })}
      />
      <div className="pop-section" style={{ borderTop: "1px solid var(--border, #e2e2e2)", marginTop: 4, paddingTop: 8 }}>
        <div className="pop-label">Cost controls</div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          Per-workspace guardrails. <code>0</code> = unlimited. Daily budget resets at UTC midnight;
          once hit, AI requests return 503 until reset.
        </div>
      </div>
      <CostRow
        label="Max tokens / request"
        desc="Hard cap injected as max_tokens on every completion"
        value={config.aiMaxTokensPerRequest}
        unit="tokens"
        onCommit={(v) => onChange({ aiMaxTokensPerRequest: v })}
      />
      <CostRow
        label="Rate limit"
        desc="Max successful AI requests per minute (whole workspace)"
        value={config.aiRateLimitRpm}
        unit="req/min"
        onCommit={(v) => onChange({ aiRateLimitRpm: v })}
      />
      <CostRow
        label="Daily token budget"
        desc="Total tokens allowed per UTC day before AI hard-stops"
        value={config.aiDailyTokenBudget}
        unit="tokens/day"
        onCommit={(v) => onChange({ aiDailyTokenBudget: v })}
      />
      <UsageBlock meta={meta} />
    </div>
  );
});
