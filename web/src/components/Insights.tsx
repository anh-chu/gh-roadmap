import { useMemo, useState } from "react";
import type {
  ApiInsightDraft,
  ApiInsightListItem,
  InsightMergePayload,
  Issue,
} from "../../../shared/types";
import { useInsights } from "../hooks/useInsights";
import { useInsightDrafts } from "../hooks/useInsightDrafts";
import { useInsightOps } from "../hooks/useInsightOps";
import { prepareInsightMerge } from "../lib/api";
import { InsightDrawer } from "./InsightDrawer";
import { InsightInbox } from "./InsightInbox";
import { InsightDraftEditor } from "./InsightDraftEditor";
import { CaptureModal } from "./CaptureModal";
import { useToast } from "./Toast";
import { AccountRef } from "./AccountRef";

type GroupBy = "date" | "type" | "account" | "owner" | "issue";

interface InsightsProps {
  issuesByNum: Map<number, Issue>;
  onOpenIssue: (i: Issue) => void;
  onOpenAccount: (slug: string) => void;
}

const CONFIDENCE_OPTIONS: { value: string; label: string }[] = [
  { value: "verified", label: "Verified" },
  { value: "likely", label: "Likely" },
  { value: "rumor", label: "Rumor" },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "customer", label: "Customer" },
  { value: "data", label: "Data" },
  { value: "competitive", label: "Competitive" },
  { value: "support", label: "Support" },
  { value: "survey", label: "Survey" },
  { value: "market", label: "Market" },
];

function monthLabel(date: string | null): string {
  if (!date) return "Undated";
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) return "Undated";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function monthKey(date: string | null): string {
  if (!date) return "z-undated"; // sort last
  return date.slice(0, 7);
}

