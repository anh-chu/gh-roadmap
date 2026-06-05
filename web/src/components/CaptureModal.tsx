import { useEffect, useRef, useState } from "react";
import type { ApiInsightDraft, InsightCapturePayload } from "../../../shared/types";

interface CaptureModalProps {
  open: boolean;
  onClose: () => void;
  onCapture: (payload: InsightCapturePayload) => Promise<ApiInsightDraft>;
  onCaptured: (draft: ApiInsightDraft) => void;
}

const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: "paste", label: "Paste" },
  { value: "gdoc", label: "Google Doc" },
  { value: "sheet", label: "Sheet" },
  { value: "slide", label: "Slide" },
  { value: "slack", label: "Slack" },
  { value: "jira", label: "Jira" },
  { value: "email", label: "Email" },
  { value: "other", label: "Other" },
];

export function CaptureModal(props: CaptureModalProps): JSX.Element | null {
  const { open, onClose, onCapture, onCaptured } = props;
  const [sourceType, setSourceType] = useState("paste");
  const [sourceUrl, setSourceUrl] = useState("");
  const [hint, setHint] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSourceType("paste");
    setSourceUrl("");
    setHint("");
    setRawText("");
    setSubmitting(false);
    setError(null);
    const id = window.setTimeout(() => rawRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const text = rawText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const draft = await onCapture({
        sourceType,
        sourceUrl: sourceUrl.trim() || undefined,
        rawText: text,
        hint: hint.trim() || undefined,
      });
      onCaptured(draft);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={() => !submitting && onClose()}>
      <div
        className="modal-card capture-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="modal-head">
          <span className="modal-title">Capture insight</span>
          <button className="close" onClick={onClose} disabled={submitting}>×</button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Source type</span>
            <select
              className="field-input"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
            >
              {SOURCE_TYPES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Source URL <span className="hint">optional</span></span>
            <input
              className="field-input"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://..."
            />
          </label>
          <label className="field">
            <span className="field-label">Hint <span className="hint">optional — what's this about</span></span>
            <input
              className="field-input"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="e.g. PwC POC feedback on TestOps reporting"
            />
          </label>
          <label className="field">
            <span className="field-label">Raw text</span>
            <textarea
              ref={rawRef}
              className="field-input raw-text"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={20}
              placeholder="Paste call notes, Slack thread, email, doc excerpt..."
            />
          </label>
          {error && <div className="insight-empty" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={submitting || !rawText.trim()}
          >
            {submitting ? "Extracting..." : "Capture & extract"}
            <span className="kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
