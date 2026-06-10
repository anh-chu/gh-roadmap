import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiComment, FlowResult, Issue, Pull } from "../../../shared/types";
import {
  deleteComment as apiDeleteComment,
  getComments,
  patchComment,
  postComment,
} from "../lib/api";
import { FlowPill } from "./FlowPill";
import { AiBlock } from "./AiBlock";
import { EffortChip } from "./EffortChip";
import { useIssueSummary } from "../hooks/useIssueSummary";
import { useIssueInsights } from "../hooks/useIssueInsights";
import { InsightDrawer } from "./InsightDrawer";
import { RepoFiles } from "./RepoFiles";

// Build month options dynamically from "today": current month + next two, plus backlog.
function buildMonthOpts(): { key: string | null; label: string }[] {
  const now = new Date();
  const opts: { key: string | null; label: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const key = d.toISOString().slice(0, 7);
    const label = d.toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
    opts.push({ key, label });
  }
  opts.push({ key: null, label: "Backlog" });
  return opts;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 30) return "just now";
  if (diff < 60) return diff + "s ago";
  const m = Math.round(diff / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 14) return d + "d ago";
  return new Date(iso).toLocaleDateString();
}

// Build an agent-ready reference for one issue: the key facts plus the localhost
// API endpoints that act on it. Shapes live in /api/openapi.json — we point at it
// rather than duplicate request bodies here (which would drift from the contract).
function buildAgentRef(issue: Issue, repoSlug: string | null): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const gh = repoSlug ? `https://github.com/${repoSlug}/issues/${issue.num}` : "—";
  const labels = issue.labels.length ? issue.labels.join(", ") : "none";
  const planned = issue.month ?? (issue.isTodo ? "TODO" : "Backlog");
  return `# GH Roadmap — Issue #${issue.num}

${issue.title}

- State: ${issue.state}
- Assignee: @${issue.assignee}
- Area: ${issue.area}
- Labels: ${labels}
- Milestone: ${issue.milestone ?? "none"}
- Planned: ${planned}${issue.week ? ` (week ${issue.week})` : ""}
- Effort: ${issue.effort ?? "—"}
- Updated: ${issue.updatedAt}
- GitHub: ${gh}

## API (localhost, no auth)

Full machine-readable contract: ${origin}/api/openapi.json (or ${origin}/api/openapi.yaml)

Endpoints for this issue:
- GET   ${origin}/api/issues                       list scoped issues (this one included)
- PATCH ${origin}/api/issues/${issue.num}              update GitHub-owned fields (title, body, state, assignee, labels, milestone)
- PATCH ${origin}/api/issues/${issue.num}/roadmap      update app-only planning metadata (plannedMonth, plannedWeek, isTodo, roadmapNotes, position)
- GET   ${origin}/api/issues/${issue.num}/comments     list comments
- POST  ${origin}/api/issues/${issue.num}/comments     add a comment
- GET   ${origin}/api/issues/${issue.num}/insights     linked customer insights

Request/response shapes are defined in the OpenAPI doc above. App-only fields are never written back to GitHub.
`;
}

// Prefer the async Clipboard API; fall back to execCommand on non-secure contexts
// (Chrome gates navigator.clipboard on http://<lan-ip> etc.). Mirrors InsightInbox.
function copyText(s: string): void {
  if (navigator?.clipboard?.writeText) {
    void navigator.clipboard.writeText(s).catch(() => fallbackCopy(s));
    return;
  }
  fallbackCopy(s);
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

function avatarClass(author: string | null): string {
  // Generic avatar — no name-based theming. Stable class per author so CSS can colourise consistently.
  const slug = (author ?? "x")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16) || "x";
  return "av av-" + slug;
}

interface DrawerProps {
  issue: Issue | null;
  currentUser: string | null;
  knownAssignees: string[];
  knownLabels: string[];
  knownMilestones: string[];
  linkedPulls: Pull[];
  flowResult: FlowResult | undefined;
  issuesByNum: Map<number, Issue>;
  repoSlug: string | null;
  onClose: () => void;
  onTitle: (num: number, t: string) => void;
  onStateToggle: (num: number) => void;
  onAssignee: (num: number, a: string) => void;
  onMonth: (num: number, m: string | null) => void;
  onBody: (num: number, body: string) => void;
  onLabels: (num: number, labels: string[]) => void;
  onMilestone: (num: number, m: string | null) => void;
  onOpenAnother: (i: Issue) => void;
  onOpenAccount: (slug: string) => void;
  onToast: (msg: string) => void;
}

