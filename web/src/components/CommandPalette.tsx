import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Account, Issue } from "../../../shared/types";
import type { TabKey } from "./Toolbar";
import { TypeBadge } from "./TypeBadge";
import { fetchAccounts } from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  issues: Issue[];
  onOpenIssue: (i: Issue) => void;
  onOpenAccount: (slug: string) => void;
  onTab: (t: TabKey) => void;
  onNewIssue: () => void;
}

interface Item {
  kind: "nav" | "action" | "issue" | "account";
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  issue?: Issue;
}

const NAV: { tab: TabKey; label: string }[] = [
  { tab: "progress", label: "Today" },
  { tab: "roadmap", label: "Roadmap" },
  { tab: "list", label: "List" },
  { tab: "kanban", label: "Kanban" },
  { tab: "milestones", label: "Releases" },
  { tab: "insights", label: "Insights" },
  { tab: "accounts", label: "Accounts" },
];

const KIND_LABEL: Record<Item["kind"], string> = {
  nav: "Go to",
  action: "Actions",
  issue: "Issues",
  account: "Accounts",
};

export function CommandPalette({ open, onClose, issues, onOpenIssue, onOpenAccount, onTab, onNewIssue }: Props): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus on open; lazily pull the account list the first time.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    inputRef.current?.focus();
    if (accounts.length === 0) void fetchAccounts().then(setAccounts).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Item[] = [];

    // Navigation + actions — always offered; filtered by label when querying.
    for (const n of NAV) {
      if (!q || n.label.toLowerCase().includes(q)) {
        out.push({ kind: "nav", id: `nav:${n.tab}`, label: n.label, run: () => { onTab(n.tab); onClose(); } });
      }
    }
    if (!q || "new issue".includes(q)) {
      out.push({ kind: "action", id: "act:new", label: "New issue", hint: "create", run: () => { onNewIssue(); onClose(); } });
    }

    // Issues — by #number or title substring.
    const num = q.replace(/^#/, "");
    const matchedIssues = issues
      .filter((i) => {
        if (!q) return false;
        if (/^\d+$/.test(num)) return String(i.num).includes(num);
        return i.title.toLowerCase().includes(q) || String(i.num).includes(q);
      })
      .slice(0, 8);
    for (const i of matchedIssues) {
      out.push({ kind: "issue", id: `issue:${i.num}`, label: i.title, hint: `#${i.num}`, run: () => { onOpenIssue(i); onClose(); }, issue: i });
    }

    // Accounts — by name.
    if (q) {
      for (const a of accounts.filter((a) => a.displayName.toLowerCase().includes(q)).slice(0, 5)) {
        out.push({ kind: "account", id: `acct:${a.slug}`, label: a.displayName, hint: "account", run: () => { onOpenAccount(a.slug); onClose(); } });
      }
    }
    return out;
  }, [query, issues, accounts, onTab, onNewIssue, onOpenIssue, onOpenAccount, onClose]);

  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);

  if (!open) return null;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  // Group consecutive items by kind for section headers.
  let lastKind: Item["kind"] | null = null;

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Jump to an issue, account, or page…  (try #123 or a title)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={onKey}
        />
        <div className="cmdk-list">
          {items.length === 0 && <div className="cmdk-empty">No matches</div>}
          {items.map((it, idx) => {
            const header = it.kind !== lastKind ? KIND_LABEL[it.kind] : null;
            lastKind = it.kind;
            return (
              <div key={it.id}>
                {header && <div className="cmdk-section">{header}</div>}
                <button
                  className={"cmdk-item" + (idx === sel ? " sel" : "")}
                  onMouseEnter={() => setSel(idx)}
                  onClick={() => it.run()}
                >
                  <span className="cmdk-item-label">{it.label}</span>
                  {it.kind === "issue" && it.issue && <TypeBadge issue={it.issue} />}
                  {it.hint && <span className="cmdk-item-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
