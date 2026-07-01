import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiInsightDraft, InsightDraftPatch } from "../../../shared/types";

interface InsightDraftEditorProps {
  draft: ApiInsightDraft | null;
  onClose: () => void;
  onPatch: (id: number, patch: InsightDraftPatch) => Promise<ApiInsightDraft>;
  onPublish: (id: number) => Promise<ApiInsightDraft>;
  onDiscard: (id: number) => Promise<ApiInsightDraft>;
  onRegenerate: (id: number) => Promise<ApiInsightDraft>;
  onToast: (msg: string) => void;
}

const TYPE_OPTIONS = ["customer", "data", "competitive", "support", "survey", "market"];
const CONFIDENCE_OPTIONS = ["verified", "likely", "rumor"];

const AUTOSAVE_MS = 800;

export function InsightDraftEditor(props: InsightDraftEditorProps): JSX.Element {
  const { draft, onClose, onPatch, onPublish, onDiscard, onRegenerate, onToast } = props;
  const open = draft !== null;

  // Local form state; reset whenever a new draft loads.
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [confidence, setConfidence] = useState<string>("");
  const [accountsText, setAccountsText] = useState("");
  const [relatedText, setRelatedText] = useState("");
  const [keyQuotesText, setKeyQuotesText] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [previewBody, setPreviewBody] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  // Reset when draft changes.
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title ?? "");
    setType(draft.type ?? "");
    setDate(draft.date ?? "");
    setOwner(draft.owner ?? "");
    setConfidence(draft.confidence ?? "");
    setAccountsText(draft.accounts.join(", "));
    setRelatedText(draft.relatedIssues.join(", "));
    setKeyQuotesText(draft.keyQuotes.join("\n"));
    setBodyDraft(draft.bodyDraft ?? "");
    setPreviewBody(false);
    setShowRaw(false);
    setConfirmDiscard(false);
    setPublishing(false);
    setPublishError(null);
    setPrUrl(null);
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !publishing) onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose, publishing]);

  const parseAccounts = (s: string): string[] =>
    [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];
  const parseRelated = (s: string): number[] => {
    const out: number[] = [];
    for (const t of s.split(/[\s,]+/)) {
      const n = Number(t.replace(/^#/, ""));
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
    return [...new Set(out)];
  };
  const parseQuotes = (s: string): string[] =>
    s.split("\n").map((x) => x.trim()).filter(Boolean);

  // Debounced autosave on any change.
  const dirtyTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>("");
  const buildPatch = useMemo(
    () =>
      (): InsightDraftPatch | null => {
        if (!draft) return null;
        return {
          title: title.trim() || null,
          type: type || null,
          date: date || null,
          owner: owner.trim() || null,
          confidence: confidence || null,
          accounts: parseAccounts(accountsText),
          relatedIssues: parseRelated(relatedText),
          keyQuotes: parseQuotes(keyQuotesText),
          bodyDraft: bodyDraft || null,
        };
      },
    [draft, title, type, date, owner, confidence, accountsText, relatedText, keyQuotesText, bodyDraft],
  );

  useEffect(() => {
    if (!draft) return;
    const p = buildPatch();
    if (!p) return;
    const key = JSON.stringify(p);
    if (key === lastSaved.current) return;
    if (dirtyTimer.current) window.clearTimeout(dirtyTimer.current);
    dirtyTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          await onPatch(draft.id, p);
          lastSaved.current = key;
        } catch (err) {
          onToast(err instanceof Error ? err.message : "Save failed");
        }
      })();
    }, AUTOSAVE_MS);
    return () => {
      if (dirtyTimer.current) window.clearTimeout(dirtyTimer.current);
    };
  }, [draft, buildPatch, onPatch, onToast]);

  // When draft.id changes, seed lastSaved so autosave doesn't fire immediately.
  useEffect(() => {
    if (!draft) return;
    lastSaved.current = JSON.stringify(buildPatch());
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canPublish =
    !!draft && title.trim() !== "" && type !== "" && date !== "" && bodyDraft.trim() !== "";

  const doPublish = async (): Promise<void> => {
    if (!draft || publishing) return;
    // Flush pending autosave before publishing.
    const p = buildPatch();
    if (p) {
      try {
        await onPatch(draft.id, p);
        lastSaved.current = JSON.stringify(p);
      } catch (err) {
        setPublishError(err instanceof Error ? err.message : "Save failed");
        return;
      }
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const updated = await onPublish(draft.id);
      setPrUrl(updated.prUrl);
      onToast(`PR opened: ${updated.prUrl ?? "published"}`);
      window.setTimeout(() => onClose(), 1000);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const doDiscard = async (): Promise<void> => {
    if (!draft) return;
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    try {
      await onDiscard(draft.id);
      onToast("Discarded");
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Discard failed");
    }
  };

  const doRegenerate = async (): Promise<void> => {
    if (!draft || regenerating) return;
    const ok = window.confirm(
      "Regenerate will replace title, type, accounts, related issues, key quotes, and body. Your manual edits to those fields will be overwritten. Continue?",
    );
    if (!ok) return;
    setRegenerating(true);
    try {
      const updated = await onRegenerate(draft.id);
      // Reflect new extracted fields immediately; preserve user-edited date/owner from server response.
      setTitle(updated.title ?? "");
      setType(updated.type ?? "");
      setConfidence(updated.confidence ?? "");
      setAccountsText(updated.accounts.join(", "));
      setRelatedText(updated.relatedIssues.join(", "));
      setKeyQuotesText(updated.keyQuotes.join("\n"));
      setBodyDraft(updated.bodyDraft ?? "");
      // Seed lastSaved so autosave doesn't immediately fire from these state changes.
      lastSaved.current = JSON.stringify({
        title: updated.title,
        type: updated.type,
        date: updated.date,
        owner: updated.owner,
        confidence: updated.confidence,
        accounts: updated.accounts,
        relatedIssues: updated.relatedIssues,
        keyQuotes: updated.keyQuotes,
        bodyDraft: updated.bodyDraft,
      });
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} aria-hidden />}
      <aside className={"drawer insight-drawer insight-draft-editor" + (open ? " open" : "")}>
        {open && draft && (
          <>
            <div className="d-head">
              <div className="row1">
                <span className="d-num">Draft #{draft.id}</span>
                <span className="insight-draft-source-chip">{draft.sourceType}</span>
                <button
                  className="ai-refresh-btn"
                  onClick={() => void doRegenerate()}
                  disabled={publishing || regenerating}
                  type="button"
                  aria-label="Regenerate"
                  title="Regenerate — re-run AI extraction (overwrites title, type, accounts, related issues, key quotes, body)"
                  style={{ marginLeft: "auto" }}
                >
                  <span className={"ai-refresh-icon" + (regenerating ? " spinning" : "")}>⟳</span>
                  {regenerating ? " regenerating…" : " Regenerate"}
                </button>
                <button className="close" onClick={onClose} disabled={publishing}>×</button>
              </div>
              <input
                className="field-input insight-draft-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title — what this insight is"
              />
            </div>
            <div className="d-body insight-draft-editor-body">
              {draft.dupKind && (
                <div className="insight-dup-banner" role="status">
                  ⚠ Likely duplicate —{" "}
                  {draft.dupKind === "exact"
                    ? `same text was already captured as draft #${draft.dupOf}.`
                    : `${draft.dupScore}% similar to draft #${draft.dupOf} (same source).`}{" "}
                  Review before publishing, or discard if redundant.
                </div>
              )}
              <div className="insight-draft-fields">
                <div className="insight-draft-field-row">
                  <label className="insight-draft-field">
                    <span className="field-label">Type</span>
                    <select
                      className="field-input"
                      value={type}
                      onChange={(e) => setType(e.target.value)}
                    >
                      <option value="">—</option>
                      {TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="insight-draft-field">
                    <span className="field-label">Date</span>
                    <input
                      type="date"
                      className="field-input"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                  <label className="insight-draft-field">
                    <span className="field-label">Confidence</span>
                    <select
                      className="field-input"
                      value={confidence}
                      onChange={(e) => setConfidence(e.target.value)}
                    >
                      <option value="">—</option>
                      {CONFIDENCE_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="insight-draft-field">
                  <span className="field-label">Owner</span>
                  <input
                    className="field-input"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="@handle"
                  />
                </label>
                <label className="insight-draft-field">
                  <span className="field-label">Captured by</span>
                  <input className="field-input" value={draft.capturedBy ?? "unknown"} disabled readOnly />
                </label>
                <label className="insight-draft-field">
                  <span className="field-label">Accounts <span className="hint">comma-separated</span></span>
                  <input
                    className="field-input"
                    value={accountsText}
                    onChange={(e) => setAccountsText(e.target.value)}
                    placeholder="PwC, Acme Corp"
                  />
                </label>
                <label className="insight-draft-field">
                  <span className="field-label">Related issues <span className="hint">numbers, comma-separated</span></span>
                  <input
                    className="field-input"
                    value={relatedText}
                    onChange={(e) => setRelatedText(e.target.value)}
                    placeholder="1234, 5678"
                  />
                </label>
                <label className="insight-draft-field">
                  <span className="field-label">Key quotes <span className="hint">one per line</span></span>
                  <textarea
                    className="field-input"
                    value={keyQuotesText}
                    onChange={(e) => setKeyQuotesText(e.target.value)}
                    rows={3}
                    placeholder="verbatim quote with optional attribution"
                  />
                </label>
              </div>

              <div className="insight-draft-body-section">
                <div className="insight-draft-body-head">
                  <span className="field-label">Body</span>
                  <button
                    className="chip"
                    onClick={() => setPreviewBody((p) => !p)}
                    type="button"
                  >
                    {previewBody ? "Edit" : "Preview"}
                  </button>
                </div>
                {previewBody ? (
                  <div className="d-desc insight-draft-body-preview">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {bodyDraft || "_(empty)_"}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    className="field-input insight-draft-body-textarea"
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    rows={16}
                    placeholder="## Context...&#10;## What we found...&#10;## Why it matters...&#10;## Next steps..."
                  />
                )}
              </div>

              <details className="insight-draft-raw" open={showRaw} onToggle={(e) => setShowRaw((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Original captured content</summary>
                <pre className="insight-draft-raw-pre">{draft.rawText}</pre>
                {draft.sourceUrl && (
                  <div className="insight-draft-raw-meta">
                    Source: <a href={draft.sourceUrl} target="_blank" rel="noreferrer">{draft.sourceUrl}</a>
                  </div>
                )}
                {draft.hint && (
                  <div className="insight-draft-raw-meta">Hint: {draft.hint}</div>
                )}
              </details>

              {publishError && (
                <div className="insight-empty" role="alert" style={{ marginTop: 12 }}>
                  {publishError}
                </div>
              )}
              {prUrl && (
                <div className="insight-empty" style={{ marginTop: 12 }}>
                  Published: <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
                </div>
              )}
            </div>

            <div className="modal-foot insight-draft-foot">
              <button
                className="btn"
                onClick={() => void doDiscard()}
                disabled={publishing}
                style={{ marginRight: "auto" }}
              >
                {confirmDiscard ? "Click again to confirm" : "Discard"}
              </button>
              <button className="btn" onClick={onClose} disabled={publishing}>Close</button>
              <button
                className="btn primary"
                onClick={() => void doPublish()}
                disabled={!canPublish || publishing}
                title={!canPublish ? "Title, type, date, and body are required" : "Open a PR with this insight"}
              >
                {publishing ? "Publishing..." : "Publish PR"}
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
