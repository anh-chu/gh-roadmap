import { useMemo, useState } from "react";
import type { Account, AccountIngestResult, AccountIngestRow } from "../../../shared/types";
import { useAccounts } from "../hooks/useAccounts";
import { createAccount, ingestAccounts, ingestAccountsCsv } from "../lib/api";

const ARR_COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

function formatArrCompact(value: number | null): string | null {
  if (value === null) return null;
  return `$${ARR_COMPACT_FORMATTER.format(value)}`;
}

function formatRenewalDate(value: string | null): string | null {
  if (value === null) return null;
  return value.slice(0, 10);
}

interface AccountsProps {
  onOpenAccount: (slug: string) => void;
}

export function Accounts({ onOpenAccount }: AccountsProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const { accounts, loading, error, refresh } = useAccounts();

  const filtered = useMemo(() => {
    if (!search.trim()) return accounts;
    const q = search.toLowerCase();
    return accounts.filter((a) => a.displayName.toLowerCase().includes(q));
  }, [accounts, search]);

  return (
    <main className="insights reveal" style={{ animationDelay: "120ms" }}>
      <div className="insight-filter-bar">
        <div className="insight-filter-search">
          <input
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="insight-filter-count">
          {filtered.length} account{filtered.length === 1 ? "" : "s"}
        </span>
        <button className="chip" onClick={() => setCreating(true)}>
          New account
        </button>
        <button className="chip" onClick={() => setImporting(true)}>
          Import CRM
        </button>
      </div>

      {error && (
        <div className="insight-empty" role="alert">
          Could not load accounts: {error}
        </div>
      )}

      {!error && loading && accounts.length === 0 && (
        <div className="insight-empty">Loading accounts…</div>
      )}

      {!error && !loading && accounts.length === 0 && (
        <div className="insight-empty">
          No accounts yet. Accounts come from insights that name a customer, or from CRM data you
          import — click <b>Import CRM</b> to load your book of business, or capture an insight.
        </div>
      )}

      {!error && !loading && accounts.length > 0 && filtered.length === 0 && (
        <div className="insight-empty">No accounts match your search.</div>
      )}

      {filtered.map((a) => (
        <AccountRow key={a.slug} account={a} onOpen={() => onOpenAccount(a.slug)} />
      ))}

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreated={(slug) => {
            setCreating(false);
            void refresh();
            onOpenAccount(slug);
          }}
        />
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

// ─── Create modal ─────────────────────────────────────────────────

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Enter an account name.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const { slug } = await createAccount({ name: trimmed });
      onCreated(slug);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <div className="modal account-import-modal" role="dialog" aria-label="New account" style={{ width: 420 }}>
        <div className="row1">
          <h3 style={{ margin: 0 }}>New account</h3>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
          Creates the account; fill ARR, owner, tier and the rest from its drawer. Re-using an
          existing name just opens that account.
        </p>
        <label className="account-profile-field">
          <span className="account-profile-label">Account name</span>
          <input
            autoFocus
            value={name}
            placeholder="e.g. Acme Corp"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
        </label>
        {err && <div className="insight-empty" role="alert" style={{ marginTop: 8 }}>{err}</div>}
        <div className="account-profile-actions" style={{ marginTop: 12 }}>
          <button className="chip" disabled={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create & open"}
          </button>
          <button className="chip" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}

interface AccountRowProps {
  account: Account;
  onOpen: () => void;
}

function AccountRow({ account, onOpen }: AccountRowProps): JSX.Element {

  const arr = formatArrCompact(account.arr);
  const renewalDate = formatRenewalDate(account.renewalDate);
  return (
    <div
      className="insight-row"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="insight-row-head">
        <span className="insight-row-title">{account.displayName}</span>
        {account.tier && <span className="chip" style={{ fontSize: 10, padding: "1px 6px" }}>{account.tier}</span>}
        {account.source === "crm" && (
          <span className="chip" style={{ fontSize: 10, padding: "1px 6px", color: "var(--ink-3)" }}>CRM</span>
        )}
      </div>
      <div className="insight-row-meta">
        {arr && <span className="insight-row-owner">ARR {arr}</span>}
        {account.tier && <span className="insight-row-owner">Tier {account.tier}</span>}
        {account.owner && <span className="insight-row-owner">Owner {account.owner}</span>}
        {renewalDate && <span className="insight-row-owner">Renews {renewalDate}</span>}
        <span className="insight-row-owner">
          <span className="insight-pin">📎</span> {account.signalCount} signal{account.signalCount === 1 ? "" : "s"}
        </span>
        <span className="insight-row-owner">{account.caresAboutCount} issue{account.caresAboutCount === 1 ? "" : "s"}</span>
        {account.latestDate && <span className="insight-row-date">{account.latestDate}</span>}
      </div>
    </div>
  );
}

// ─── Import modal ─────────────────────────────────────────────────

const JSON_PLACEHOLDER = `[
  { "name": "Acme Corp", "arr": 120000, "tier": "Enterprise", "owner": "Jane CSM", "renewalDate": "2026-09-01" },
  { "name": "Juno Health", "arr": 45000, "region": "US-West" }
]`;
const CSV_PLACEHOLDER = `name,arr,tier,owner,renewalDate,region
Acme Corp,120000,Enterprise,Jane CSM,2026-09-01,US-East
Juno Health,45000,Mid-Market,Sam AE,2026-07-15,US-West`;

function ImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<"json" | "csv">("csv");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AccountIngestResult | null>(null);

  async function run(): Promise<void> {
    setErr(null);
    setResult(null);
    if (!text.trim()) {
      setErr("Paste some data first.");
      return;
    }
    setBusy(true);
    try {
      let res: AccountIngestResult;
      if (mode === "json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setErr("Invalid JSON.");
          setBusy(false);
          return;
        }
        const rows = Array.isArray(parsed)
          ? (parsed as AccountIngestRow[])
          : ((parsed as { accounts?: AccountIngestRow[] }).accounts ?? null);
        if (!Array.isArray(rows)) {
          setErr("Expected a JSON array, or { accounts: [...] }.");
          setBusy(false);
          return;
        }
        res = await ingestAccounts(rows);
      } else {
        res = await ingestAccountsCsv(text);
      }
      setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const touched = result ? result.created + result.updated : 0;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <div className="modal account-import-modal" role="dialog" aria-label="Import CRM accounts">
        <div className="row1">
          <h3 style={{ margin: 0 }}>Import CRM accounts</h3>
          <button className="close" onClick={onClose}>×</button>
        </div>

        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className={"tab" + (mode === "csv" ? " active" : "")} onClick={() => setMode("csv")}>
            CSV
          </button>
          <button className={"tab" + (mode === "json" ? " active" : "")} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>

        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
          {mode === "csv"
            ? "First row is the header. A name or slug column is required; arr, tier, owner, renewalDate, segment, region, industry, website, domain, salesforceId, notes map to profile fields."
            : "An array of objects (or { accounts: [...] }). Each needs name or slug; other keys map to profile fields. Existing accounts are matched by slug and hydrated."}
        </p>

        <textarea
          className="account-import-textarea"
          rows={12}
          placeholder={mode === "csv" ? CSV_PLACEHOLDER : JSON_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {err && <div className="insight-empty" role="alert" style={{ marginTop: 8 }}>{err}</div>}

        {result && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <b>{touched}</b> account{touched === 1 ? "" : "s"} imported — {result.created} created,{" "}
            {result.updated} updated
            {result.skipped > 0 ? `, ${result.skipped} skipped` : ""}.
            {result.errors.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ink-3)" }}>
                {result.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {result.errors.length > 8 && <li>+{result.errors.length - 8} more</li>}
              </ul>
            )}
          </div>
        )}

        <div className="account-profile-actions" style={{ marginTop: 12 }}>
          {result ? (
            <button className="chip" onClick={onDone}>Done</button>
          ) : (
            <button className="chip" disabled={busy} onClick={() => void run()}>
              {busy ? "Importing…" : "Import"}
            </button>
          )}
          <button className="chip" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </>
  );
}
