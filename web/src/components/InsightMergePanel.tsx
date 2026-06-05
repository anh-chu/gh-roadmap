import { useState } from "react";
import type {
  ApiInsightDraft,
  ApiInsightListItem,
  InsightMergePayload,
  InsightMergePreview,
} from "../../../shared/types";

interface InsightMergePanelProps {
  // Candidate published insights (survivor + victim choices).
  insights: ApiInsightListItem[];
  // Pending drafts available to fold in as victims.
  drafts: ApiInsightDraft[];
  // Drawer mode: survivor is this insight (radio hidden).
  fixedSurvivorSlug?: string;
  // Inbox mode: this draft must be folded in (checkbox locked on).
  fixedVictimDraftId?: number;
  // Synthesize the consolidated preview (AI or mechanical) without opening a PR.
  onPrepare: (payload: InsightMergePayload) => Promise<InsightMergePreview>;
  // Open the merge PR with the (edited) preview content.
  onConfirm: (payload: InsightMergePayload) => Promise<void>;
  onCancel: () => void;
}

const TYPE_OPTIONS = ["customer", "data", "competitive", "support", "survey", "market"];
const CONFIDENCE_OPTIONS = ["verified", "likely", "rumor"];

// Two steps: (1) pick survivor + victims, (2) review/edit the AI-synthesized consolidation,
// then open the PR. Reused by the Insights drawer (survivor fixed) and Inbox (draft victim fixed).
export function InsightMergePanel({
  insights,
  drafts,
  fixedSurvivorSlug,
  fixedVictimDraftId,
  onPrepare,
  onConfirm,
  onCancel,
}: InsightMergePanelProps): JSX.Element {
  const [step, setStep] = useState<"pick" | "preview">("pick");
  const [survivorSlug, setSurvivorSlug] = useState<string>(fixedSurvivorSlug ?? "");
  const [victimPaths, setVictimPaths] = useState<string[]>([]);
  const [victimDraftIds, setVictimDraftIds] = useState<number[]>(
    fixedVictimDraftId ? [fixedVictimDraftId] : [],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Editable preview content (step 2).
  const [preview, setPreview] = useState<InsightMergePreview | null>(null);

  const toggleVictimPath = (p: string): void =>
    setVictimPaths((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const toggleVictimDraft = (id: number): void => {
    if (id === fixedVictimDraftId) return; // locked on
    setVictimDraftIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const victimCount = victimPaths.length + victimDraftIds.length;
  const basePayload = (): InsightMergePayload => ({ survivorSlug, victimPaths, victimDraftIds });

  const doPrepare = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const p = await onPrepare(basePayload());
      setPreview(p);
      setStep("preview");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm({
        ...basePayload(),
        title: preview.title ?? undefined,
        type: preview.type ?? undefined,
        confidence: preview.confidence ?? undefined,
        accounts: preview.accounts,
        relatedIssues: preview.relatedIssues,
        body: preview.body ?? undefined,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Merge failed");
      setBusy(false);
    }
  };

  const setField = <K extends keyof InsightMergePreview>(k: K, v: InsightMergePreview[K]): void =>
    setPreview((cur) => (cur ? { ...cur, [k]: v } : cur));

  if (step === "preview" && preview) {
    return (
      <div className="insight-merge-panel">
        <div className="insight-merge-title">
          Review merge
          <span className="insight-merge-ai-tag">AI-synthesized</span>
        </div>

        <label className="insight-merge-field">
          <span>Title</span>
          <input
            type="text"
            value={preview.title ?? ""}
            onChange={(e) => setField("title", e.target.value)}
          />
        </label>

        <div className="insight-merge-field-row">
          <label className="insight-merge-field">
            <span>Type</span>
            <select value={preview.type ?? ""} onChange={(e) => setField("type", e.target.value)}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="insight-merge-field">
            <span>Confidence</span>
            <select
              value={preview.confidence ?? ""}
              onChange={(e) => setField("confidence", e.target.value)}
            >
              {CONFIDENCE_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="insight-merge-field">
          <span>Accounts (comma-separated)</span>
          <input
            type="text"
            value={preview.accounts.join(", ")}
            onChange={(e) =>
              setField(
                "accounts",
                e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </label>

        <label className="insight-merge-field">
          <span>Related issues (comma-separated numbers)</span>
          <input
            type="text"
            value={preview.relatedIssues.join(", ")}
            onChange={(e) =>
              setField(
                "relatedIssues",
                e.target.value
                  .split(",")
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isInteger(n) && n > 0),
              )
            }
          />
        </label>

        <label className="insight-merge-field">
          <span>Body</span>
          <textarea
            className="insight-merge-body"
            value={preview.body ?? ""}
            onChange={(e) => setField("body", e.target.value)}
            rows={14}
          />
        </label>

        {err && (
          <div className="insight-merge-error" role="alert">
            {err}
          </div>
        )}
        <div className="insight-merge-foot">
          <button className="btn" onClick={() => setStep("pick")} disabled={busy}>
            Back
          </button>
          <button className="btn" onClick={() => void doPrepare()} disabled={busy}>
            {busy ? "…" : "Regenerate"}
          </button>
          <button className="btn primary" onClick={() => void doConfirm()} disabled={busy}>
            {busy ? "Opening PR…" : "Open merge PR"}
          </button>
        </div>
      </div>
    );
  }

  const canNext = !!survivorSlug && victimCount > 0 && !busy;

  return (
    <div className="insight-merge-panel">
      <div className="insight-merge-title">Merge insights</div>

      {!fixedSurvivorSlug && (
        <div className="insight-merge-section">
          <div className="insight-merge-label">Keep (survivor)</div>
          <div className="insight-merge-list">
            {insights.map((i) => (
              <label key={i.path} className="insight-merge-opt">
                <input
                  type="radio"
                  name="insight-merge-survivor"
                  checked={survivorSlug === i.slug}
                  onChange={() => {
                    setSurvivorSlug(i.slug);
                    setVictimPaths((cur) => cur.filter((p) => p !== i.path));
                  }}
                />
                <span className="insight-merge-opt-title">{i.title}</span>
                {i.date && <span className="insight-merge-date">{i.date}</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="insight-merge-section">
        <div className="insight-merge-label">Fold in &amp; remove (victims)</div>
        <div className="insight-merge-list">
          {insights
            .filter((i) => i.slug !== survivorSlug)
            .map((i) => (
              <label key={i.path} className="insight-merge-opt">
                <input
                  type="checkbox"
                  checked={victimPaths.includes(i.path)}
                  onChange={() => toggleVictimPath(i.path)}
                />
                <span className="insight-merge-opt-title">{i.title}</span>
                {i.date && <span className="insight-merge-date">{i.date}</span>}
              </label>
            ))}
          {drafts.map((d) => (
            <label key={`d${d.id}`} className="insight-merge-opt">
              <input
                type="checkbox"
                checked={victimDraftIds.includes(d.id)}
                disabled={d.id === fixedVictimDraftId}
                onChange={() => toggleVictimDraft(d.id)}
              />
              <span className="insight-merge-draft-tag">draft</span>
              <span className="insight-merge-opt-title">{d.title || "untitled"}</span>
            </label>
          ))}
          {insights.length === 0 && drafts.length === 0 && (
            <div className="insight-merge-empty">Nothing else to merge.</div>
          )}
        </div>
      </div>

      {err && (
        <div className="insight-merge-error" role="alert">
          {err}
        </div>
      )}
      <div className="insight-merge-foot">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void doPrepare()} disabled={!canNext}>
          {busy ? "Synthesizing…" : `Next: preview${victimCount > 0 ? ` (${victimCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
