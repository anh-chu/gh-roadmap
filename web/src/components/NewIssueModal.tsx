import { useEffect, useRef, useState } from "react";
import type { ApiIssue } from "../../../shared/types";
import type { IssueCreatePayload } from "../lib/api";

interface NewIssueModalProps {
  open: boolean;
  knownAssignees: string[];
  currentUser: string | null;
  onClose: () => void;
  onCreate: (payload: IssueCreatePayload) => Promise<ApiIssue | null>;
  onCreated: (issue: ApiIssue) => void;
}

export function NewIssueModal(props: NewIssueModalProps): JSX.Element | null {
  const { open, knownAssignees, currentUser, onClose, onCreate, onCreated } = props;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  // Default to current user when available, else first known assignee, else empty.
  const defaultAssignee = currentUser ?? knownAssignees[0] ?? "";
  const [assignee, setAssignee] = useState<string>(defaultAssignee);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setLabels("");
    setAssignee(currentUser ?? knownAssignees[0] ?? "");
    setSubmitting(false);
    const id = window.setTimeout(() => titleRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open, currentUser, knownAssignees]);

  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const t = title.trim();
    if (!t || submitting) return;
    setSubmitting(true);

    const parsed = labels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set(parsed));

    const created = await onCreate({
      title: t,
      body: body.trim() || undefined,
      labels: merged,
      assignee: assignee || null,
    });
    setSubmitting(false);
    if (created) {
      onCreated(created);
    }
    onClose();
  };

  const assigneeOptions = Array.from(
    new Set([currentUser, ...knownAssignees].filter((x): x is string => Boolean(x))),
  );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal-card"
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
          <span className="modal-title">New issue</span>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Title</span>
            <input
              ref={titleRef}
              className="field-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the issue?"
            />
          </label>
          <label className="field">
            <span className="field-label">Body <span className="hint">markdown ok</span></span>
            <textarea
              className="field-input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Context, acceptance criteria, links..."
            />
          </label>
          <label className="field">
            <span className="field-label">Assignee</span>
            <select
              className="field-input"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">— unassigned —</option>
              {assigneeOptions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Labels <span className="hint">comma-separated, e.g. area:testops</span></span>
            <input
              className="field-input"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, customer-reported, area:testops"
            />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={submitting || !title.trim()}
          >
            {submitting ? "Creating..." : "Create issue"}
            <span className="kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