export function Insights({ issuesByNum, onOpenIssue, onOpenAccount }: InsightsProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [confidenceFilter, setConfidenceFilter] = useState<string[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [openDraft, setOpenDraft] = useState<ApiInsightDraft | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);

  const draftsApi = useInsightDrafts();
  const opsApi = useInsightOps();
  const { node: toastNode, controller: toast } = useToast();

  const { items, accounts, loading, error, disabled, refresh: refreshInsights } = useInsights({
    type: typeFilter,
    confidence: confidenceFilter,
    account: accountFilter || undefined,
  });

  const openItem = openSlug ? items.find((i) => i.slug === openSlug) : undefined;
  const openOp = openItem ? opsApi.openOpForPath(openItem.path) : undefined;

  const handleMergeInsights = async (payload: InsightMergePayload): Promise<void> => {
    await opsApi.merge(payload);
    // Folded-in pending drafts are now 'merged' server-side — refresh so they leave the inbox.
    await draftsApi.refresh();
    toast.show("Merge PR opened — approve it in the inbox");
  };

  const handleMarkDelete = async (slug: string): Promise<void> => {
    await opsApi.markDelete(slug);
    toast.show("Deletion PR opened — approve it in the inbox");
  };

  const handleApproveOp = async (id: number): Promise<void> => {
    await opsApi.approveMerge(id);
    // Server reconciled on merge — refresh the list so the change shows now.
    await Promise.all([refreshInsights(), draftsApi.refresh()]);
    toast.show("PR merged — insight updated");
  };

  const handleCloseOp = async (id: number): Promise<void> => {
    await opsApi.closePr(id);
    toast.show("PR closed");
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (i) => i.title.toLowerCase().includes(q) || i.excerpt.toLowerCase().includes(q),
    );
  }, [items, search]);

  const grouped = useMemo(
    () => groupItems(filtered, groupBy, issuesByNum),
    [filtered, groupBy, issuesByNum],
  );

  const toggleMulti = (val: string, list: string[], set: (v: string[]) => void): void => {
    set(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  };

  return (
    <>
      <main className="insights reveal" style={{ animationDelay: "120ms" }}>
        <InsightInbox
          drafts={draftsApi.drafts}
          published={draftsApi.published}
          insights={items}
          ops={opsApi.ops}
          loading={draftsApi.loading}
          error={draftsApi.error}
          onOpen={(d) => setOpenDraft(d)}
          onPrepareMerge={prepareInsightMerge}
          onMergeInsights={handleMergeInsights}
          onApproveOp={handleApproveOp}
          onCloseOp={handleCloseOp}
          onDiscard={(id) => {
            void (async () => {
              try {
                await draftsApi.discard(id);
                toast.show("Discarded");
              } catch (err) {
                toast.show(err instanceof Error ? err.message : "Discard failed");
              }
            })();
          }}
          onMerge={async (id) => {
            await draftsApi.merge(id);
            await refreshInsights();
            toast.show("PR merged — insight updated");
          }}
          onClosePr={async (id) => {
            await draftsApi.closePr(id);
            toast.show("PR closed — draft back in pending");
          }}
          onCapture={() => setCaptureOpen(true)}
        />
        <div className="insight-filter-bar">
          <div className="insight-filter-search">
            <input
              placeholder="Search insights..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <MultiFilter
            label="Type"
            options={TYPE_OPTIONS}
            value={typeFilter}
            onChange={(v) => toggleMulti(v, typeFilter, setTypeFilter)}
            onClear={() => setTypeFilter([])}
          />
          <MultiFilter
            label="Confidence"
            options={CONFIDENCE_OPTIONS}
            value={confidenceFilter}
            onChange={(v) => toggleMulti(v, confidenceFilter, setConfidenceFilter)}
            onClear={() => setConfidenceFilter([])}
          />
          <select
            className="insight-filter-select"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            aria-label="Account filter"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name} ({a.insightCount})
              </option>
            ))}
          </select>
          <select
            className="insight-filter-select"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            aria-label="Group by"
          >
            <option value="date">Group: Date</option>
            <option value="type">Group: Type</option>
            <option value="account">Group: Account</option>
            <option value="issue">Group: Feature (issue)</option>
            <option value="owner">Group: Owner</option>
          </select>
          <span className="insight-filter-count">
            {filtered.length} item{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        {error && (
          <div className="insight-empty" role="alert">
            Could not load insights: {error}
          </div>
        )}

        {!error && disabled && !loading && (
          <div className="insight-empty">
            No insights yet. Insights are mirrored from the product repo on GitHub — capture one
            above, or hit <b>Sync</b> to pull the latest. (Requires GitHub to be configured.)
          </div>
        )}

        {!error && !disabled && loading && items.length === 0 && (
          <div className="insight-empty">Loading insights…</div>
        )}

        {!error && !disabled && !loading && filtered.length === 0 && (
          <div className="insight-empty">No insights match these filters.</div>
        )}

        {grouped.map((g) => (
          <section key={g.key} className="insight-group">
            <div className="insight-group-header">
              {g.label} <span className="insight-group-count">({g.items.length})</span>
            </div>
            {g.items.map((it) => (
              <InsightRow key={it.path} item={it} onOpen={() => setOpenSlug(it.slug)} onOpenAccount={onOpenAccount} />
            ))}
          </section>
        ))}
      </main>

      <InsightDrawer
        slug={openSlug}
        issuesByNum={issuesByNum}
        insights={items}
        drafts={draftsApi.drafts}
        openOp={openOp}
        onClose={() => setOpenSlug(null)}
        onOpenIssue={(i) => {
          setOpenSlug(null);
          onOpenIssue(i);
        }}
        onOpenAccount={onOpenAccount}
        onMarkDelete={handleMarkDelete}
        onPrepareMerge={prepareInsightMerge}
        onMerge={handleMergeInsights}
        onApproveOp={handleApproveOp}
      />
      <InsightDraftEditor
        draft={openDraft}
        onClose={() => setOpenDraft(null)}
        onPatch={draftsApi.patch}
        onPublish={draftsApi.publish}
        onDiscard={draftsApi.discard}
        onRegenerate={draftsApi.regenerate}
        onToast={(m) => toast.show(m)}
      />
      <CaptureModal
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onCapture={draftsApi.capture}
        onCaptured={(d) => setOpenDraft(d)}
      />
      {toastNode}
    </>
  );
}

interface GroupedSection {
  key: string;
  label: string;
  items: ApiInsightListItem[];
}

