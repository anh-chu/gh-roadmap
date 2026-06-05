import { useEffect, useState } from "react";
import type {
  ApiInsightDraft,
  ApiInsightListItem,
  ApiInsightOp,
  InsightMergePayload,
  InsightMergePreview,
  Issue,
} from "../../../shared/types";
import { useInsight } from "../hooks/useInsight";
import { IssueRefMarkdown } from "./IssueRefMarkdown";
import { AccountRef } from "./AccountRef";
import { InsightMergePanel } from "./InsightMergePanel";

interface InsightDrawerProps {
  slug: string | null;
  issuesByNum: Map<number, Issue>;
  onClose: () => void;
  onOpenIssue: (i: Issue) => void;
  onOpenAccount: (slug: string) => void;
  // Retire/consolidate actions — only wired from the Insights tab. When omitted (e.g. the
  // nested read-only insight drawer inside the issue drawer) the actions row is hidden.
  insights?: ApiInsightListItem[];
  drafts?: ApiInsightDraft[];
  openOp?: ApiInsightOp | undefined;
  onMarkDelete?: (slug: string) => Promise<void>;
  onPrepareMerge?: (payload: InsightMergePayload) => Promise<InsightMergePreview>;
  onMerge?: (payload: InsightMergePayload) => Promise<void>;
  onApproveOp?: (id: number) => Promise<void>;
}

export function InsightDrawer({
  slug,
  issuesByNum,
  insights = [],
  drafts = [],
  openOp,
  onClose,
  onOpenIssue,
  onOpenAccount,
  onMarkDelete,
  onPrepareMerge,
  onMerge,
  onApproveOp,
}: InsightDrawerProps): JSX.Element {
  const { insight, loading, error } = useInsight(slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reset transient action state when the open insight changes.
  useEffect(() => {
    setConfirmDelete(false);
    setShowMerge(false);
    setBusy(false);
    setActionError(null);
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [slug, onClose]);

  const open = slug !== null;

  const runAction = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const doMarkDelete = (insightSlug: string): void => {
    if (!onMarkDelete) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    void runAction(async () => {
      await onMarkDelete(insightSlug);
      setConfirmDelete(false);
    });
  };

  const handleIssueRefOpen = (i: Issue): void => {
    onOpenIssue(i);
  };

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} aria-hidden />}
      <aside className={"drawer insight-drawer" + (open ? " open" : "")}>
        {open && loading && !insight && (
          <div className="d-head">
            <div className="row1">
              <span className="d-num">Insight</span>
              <button className="close" onClick={onClose}>×</button>
            </div>
            <div className="insight-empty">Loading…</div>
          </div>
        )}
        {open && error && !insight && (
          <div className="d-head">
            <div className="row1">
              <span className="d-num">Insight</span>
              <button className="close" onClick={onClose}>×</button>
            </div>
            <div className="insight-empty" role="alert">{error}</div>
          </div>
        )}
        {open && insight && (
          <>
            <div className="d-head">
              <div className="row1">
                <span className="d-num">Insight</span>
                {insight.type && (
                  <span className={`insight-type-chip insight-type-${insight.type}`}>
                    {insight.type}
                  </span>
                )}
                {insight.confidence && (
                  <span className={`insight-confidence insight-confidence-${insight.confidence}`}>
                    {insight.confidence}
                  </span>
                )}
                <button className="close" onClick={onClose}>×</button>
              </div>
              <h2 className="d-title">{insight.title}</h2>
              <dl className="d-meta">
                {insight.date && (
                  <>
                    <dt>Date</dt>
                    <dd>{insight.date}</dd>
                  </>
                )}
                {insight.owner && (
                  <>
                    <dt>Owner</dt>
                    <dd>{insight.owner}</dd>
                  </>
                )}
                {insight.accounts.length > 0 && (
                  <>
                    <dt>Accounts</dt>
                    <dd>
                      {insight.accounts.map((a) => (
                        <AccountRef key={a.slug} name={a.name} slug={a.slug} onOpen={onOpenAccount} />
                      ))}
                    </dd>
                  </>
                )}
                {insight.linkedIssues.length > 0 && (
                  <>
                    <dt>Linked</dt>
                    <dd>
                      <span className="insight-pin">📎</span>
                      {insight.linkedIssues.map((n) => {
                        const issue = issuesByNum.get(n);
                        return (
                          <button
                            key={n}
                            className="insight-issue-chip insight-issue-chip-link"
                            onClick={() => {
                              if (issue) handleIssueRefOpen(issue);
                            }}
                            disabled={!issue}
                            title={issue ? issue.title : "Not in current scope"}
                          >
                            #{n}
                          </button>
                        );
                      })}
                    </dd>
                  </>
                )}
              </dl>
            </div>
            <div className="d-body">
              {insight.sources.length > 0 && (
                <>
                  <h4>Sources</h4>
                  <ul className="insight-sources">
                    {insight.sources.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              <h4>Content</h4>
              <div className="d-desc">
                <IssueRefMarkdown
                  text={insight.bodyMarkdown}
                  issuesByNum={issuesByNum}
                  onOpen={handleIssueRefOpen}
                />
              </div>
              <div className="insight-foot-meta">
                <span style={{ color: "var(--ink-4)", fontSize: 11 }}>
                  {insight.path}
                </span>
              </div>

              {onMarkDelete && onMerge && onApproveOp && onPrepareMerge && (
              <div className="insight-actions">
                {openOp ? (
                  <div className="insight-op-banner">
                    <span className="insight-op-kind">
                      {openOp.kind === "delete" ? "Deletion" : "Merge"} PR
                      {openOp.prNumber ? ` #${openOp.prNumber}` : ""} open
                    </span>
                    {openOp.prUrl && (
                      <a href={openOp.prUrl} target="_blank" rel="noreferrer" title="Open PR on GitHub">
                        ↗
                      </a>
                    )}
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void runAction(() => onApproveOp(openOp.id))}
                      title="Squash-merge this PR into the product repo"
                    >
                      {busy ? "Merging…" : "Approve & merge"}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="insight-actions-row">
                      <button
                        className={"btn" + (confirmDelete ? " danger" : "")}
                        disabled={busy}
                        onClick={() => doMarkDelete(insight.slug)}
                      >
                        {confirmDelete ? "Click again to open deletion PR" : "Mark for deletion"}
                      </button>
                      {confirmDelete && (
                        <button className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
                          Cancel
                        </button>
                      )}
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setConfirmDelete(false);
                          setShowMerge((s) => !s);
                        }}
                      >
                        {showMerge ? "Close merge" : "Merge…"}
                      </button>
                    </div>
                    {showMerge && (
                      <InsightMergePanel
                        insights={insights.filter((i) => i.slug !== insight.slug)}
                        drafts={drafts}
                        fixedSurvivorSlug={insight.slug}
                        onPrepare={onPrepareMerge}
                        onCancel={() => setShowMerge(false)}
                        onConfirm={async (payload) => {
                          await onMerge(payload);
                          setShowMerge(false);
                        }}
                      />
                    )}
                  </>
                )}
                {actionError && (
                  <div className="insight-merge-error" role="alert">
                    {actionError}
                  </div>
                )}
              </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
