import { useEffect, useState } from "react";
import type {
  AccountProfile,
  AccountProfilePatch,
  AccountSource,
  AccountTimelineItem,
  Issue,
} from "../../../shared/types";
import { useAccount } from "../hooks/useAccount";
import { IssueRefMarkdown } from "./IssueRefMarkdown";

interface AccountDrawerProps {
  slug: string | null;
  issuesByNum: Map<number, Issue>;
  onClose: () => void;
  onOpenIssue: (i: Issue) => void;
}

export function AccountDrawer({
  slug,
  issuesByNum,
  onClose,
  onOpenIssue,
}: AccountDrawerProps): JSX.Element {
  const { detail, loading, error, regenerate, saveProfile } = useAccount(slug);

  useEffect(() => {
    if (!slug) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [slug, onClose]);

  const open = slug !== null;

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} aria-hidden />}
      <aside className={"drawer insight-drawer" + (open ? " open" : "")}>
        {open && loading && !detail && (
          <div className="d-head">
            <div className="row1">
              <span className="d-num">Account</span>
              <button className="close" onClick={onClose}>×</button>
            </div>
            <div className="insight-empty">Loading…</div>
          </div>
        )}
        {open && error && !detail && (
          <div className="d-head">
            <div className="row1">
              <span className="d-num">Account</span>
              <button className="close" onClick={onClose}>×</button>
            </div>
            <div className="insight-empty" role="alert">{error}</div>
          </div>
        )}
        {open && detail && (
          <>
            <div className="d-head">
              <div className="row1">
                <span className="d-num">Account</span>
                <button className="close" onClick={onClose}>×</button>
              </div>
              <h2 className="d-title">
                {detail.displayName}
                <SourceBadge source={detail.source} />
              </h2>
              <dl className="d-meta">
                <dt>Signals</dt>
                <dd>{detail.timeline.length}</dd>
                <dt>Cares about</dt>
                <dd>{detail.caresAbout.length} issues</dd>
              </dl>
              <ProfileSection profile={detail.profile} onSave={saveProfile} />
            </div>

            <div className="d-body">
              {/* AI Read */}
              <h4>AI read</h4>
              {detail.aiRead ? (
                <>
                  <div className="d-desc">
                    <IssueRefMarkdown
                      text={detail.aiRead.content}
                      issuesByNum={issuesByNum}
                      onOpen={onOpenIssue}
                    />
                  </div>
                  <div className="insight-foot-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      className="chip"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() => void regenerate()}
                    >
                      Regenerate
                    </button>
                    <span style={{ color: "var(--ink-4)", fontSize: 11 }}>
                      {detail.aiRead.model} · {detail.aiRead.generatedAt.slice(0, 10)}
                      {detail.aiRead.fromCache ? " (cached)" : ""}
                    </span>
                  </div>
                </>
              ) : (
                <div style={{ color: "var(--ink-4)", fontSize: 13 }}>AI read unavailable.</div>
              )}

              {/* Cares about */}
              {detail.caresAbout.length > 0 && (
                <>
                  <h4>Cares about</h4>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {detail.caresAbout.map((ca) => {
                      const issue = issuesByNum.get(ca.issueNumber);
                      return (
                        <button
                          key={ca.issueNumber}
                          className="insight-issue-chip insight-issue-chip-link"
                          onClick={() => {
                            if (issue) onOpenIssue(issue);
                          }}
                          disabled={!issue}
                          title={issue ? issue.title : "Not in current scope"}
                        >
                          #{ca.issueNumber}
                          {ca.signalCount > 1 && (
                            <span style={{ opacity: 0.6, marginLeft: 2 }}>·{ca.signalCount}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Timeline */}
              {detail.timeline.length > 0 && (
                <>
                  <h4>Timeline</h4>
                  {detail.timeline.map((item) => (
                    <TimelineRow
                      key={item.path}
                      item={item}
                      issuesByNum={issuesByNum}
                      onOpenIssue={onOpenIssue}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

// ─── CRM profile ──────────────────────────────────────────────────

function SourceBadge({ source }: { source: AccountSource }): JSX.Element | null {
  if (source === "signal") return null; // signal-only is the default; no badge needed
  const label = source === "crm" ? "CRM" : "CRM + signals";
  return (
    <span
      className="chip"
      style={{ fontSize: 10, padding: "1px 6px", marginLeft: 8, verticalAlign: "middle", color: "var(--ink-3)" }}
      title={source === "crm" ? "Ingested CRM profile, no insight signals yet" : "Has CRM profile and insight signals"}
    >
      {label}
    </span>
  );
}

type ProfileFieldType = "number" | "date" | "text" | "textarea";
interface ProfileFieldDef {
  key: keyof AccountProfilePatch;
  label: string;
  type: ProfileFieldType;
}
const PROFILE_FIELD_DEFS: ProfileFieldDef[] = [
  { key: "arr", label: "ARR", type: "number" },
  { key: "renewalDate", label: "Renewal", type: "date" },
  { key: "owner", label: "Owner", type: "text" },
  { key: "tier", label: "Tier", type: "text" },
  { key: "segment", label: "Segment", type: "text" },
  { key: "region", label: "Region", type: "text" },
  { key: "industry", label: "Industry", type: "text" },
  { key: "website", label: "Website", type: "text" },
  { key: "domain", label: "Domain", type: "text" },
  { key: "salesforceId", label: "Salesforce ID", type: "text" },
  { key: "notes", label: "Notes", type: "textarea" },
];

function formatArr(n: number | null): string {
  if (n === null) return "—";
  return "$" + n.toLocaleString("en-US");
}

function ProfileSection({
  profile,
  onSave,
}: {
  profile: AccountProfile;
  onSave: (patch: AccountProfilePatch) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function startEdit(): void {
    const d: Record<string, string> = {};
    for (const f of PROFILE_FIELD_DEFS) {
      const v = profile[f.key];
      d[f.key] = v === null || v === undefined ? "" : String(v);
    }
    setDraft(d);
    setEditing(true);
  }

  async function save(): Promise<void> {
    const patch: AccountProfilePatch = {};
    for (const f of PROFILE_FIELD_DEFS) {
      const raw = (draft[f.key] ?? "").trim();
      if (f.type === "number") {
        patch[f.key] = raw === "" ? null : (Number(raw.replace(/[$,\s]/g, "")) as never);
      } else {
        patch[f.key] = (raw === "" ? null : raw) as never;
      }
    }
    setSaving(true);
    try {
      await onSave(patch);
      setEditing(false);
    } catch {
      /* error surfaced by hook */
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="account-profile account-profile-edit">
        {PROFILE_FIELD_DEFS.map((f) => (
          <label key={f.key} className="account-profile-field">
            <span className="account-profile-label">{f.label}</span>
            {f.type === "textarea" ? (
              <textarea
                rows={2}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                type={f.type === "date" ? "date" : f.type === "number" ? "text" : "text"}
                inputMode={f.type === "number" ? "numeric" : undefined}
                placeholder={f.type === "number" ? "e.g. 120000" : ""}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <div className="account-profile-actions">
          <button className="chip" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="chip" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const hasAny = PROFILE_FIELD_DEFS.some((f) => profile[f.key] !== null && profile[f.key] !== undefined);

  return (
    <div className="account-profile">
      <dl className="d-meta">
        {PROFILE_FIELD_DEFS.filter((f) => f.type !== "textarea").map((f) => {
          const v = profile[f.key];
          const display = f.key === "arr" ? formatArr(profile.arr) : v == null || v === "" ? "—" : String(v);
          return (
            <span key={f.key} style={{ display: "contents" }}>
              <dt>{f.label}</dt>
              <dd style={v == null || v === "" ? { color: "var(--ink-4)" } : undefined}>{display}</dd>
            </span>
          );
        })}
      </dl>
      {profile.notes && (
        <div className="account-profile-notes">
          <div className="account-profile-label">Notes</div>
          <div>{profile.notes}</div>
        </div>
      )}
      <div className="account-profile-actions">
        <button className="chip" style={{ fontSize: 11, padding: "2px 8px" }} onClick={startEdit}>
          {hasAny ? "Edit profile" : "Add CRM profile"}
        </button>
        {profile.updatedAt && (
          <span style={{ color: "var(--ink-4)", fontSize: 11 }}>
            updated {profile.updatedAt.slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

interface TimelineRowProps {
  item: AccountTimelineItem;
  issuesByNum: Map<number, Issue>;
  onOpenIssue: (i: Issue) => void;
}

function TimelineRow({ item, issuesByNum, onOpenIssue }: TimelineRowProps): JSX.Element {
  return (
    <div className="insight-row" style={{ cursor: "default" }}>
      <div className="insight-row-head">
        {item.date && <span className="insight-row-date">{item.date}</span>}
        <span className="insight-row-title">{item.title}</span>
      </div>
      <div className="insight-row-meta">
        {item.type && (
          <span className={`insight-type-chip insight-type-${item.type}`}>{item.type}</span>
        )}
        {item.confidence && (
          <span className={`insight-confidence insight-confidence-${item.confidence}`}>
            {item.confidence}
          </span>
        )}
      </div>
      {item.excerpt && <div className="insight-row-excerpt">{item.excerpt}</div>}
      {item.linkedIssues.length > 0 && (
        <div className="insight-row-tags">
          <span className="insight-row-linked">
            <span className="insight-pin">📎</span>
            {item.linkedIssues.slice(0, 6).map((n) => {
              const issue = issuesByNum.get(n);
              return (
                <button
                  key={n}
                  className="insight-issue-chip insight-issue-chip-link"
                  onClick={() => {
                    if (issue) onOpenIssue(issue);
                  }}
                  disabled={!issue}
                  title={issue ? issue.title : "Not in current scope"}
                >
                  #{n}
                </button>
              );
            })}
            {item.linkedIssues.length > 6 && (
              <span className="insight-issue-more">+{item.linkedIssues.length - 6}</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
