import { forwardRef, useEffect, useRef, useState } from "react";
import { importData } from "../lib/api";

// Whole-workspace backup/restore. Export streams the full DB as one JSON file (browser
// download via the attachment header). Import wipes + reloads every table in the file,
// then reloads the page so the module-level hook caches re-fetch.
export function DataSettings(): JSX.Element {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  const handleOpen = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
    setOpen((v) => !v);
  };

  return (
    <>
      <button ref={btnRef} className="btn" onClick={handleOpen} title="Export / import the whole workspace">
        <span>Data</span>
      </button>
      {open && anchor && <DataPopover ref={popRef} anchor={anchor} />}
    </>
  );
}

const DataPopover = forwardRef<HTMLDivElement, { anchor: DOMRect }>(function DataPopover({ anchor }, ref) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const res = await importData(payload);
      const total = Object.values(res.imported).reduce((a, b) => a + b, 0);
      setMsg(`Imported ${total} rows across ${Object.keys(res.imported).length} tables. Reloading…`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className="popover scope-pop"
      style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right), minWidth: 300 }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">Workspace data</div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          Full backup of every table — GitHub mirror, AI caches, and the app-only planning layer
          (months, TODOs, accounts, drafts). Import <b>replaces</b> all data in the file.
        </div>
      </div>

      <div className="pop-section" style={{ display: "flex", gap: 8 }}>
        <a className="btn" href="/api/export" download style={{ flex: 1, justifyContent: "center" }}>
          <span>Export</span>
        </a>
        <button
          className="btn"
          style={{ flex: 1, justifyContent: "center" }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <span>{busy ? "Importing…" : "Import"}</span>
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onPick} />
      </div>

      {msg && (
        <div className="pop-section scope-help" style={{ fontSize: 11, color: "var(--ok, #3fb950)" }}>
          {msg}
        </div>
      )}
      {err && (
        <div className="pop-section scope-help" style={{ fontSize: 11, color: "var(--danger, #f85149)" }}>
          {err}
        </div>
      )}
    </div>
  );
});
