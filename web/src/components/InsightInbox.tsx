import { useEffect, useState } from "react";
import type {
  ApiInsightDraft,
  ApiInsightListItem,
  ApiInsightOp,
  InsightMergePayload,
  InsightMergePreview,
} from "../../../shared/types";
import { InsightMergePanel } from "./InsightMergePanel";
import { getCaptureToken } from "../lib/api";

interface InsightInboxProps {
  drafts: ApiInsightDraft[];
  published: ApiInsightDraft[];
  // Published insights (survivor candidates) + open delete/merge ops.
  insights: ApiInsightListItem[];
  ops: ApiInsightOp[];
  loading: boolean;
  error: string | null;
  onOpen: (draft: ApiInsightDraft) => void;
  onDiscard: (id: number) => void;
  onMerge: (id: number) => Promise<void>;
  // Abandon a published draft's open PR (close + delete branch); draft returns to pending.
  onClosePr: (id: number) => Promise<void>;
  // Synthesize the consolidated merge preview (AI or mechanical).
  onPrepareMerge: (payload: InsightMergePayload) => Promise<InsightMergePreview>;
  // Fold a draft (and optionally other victims) into a survivor insight.
  onMergeInsights: (payload: InsightMergePayload) => Promise<void>;
  // Squash-merge an open delete/merge op's PR.
  onApproveOp: (id: number) => Promise<void>;
  // Abandon an open op's PR (close + delete branch).
  onCloseOp: (id: number) => Promise<void>;
  onCapture: () => void;
}

function ageLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function InsightInbox(props: InsightInboxProps): JSX.Element {
  const {
    drafts,
    published,
    insights,
    ops,
    loading,
    error,
    onOpen,
    onDiscard,
    onMerge,
    onClosePr,
    onPrepareMerge,
    onMergeInsights,
    onApproveOp,
    onCloseOp,
    onCapture,
  } = props;
  const count = drafts.length;
  const [showApi, setShowApi] = useState(false);
  const [mergingId, setMergingId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [mergeError, setMergeError] = useState<{ id: number; msg: string } | null>(null);
  const [mergeDraftId, setMergeDraftId] = useState<number | null>(null);
  const [opBusyId, setOpBusyId] = useState<number | null>(null);
  const [opError, setOpError] = useState<{ id: number; msg: string } | null>(null);

  const doMerge = async (id: number): Promise<void> => {
    setMergingId(id);
    setMergeError(null);
    try {
      await onMerge(id);
    } catch (err) {
      setMergeError({ id, msg: err instanceof Error ? err.message : "Merge failed" });
    } finally {
      setMergingId(null);
    }
  };

  const doClosePr = async (id: number): Promise<void> => {
    if (!window.confirm("Close this PR on GitHub and return the draft to pending? The branch is deleted.")) return;
    setClosingId(id);
    setMergeError(null);
    try {
      await onClosePr(id);
    } catch (err) {
      setMergeError({ id, msg: err instanceof Error ? err.message : "Close failed" });
    } finally {
      setClosingId(null);
    }
  };

  const doApproveOp = async (id: number): Promise<void> => {
    setOpBusyId(id);
    setOpError(null);
    try {
      await onApproveOp(id);
    } catch (err) {
      setOpError({ id, msg: err instanceof Error ? err.message : "Merge failed" });
    } finally {
      setOpBusyId(null);
    }
  };

  const doCloseOp = async (id: number): Promise<void> => {
    if (!window.confirm("Close this PR on GitHub and delete its branch? The op is abandoned.")) return;
    setOpBusyId(id);
    setOpError(null);
    try {
      await onCloseOp(id);
    } catch (err) {
      setOpError({ id, msg: err instanceof Error ? err.message : "Close failed" });
    } finally {
      setOpBusyId(null);
    }
  };

  return (
    <section className="insight-inbox">
      <div className="insight-inbox-head">
        <span className="insight-inbox-title">
          Inbox <span className="insight-group-count">· {count} pending</span>
        </span>
        <span className="insight-inbox-actions">
          <button
            className="btn ghost-link"
            onClick={() => setShowApi(true)}
            title="Programmatic capture (curl + agent)"
          >
            {"</>"} API
          </button>
          <button className="btn primary" onClick={onCapture}>+ Capture</button>
        </span>
      </div>
      {error && <div className="insight-empty" role="alert">{error}</div>}
      {!error && loading && count === 0 && (
        <div className="insight-inbox-empty">Loading…</div>
      )}
      {!error && !loading && count === 0 && (
        <div className="insight-inbox-empty insight-inbox-empty-compact">Inbox empty. Click + Capture to add.</div>
      )}
      {drafts.map((d) => (
        <div key={d.id} className="insight-draft-block">
        <div
          className="insight-draft-row"
          onClick={() => onOpen(d)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(d);
            }
          }}
        >
          <span className="insight-draft-source-chip">{d.sourceType}</span>
          <span className="insight-draft-age">{ageLabel(d.createdAt)}</span>
          <span className="insight-draft-title">{d.title || "untitled"}</span>

          {d.capturedBy && <span className="insight-row-owner">Captured by {d.capturedBy}</span>}
          {d.dupKind && (
            <span
              className="insight-dup-badge"
              title={
                d.dupKind === "exact"
                  ? `Same text already captured as draft #${d.dupOf}`
                  : `${d.dupScore}% similar to draft #${d.dupOf} (same source)`
              }
            >
              ⚠ {d.dupKind === "exact" ? "dup of" : `${d.dupScore}% like`} #{d.dupOf}
            </span>
          )}
          {d.accounts.length > 0 && (
            <span className="insight-draft-accounts">
              {d.accounts.slice(0, 3).map((a) => (
                <span key={a} className="insight-account-chip">{a}</span>
              ))}
              {d.accounts.length > 3 && (
                <span className="insight-issue-more">+{d.accounts.length - 3}</span>
              )}
            </span>
          )}
          <span className="insight-draft-actions">
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d);
              }}
            >
              Open
            </button>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                setMergeDraftId((cur) => (cur === d.id ? null : d.id));
              }}
              title="Fold this draft into a published insight"
            >
              {mergeDraftId === d.id ? "Close" : "Merge…"}
            </button>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                onDiscard(d.id);
              }}
            >
              Discard
            </button>
          </span>
        </div>
        {mergeDraftId === d.id && (
          <InsightMergePanel
            insights={insights}
            drafts={drafts.filter((x) => x.id !== d.id)}
            fixedVictimDraftId={d.id}
            onPrepare={onPrepareMerge}
            onCancel={() => setMergeDraftId(null)}
            onConfirm={async (payload) => {
              await onMergeInsights(payload);
              setMergeDraftId(null);
            }}
          />
        )}
        </div>
      ))}
      {published.length > 0 && (
        <div className="insight-published-group">
          <div className="insight-published-head">
            Awaiting merge <span className="insight-group-count">· {published.length}</span>
          </div>
          {published.map((d) => (
            <div key={d.id} className="insight-published-row">
              <span className="insight-draft-source-chip">{d.sourceType}</span>
              <span className="insight-published-title">{d.title || "untitled"}</span>
              {d.prUrl && (
                <a
                  className="insight-published-pr"
                  href={d.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open PR on GitHub"
                >
                  PR{d.prNumber ? ` #${d.prNumber}` : ""} ↗
                </a>
              )}
              {mergeError?.id === d.id && (
                <span className="insight-published-error" role="alert">{mergeError.msg}</span>
              )}
              <button
                className="btn insight-published-close"
                disabled={mergingId === d.id || closingId === d.id}
                onClick={() => void doClosePr(d.id)}
                title="Close the PR on GitHub and return this draft to pending"
              >
                {closingId === d.id ? "Closing…" : "Close PR"}
              </button>
              <button
                className="btn primary insight-published-merge"
                disabled={mergingId === d.id || closingId === d.id}
                onClick={() => void doMerge(d.id)}
                title="Squash-merge this PR into the product repo"
              >
                {mergingId === d.id ? "Merging…" : "Approve & merge"}
              </button>
            </div>
          ))}
        </div>
      )}
      {ops.length > 0 && (
        <div className="insight-published-group">
          <div className="insight-published-head">
            Open PRs <span className="insight-group-count">· {ops.length}</span>
          </div>
          {ops.map((op) => (
            <div key={op.id} className="insight-published-row">
              <span className="insight-draft-source-chip">{op.kind}</span>
              <span className="insight-published-title">
                {op.targetPath.replace(/^insights\//, "").replace(/\.md$/, "")}
                {op.kind === "merge" && (op.victimPaths.length + op.victimDraftIds.length) > 0 && (
                  <span className="insight-op-victims">
                    {" "}
                    ← {op.victimPaths.length + op.victimDraftIds.length}
                  </span>
                )}
              </span>
              {op.prUrl && (
                <a
                  className="insight-published-pr"
                  href={op.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open PR on GitHub"
                >
                  PR{op.prNumber ? ` #${op.prNumber}` : ""} ↗
                </a>
              )}
              {opError?.id === op.id && (
                <span className="insight-published-error" role="alert">{opError.msg}</span>
              )}
              <button
                className="btn insight-published-close"
                disabled={opBusyId === op.id}
                onClick={() => void doCloseOp(op.id)}
                title="Close the PR on GitHub and abandon this op"
              >
                Close PR
              </button>
              <button
                className="btn primary insight-published-merge"
                disabled={opBusyId === op.id}
                onClick={() => void doApproveOp(op.id)}
                title="Squash-merge this PR into the product repo"
              >
                {opBusyId === op.id ? "Merging…" : "Approve & merge"}
              </button>
            </div>
          ))}
        </div>
      )}
      {showApi && <CaptureApiModal onClose={() => setShowApi(false)} />}
    </section>
  );
}

function fallbackCopy(s: string): void {
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.left = "-1000px";
  ta.style.opacity = "0";
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* nothing else to try */
  }
  document.body.removeChild(ta);
}

function CaptureApiModal({ onClose }: { onClose: () => void }): JSX.Element {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    void getCaptureToken().then(setToken).catch(() => setToken(null));
  }, []);
  const bearer = token ?? "<token>";
  const curl = `curl -X POST ${origin}/api/insights/capture \
  -H "Authorization: Bearer ${bearer}" \
  -H "content-type: application/json" \
  -d '{
    "sourceType": "slack",
    "sourceUrl": "https://acme.slack.com/archives/C123/p456",
    "hint": "optional one-liner context",
    "rawText": "<paste call notes / thread / email / doc excerpt>"
  }'`;

  const fields = `sourceType   required   paste | gdoc | sheet | slide | slack | jira | email | other
sourceUrl    optional   link back to the source artifact
hint         optional   one-line context for the AI extractor
rawText      required   the raw content (≤ 32k chars)`;

  const response = `{ "draft": { "id": 7, "state": "pending", "title": "...", ... } }`;

  const agentBrief = `# GH Roadmap - Insight Capture API

Drop captured material (call notes, Slack threads, emails, doc excerpts) into the PM's Inbox. Localhost single-user mode needs no auth. Prod with login on needs a per-user token from Rotate token in the avatar menu. The dashboard runs AI extraction on your behalf, surfaces the draft for human review, and publishes the approved version as a PR on the product repo.

## Endpoint

POST ${origin}/api/insights/capture
Content-Type: application/json

## Fields

${fields}

## Example

${curl}

## Response (200)

${response}

## Notes

- Localhost single-user: no auth. Prod with login on: include Authorization: Bearer <token> from Rotate token in avatar menu.
- AI extraction (title, type, accounts, related issues, key quotes, body draft) runs automatically when the dashboard's AI is configured. When AI is disabled, the draft is created with empty fields for manual fill-in.
- Each captured item lands as a pending draft. The PM reviews it in the Inbox and clicks Publish to open a PR on the product repo's insights/ directory.
- Idempotency: capture is append-only - posting twice still creates two drafts, but the dashboard flags a likely duplicate (exact re-ingest, or near-identical text from the same source) on the new draft so the PM can discard the redundant one.
`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = (s: string): void => {
    // Prefer the async Clipboard API; fall back to execCommand on non-secure
    // contexts (Chrome gates navigator.clipboard on http://<lan-ip> etc.).
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(s).catch(() => fallbackCopy(s));
      return;
    }
    fallbackCopy(s);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal-card capture-api-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">Programmatic capture</span>
          <span className="capture-api-head-actions">
            <button className="btn ghost-link" onClick={() => copy(agentBrief)}>
              Copy all for agent
            </button>
            <button className="close" onClick={onClose}>×</button>
          </span>
        </div>
        <div className="modal-body">
          <p className="capture-api-blurb">
            Any agent or script can drop raw material into the Inbox. Localhost single-user mode needs no auth. Prod with login on needs a per-user token from Rotate token in the avatar menu.
          </p>

          <div className="capture-api-section-head">
            <span>Request</span>
            <button className="btn ghost-link" onClick={() => copy(curl)}>Copy</button>
          </div>
          <pre className="capture-api-pre">{curl}</pre>

          <div className="capture-api-section-head">
            <span>Fields</span>
            <button className="btn ghost-link" onClick={() => copy(fields)}>Copy</button>
          </div>
          <pre className="capture-api-pre dim">{fields}</pre>

          <div className="capture-api-section-head">
            <span>Response (200)</span>
            <button className="btn ghost-link" onClick={() => copy(response)}>Copy</button>
          </div>
          <pre className="capture-api-pre dim">{response}</pre>

          <p className="capture-api-foot">
            Captured drafts land here in the Inbox for review and PR publish.
          </p>
        </div>
      </div>
    </div>
  );
}