interface DropdownPos {
  top: number;
  left: number;
  items: { label: string; val: string | null }[];
  onPick: (v: string | null) => void;
}

interface PendingDelete {
  id: number;
  comment: ApiComment;
  timer: number;
}

export function Drawer(props: DrawerProps): JSX.Element {
  const { issue, currentUser, knownAssignees, knownLabels, knownMilestones, linkedPulls, flowResult, issuesByNum, repoSlug, onClose, onTitle, onStateToggle, onAssignee, onMonth, onBody, onLabels, onMilestone, onOpenAnother, onOpenAccount, onToast } = props;
  const monthOpts = buildMonthOpts();
  const assigneeOpts = Array.from(
    new Set([currentUser, ...knownAssignees].filter((x): x is string => Boolean(x))),
  );

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [addingLabel, setAddingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [comment, setComment] = useState("");
  const [dd, setDd] = useState<DropdownPos | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  const [comments, setComments] = useState<ApiComment[]>([]);
  const [openInsightSlug, setOpenInsightSlug] = useState<string | null>(null);
  const { insights: linkedInsights } = useIssueInsights(issue?.num ?? null);
  // Read the AI summary at this level too (module-cached, so it dedupes with the
  // summary block below) — lets the Effort meta row fall back to the AI estimate.
  const { summary: metaSummary } = useIssueSummary(issue?.num ?? null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // Escape closes drawer + dropdown
  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (dd) setDd(null);
        else if (editingId !== null) setEditingId(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [dd, editingId, onClose]);

  // Dismiss dropdown on outside click
  useEffect(() => {
    if (!dd) return;
    const fn = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      const el = document.getElementById("d-active-dropdown");
      if (el && !el.contains(e.target)) setDd(null);
    };
    const id = window.setTimeout(() => document.addEventListener("click", fn), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", fn);
    };
  }, [dd]);

  // Reset on issue change
  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft("");
    setEditingBody(false);
    setBodyDraft("");
    setAddingLabel(false);
    setLabelDraft("");
    setComment("");
    setDd(null);
    setEditingId(null);
    setPendingDelete(null);
  }, [issue?.num]);

  // Autosize title textarea
  useEffect(() => {
    if (editingTitle && titleRef.current) {
      const ta = titleRef.current;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      ta.focus();
      ta.select();
    }
  }, [editingTitle]);

  // Fetch comments when the drawer opens for a new issue.
  useEffect(() => {
    if (!issue) {
      setComments([]);
      return;
    }
    let cancelled = false;
    setLoadingComments(true);
    setComments([]);
    (async () => {
      try {
        const list = await getComments(issue.num);
        if (!cancelled) setComments(list);
      } catch {
        if (!cancelled) setComments([]);
      } finally {
        if (!cancelled) setLoadingComments(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [issue?.num]);

  const openDD = (e: React.MouseEvent, items: DropdownPos["items"], pick: DropdownPos["onPick"]): void => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDd({ top: r.bottom + 4, left: r.left, items, onPick: pick });
  };

  const handleSend = async (): Promise<void> => {
    if (!issue) return;
    const txt = comment.trim();
    if (!txt) return;
    setComment("");
    try {
      const created = await postComment(issue.num, txt);
      setComments((prev) => [...prev, created]);
      onToast("Comment sent");
    } catch (e) {
      onToast(e instanceof Error ? `Failed: ${e.message}` : "Failed");
      setComment(txt);
    }
  };

  const handleSaveEdit = async (c: ApiComment): Promise<void> => {
    const next = editDraft.trim();
    if (!next || next === c.body) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await patchComment(c.id, next);
      setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...updated } : x)));
      setEditingId(null);
      onToast("Saved");
    } catch (e) {
      onToast(e instanceof Error ? `Failed: ${e.message}` : "Failed");
    }
  };

  // Soft-delete: hide locally + queue a real DELETE after 5s, with undo.
  const handleDelete = (c: ApiComment): void => {
    if (pendingDelete) {
      window.clearTimeout(pendingDelete.timer);
    }
    setComments((prev) => prev.filter((x) => x.id !== c.id));
    const timer = window.setTimeout(() => {
      apiDeleteComment(c.id)
        .catch((e: unknown) => {
          onToast(e instanceof Error ? `Failed: ${e.message}` : "Failed");
          setComments((prev) => [...prev, c].sort((a, b) => a.created_at.localeCompare(b.created_at)));
        })
        .finally(() => setPendingDelete(null));
    }, 5000);
    setPendingDelete({ id: c.id, comment: c, timer });
  };

  const handleUndo = (): void => {
    if (!pendingDelete) return;
    window.clearTimeout(pendingDelete.timer);
    setComments((prev) => [...prev, pendingDelete.comment].sort((a, b) => a.created_at.localeCompare(b.created_at)));
    setPendingDelete(null);
  };

  const open = issue !== null;

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} aria-hidden />}
      <aside className={"drawer" + (open ? " open" : "")}>
        {issue && (
          <>
            <div className="d-head">
              <div className="row1">
                {repoSlug ? (
                  <a
                    className="d-num"
                    href={`https://github.com/${repoSlug}/issues/${issue.num}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on GitHub"
                  >
                    #{issue.num}
                  </a>
                ) : (
                  <span className="d-num">#{issue.num}</span>
                )}
                <span
                  className={"d-state editable" + (issue.state === "closed" ? " closed" : "")}
                  onClick={() => onStateToggle(issue.num)}
                >
                  {issue.state}
                </span>
                <FlowPill result={flowResult} size="md" />
                <button
                  className="d-agent-ref"
                  title="Copy an agent-ready reference for this issue (facts + API endpoints)"
                  onClick={() => {
                    copyText(buildAgentRef(issue, repoSlug));
                    onToast("Agent reference copied");
                  }}
                >
                  ⧉ Agent ref
                </button>
                <button className="close" onClick={onClose}>×</button>
              </div>
              {editingTitle ? (
                <h2 className="d-title">
                  <textarea
                    className="edit-input"
                    rows={2}
                    ref={titleRef}
                    value={titleDraft}
                    onChange={(e) => {
                      setTitleDraft(e.target.value);
                      const ta = e.currentTarget;
                      ta.style.height = "auto";
                      ta.style.height = ta.scrollHeight + "px";
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setTitleDraft(issue.title);
                        setEditingTitle(false);
                      }
                    }}
                    onBlur={() => {
                      const v = titleDraft.trim();
                      if (v && v !== issue.title) onTitle(issue.num, v);
                      setEditingTitle(false);
                    }}
                  />
                </h2>
              ) : (
                <h2
                  className="d-title editable"
                  onClick={() => {
                    setTitleDraft(issue.title);
                    setEditingTitle(true);
                  }}
                >
                  {issue.title}
                </h2>
              )}
              <dl className="d-meta">
                <dt>Assignee</dt>
                <dd>
                  <span
                    className="editable-dd"
                    onClick={(e) =>
                      openDD(e, assigneeOpts.map((a) => ({ label: a, val: a })), (v) => {
                        if (v) onAssignee(issue.num, v);
                        setDd(null);
                      })
                    }
                  >
                    <span className="lbl-mini">@</span>{issue.assignee}
                  </span>
                </dd>
                <dt>Area</dt><dd>{issue.area}</dd>
                <dt>Labels</dt>
                <dd className="d-labels">
                  {issue.labels.length === 0 && <span className="d-label-none">none</span>}
                  {issue.labels.map((l) => (
                    <span key={l} className="d-label-chip">
                      {l}
                      <button
                        className="d-label-x"
                        title="Remove label"
                        onClick={() => onLabels(issue.num, issue.labels.filter((x) => x !== l))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {addingLabel ? (
                    <>
                      <input
                        className="edit-input d-label-input"
                        list="d-label-catalog"
                        value={labelDraft}
                        autoFocus
                        placeholder="label name"
                        onChange={(e) => setLabelDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setLabelDraft("");
                            setAddingLabel(false);
                          }
                        }}
                        onBlur={() => {
                          const v = labelDraft.trim();
                          if (v && !issue.labels.includes(v)) onLabels(issue.num, [...issue.labels, v]);
                          setLabelDraft("");
                          setAddingLabel(false);
                        }}
                      />
                      <datalist id="d-label-catalog">
                        {knownLabels
                          .filter((l) => !issue.labels.includes(l))
                          .map((l) => (
                            <option key={l} value={l} />
                          ))}
                      </datalist>
                    </>
                  ) : (
                    <span className="editable-dd d-label-add" onClick={() => setAddingLabel(true)}>
                      + label
                    </span>
                  )}
                </dd>
                <dt>Milestone</dt>
                <dd>
                  <span
                    className="editable-dd"
                    onClick={(e) =>
                      openDD(
                        e,
                        [
                          { label: "— none —", val: null },
                          ...knownMilestones.map((m) => ({ label: m, val: m })),
                        ],
                        (v) => {
                          onMilestone(issue.num, v);
                          setDd(null);
                        },
                      )
                    }
                  >
                    {issue.milestone ?? "none"}
                  </span>
                </dd>
                <dt>Planned</dt>
                <dd>
                  <span
                    className="editable-dd"
                    onClick={(e) =>
                      openDD(
                        e,
                        monthOpts.map((m) => ({ label: m.label, val: m.key })),
                        (v) => {
                          onMonth(issue.num, v);
                          setDd(null);
                        },
                      )
                    }
                  >
                    {issue.month
                      ? monthOpts.find((m) => m.key === issue.month)?.label ?? issue.month
                      : "Backlog"}
                  </span>
                </dd>
                <dt>Updated</dt><dd>{formatRelative(issue.updatedAt)}</dd>
                {(issue.effort ?? metaSummary?.effort) && (
                  <>
                    <dt>Effort</dt>
                    <dd>
                      <EffortChip
                        effort={issue.effort ?? metaSummary!.effort!}
                        source={issue.effort ? "label" : "estimate"}
                      />
                    </dd>
                  </>
                )}
              </dl>
            </div>
            <div className="d-body">
              {linkedInsights.length > 0 && (
                <div className="insight-meta-line">
                  <span className="insight-pin" aria-hidden>📎</span>
                  <span>
                    {linkedInsights.length} insight{linkedInsights.length === 1 ? "" : "s"}
                  </span>
                  {(() => {
                    const names: string[] = [];
                    for (const ins of linkedInsights) {
                      for (const a of ins.accounts) {
                        if (!names.includes(a.name)) names.push(a.name);
                      }
                    }
                    if (names.length === 0) return null;
                    const shown = names.slice(0, 2).join(", ");
                    const extra = names.length > 2 ? ` + ${names.length - 2}` : "";
                    return (
                      <>
                        <span className="insight-meta-sep">·</span>
                        <span>👥 {shown}{extra}</span>
                      </>
                    );
                  })()}
                  <button
                    className="insight-meta-view"
                    onClick={() => {
                      const first = linkedInsights[0];
                      if (first) setOpenInsightSlug(first.slug);
                    }}
                  >
                    view
                  </button>
                </div>
              )}
              <DrawerAiSummary num={issue.num} issuesByNum={issuesByNum} onOpenAnother={onOpenAnother} />
              {linkedPulls.length > 0 && (
                <div className="d-linked-prs" style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
                  Linked PRs:{" "}
                  {linkedPulls.map((p, idx) => (
                    <span key={p.number}>
                      {idx > 0 ? ", " : ""}
                      #{p.number} ({p.merged ? "merged" : p.state})
                    </span>
                  ))}
                </div>
              )}
              <div className="d-desc-head">
                <h4>Description</h4>
                {!editingBody && (
                  <button
                    className="d-desc-edit"
                    onClick={() => {
                      setBodyDraft(issue.body ?? "");
                      setEditingBody(true);
                    }}
                  >
                    {issue.body && issue.body.trim() ? "Edit" : "Add"}
                  </button>
                )}
              </div>
              {editingBody ? (
                <div className="d-desc-edit-wrap">
                  <textarea
                    className="edit-input d-desc-input"
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    rows={8}
                    autoFocus
                    placeholder="Describe the issue… (Markdown supported)"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingBody(false);
                      }
                    }}
                  />
                  <div className="d-desc-actions">
                    <button
                      className="c-action"
                      onClick={() => {
                        if (bodyDraft !== (issue.body ?? "")) onBody(issue.num, bodyDraft);
                        setEditingBody(false);
                      }}
                    >
                      Save
                    </button>
                    <button className="c-action" onClick={() => setEditingBody(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : issue.body && issue.body.trim() ? (
                <div className="d-desc">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body}</ReactMarkdown>
                </div>
              ) : (
                <div className="d-desc d-desc-empty">No description.</div>
              )}
              <RepoFiles body={issue.body} repoSlug={repoSlug} />
              <h4>Activity</h4>
              {loadingComments ? (
                <>
                  <div className="comment skeleton">
                    <div className="av" style={{ background: "var(--surface-2)", color: "transparent" }}>·</div>
                    <div className="body">
                      <div className="head"><span className="who skel-bar" /></div>
                      <div className="text skel-bar skel-bar-wide" />
                    </div>
                  </div>
                  <div className="comment skeleton">
                    <div className="av" style={{ background: "var(--surface-2)", color: "transparent" }}>·</div>
                    <div className="body">
                      <div className="head"><span className="who skel-bar" /></div>
                      <div className="text skel-bar skel-bar-wide" />
                    </div>
                  </div>
                </>
              ) : comments.length === 0 ? (
                <div className="empty">No activity yet</div>
              ) : (
                comments.map((c) => {
                  const mine = currentUser !== null && (c.author ?? "").toLowerCase() === currentUser.toLowerCase();
                  const editing = editingId === c.id;
                  return (
                    <div className={"comment" + (mine ? " mine" : "")} key={c.id}>
                      <div className={avatarClass(c.author)}>
                        {(c.author ?? "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="body">
                        <div className="head">
                          <span className="who">{c.author ?? "unknown"}</span>
                          <span className="when">{formatRelative(c.created_at)}</span>
                          {mine && !editing && (
                            <span className="c-actions">
                              <button
                                className="c-action"
                                onClick={() => {
                                  setEditingId(c.id);
                                  setEditDraft(c.body);
                                }}
                              >
                                edit
                              </button>
                              <button className="c-action" onClick={() => handleDelete(c)}>
                                delete
                              </button>
                            </span>
                          )}
                        </div>
                        {editing ? (
                          <textarea
                            className="edit-input"
                            value={editDraft}
                            autoFocus
                            rows={3}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void handleSaveEdit(c);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingId(null);
                              }
                            }}
                            onBlur={() => void handleSaveEdit(c)}
                          />
                        ) : (
                          <div className="text">{c.body}</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              {pendingDelete && (
                <div className="undo-bar">
                  <span>Comment deleted.</span>
                  <button onClick={handleUndo}>Undo</button>
                </div>
              )}
            </div>
            <div className="d-foot">
              <textarea
                className="input"
                placeholder="Leave a comment..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button onClick={() => void handleSend()}>Send</button>
            </div>
          </>
        )}
      </aside>
      <InsightDrawer
        slug={openInsightSlug}
        issuesByNum={issuesByNum}
        onClose={() => setOpenInsightSlug(null)}
        onOpenIssue={(i) => {
          setOpenInsightSlug(null);
          onOpenAnother(i);
        }}
        onOpenAccount={onOpenAccount}
      />
      {dd && (
        <div id="d-active-dropdown" className="edit-dropdown" style={{ top: dd.top, left: dd.left }}>
          {dd.items.map((it, idx) => (
            <button key={idx} onClick={(e) => { e.stopPropagation(); dd.onPick(it.val); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DrawerAiSummary({
  num,
  issuesByNum,
  onOpenAnother,
}: {
  num: number;
  issuesByNum: Map<number, Issue>;
  onOpenAnother: (i: Issue) => void;
}): JSX.Element | null {
  const { summary, loading, error, disabled, refresh } = useIssueSummary(num);
  if (disabled) return null;
  return (
    <>
      <AiBlock
        label="Summary"
        content={summary?.summary ?? ""}
        model={summary?.model ?? ""}
        generatedAt={summary?.generatedAt ?? ""}
        loading={loading}
        error={error}
        onRefresh={() => void refresh()}
        issuesByNum={issuesByNum}
        onOpenIssue={onOpenAnother}
      />
    </>
  );
}

// Re-exported for tests/future imports.
export { formatRelative };