function groupItems(
  items: ApiInsightListItem[],
  by: GroupBy,
  issuesByNum: Map<number, Issue>,
): GroupedSection[] {
  const groups = new Map<string, GroupedSection>();
  // For the issue axis an insight can name several features — emit it under each, so
  // a multi-feature signal counts toward every feature's demand (matches the cares-about
  // corroboration model). The other axes group by a single key.
  for (const it of items) {
    if (by === "issue") {
      if (it.linkedIssues.length === 0) {
        pushTo(groups, "z-no-feature", "No feature", it);
      } else {
        for (const num of it.linkedIssues) {
          const title = issuesByNum.get(num)?.title;
          pushTo(groups, String(num), title ? `#${num} ${title}` : `#${num}`, it);
        }
      }
      continue;
    }
    let key: string;
    let label: string;
    switch (by) {
      case "type":
        key = it.type ?? "z-untyped";
        label = it.type ?? "Untyped";
        break;
      case "owner":
        key = it.owner ?? "z-unknown";
        label = it.owner ?? "Unknown";
        break;
      case "account": {
        if (it.accounts.length === 0) {
          key = "z-no-account";
          label = "No account";
        } else {
          // Group under each account separately — but to keep it simple, group by first.
          const first = it.accounts[0]!;
          key = first.slug;
          label = first.name;
        }
        break;
      }
      case "date":
      default:
        key = monthKey(it.date);
        label = monthLabel(it.date);
    }
    pushTo(groups, key, label, it);
  }
  const arr = [...groups.values()];
  if (by === "date") {
    // Most recent month first.
    arr.sort((a, b) => b.key.localeCompare(a.key));
  } else if (by === "issue") {
    // Demand ranking: most-requested feature first; "No feature" sinks to the bottom.
    arr.sort((a, b) => {
      if (a.key === "z-no-feature") return 1;
      if (b.key === "z-no-feature") return -1;
      return b.items.length - a.items.length || a.label.localeCompare(b.label);
    });
  } else {
    arr.sort((a, b) => a.label.localeCompare(b.label));
  }
  return arr;
}

function pushTo(
  groups: Map<string, GroupedSection>,
  key: string,
  label: string,
  it: ApiInsightListItem,
): void {
  const g = groups.get(key);
  if (g) g.items.push(it);
  else groups.set(key, { key, label, items: [it] });
}

interface InsightRowProps {
  item: ApiInsightListItem;
  onOpen: () => void;
  onOpenAccount: (slug: string) => void;
}

function InsightRow({ item, onOpen, onOpenAccount }: InsightRowProps): JSX.Element {
  return (
    <div className="insight-row" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="insight-row-head">
        {item.date && <span className="insight-row-date">{item.date}</span>}
        <span className="insight-row-title">{item.title}</span>
      </div>
      <div className="insight-row-meta">
        {item.type && (
          <span className={`insight-type-chip insight-type-${item.type}`}>{item.type}</span>
        )}
        {item.owner && <span className="insight-row-owner">{item.owner}</span>}
        {item.confidence && (
          <span className={`insight-confidence insight-confidence-${item.confidence}`}>
            {item.confidence}
          </span>
        )}
      </div>
      {item.excerpt && <div className="insight-row-excerpt">{item.excerpt}</div>}
      {(item.accounts.length > 0 || item.linkedIssues.length > 0) && (
        <div className="insight-row-tags">
          {item.accounts.map((a) => (
            <AccountRef key={a.slug} name={a.name} slug={a.slug} onOpen={onOpenAccount} />
          ))}
          {item.linkedIssues.length > 0 && (
            <span className="insight-row-linked">
              <span className="insight-pin">📎</span>
              {item.linkedIssues.slice(0, 6).map((n) => (
                <span key={n} className="insight-issue-chip">#{n}</span>
              ))}
              {item.linkedIssues.length > 6 && (
                <span className="insight-issue-more">+{item.linkedIssues.length - 6}</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface MultiFilterProps {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string) => void;
  onClear: () => void;
}

function MultiFilter({ label, options, value, onChange, onClear }: MultiFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="insight-multi">
      <button
        className={"chip" + (value.length > 0 ? " active" : "")}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {value.length > 0 && (
          <span style={{ marginLeft: 4, opacity: 0.7 }}>·{value.length}</span>
        )}
      </button>
      {open && (
        <>
          <div className="insight-multi-backdrop" onClick={() => setOpen(false)} />
          <div className="popover insight-multi-pop">
            <div className="pop-section">
              <div className="pop-label">{label}</div>
              <div className="pop-checks">
                {options.map((o) => (
                  <label key={o.value} className="pop-check">
                    <input
                      type="checkbox"
                      checked={value.includes(o.value)}
                      onChange={() => onChange(o.value)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="pop-foot">
              <button className="pop-reset" onClick={onClear}>Clear</button>
              <button className="pop-reset" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
