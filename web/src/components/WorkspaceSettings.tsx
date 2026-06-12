import { forwardRef, useEffect, useRef, useState } from "react";
import type { Workspace } from "../../../shared/types";
import { refetchWorkspaces, useWorkspaces } from "../hooks/useWorkspaces";
import { createWorkspace, patchWorkspace, setActiveWorkspace } from "../lib/api";

const SLUG_RE = /^[a-z0-9-]+$/;

// One combined pod control: a button showing the active pod name. Opening it shows a
// pod-switch menu (≥2 live pods) with an admin-only "Manage pods…" item, or — for an
// admin with a single pod — the manage surface directly (that's how the second pod
// gets created). Non-admins with one pod see nothing (today's UI). Switching is a full
// context swap (board / at-risk / brief / AI reads), so a reload is the honest
// refetch-all: every module-level hook cache restarts on the new pod cookie.
export function WorkspaceSwitcher({ isAdmin }: { isAdmin: boolean }): JSX.Element | null {
  const { workspaces, activeId } = useWorkspaces();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [manage, setManage] = useState(false);

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

  const live = workspaces.filter((w) => w.archivedAt === null);
  if (activeId === null) return null;
  const hasMenu = live.length >= 2;
  if (!hasMenu && !isAdmin) return null;
  const active = live.find((w) => w.id === activeId) ?? workspaces.find((w) => w.id === activeId);

  const handleOpen = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
    // Single pod + admin: the only thing behind the button is the manage surface.
    setManage(!hasMenu);
    setOpen((v) => !v);
  };

  const switchTo = (id: number): void => {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    void setActiveWorkspace(id).then(() => window.location.reload());
  };

  return (
    <>
      <button
        ref={btnRef}
        className="ws-switcher"
        onClick={handleOpen}
        title={hasMenu ? "Active pod — switching swaps the whole view" : "Manage pods (admin)"}
      >
        {active?.name ?? "—"} ▾
      </button>
      {open && anchor && (
        manage ? (
          <WorkspacesPopover ref={popRef} anchor={anchor} />
        ) : (
          <div
            ref={popRef}
            className="popover ws-menu"
            style={{ top: anchor.bottom + 6, left: anchor.left }}
            role="menu"
          >
            {live.map((w) => (
              <button
                key={w.id}
                className={"ws-menu-item" + (w.id === activeId ? " active" : "")}
                role="menuitem"
                onClick={() => switchTo(w.id)}
              >
                {w.name}
              </button>
            ))}
            {isAdmin && (
              <button
                className="ws-menu-item ws-menu-manage"
                role="menuitem"
                onClick={(e) => {
                  // Stop the document click-outside listener: after this click the menu is
                  // swapped for the manage popover, so the target is no longer inside popRef.
                  e.stopPropagation();
                  setManage(true);
                }}
              >
                Manage pods…
              </button>
            )}
          </div>
        )
      )}
    </>
  );
}

// Admin pod-management popover content — mirror of the UserSettings popover pattern.
// Rename inline, archive/unarchive (never delete), add a pod. Archived pods show
// greyed here only; the switch menu never lists them.

const WorkspacesPopover = forwardRef<HTMLDivElement, { anchor: DOMRect }>(function WorkspacesPopover({ anchor }, ref) {
  const { workspaces, activeId } = useWorkspaces();
  const [error, setError] = useState<string | null>(null);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");

  const liveCount = workspaces.filter((w) => w.archivedAt === null).length;

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : "Request failed");

  const rename = (w: Workspace, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === w.name) return;
    void patchWorkspace(w.id, { name: trimmed })
      .then(() => refetchWorkspaces())
      .then(() => setError(null))
      .catch(fail);
  };

  const setArchived = (w: Workspace, archived: boolean): void => {
    void patchWorkspace(w.id, { archived })
      .then(() => refetchWorkspaces())
      .then(() => {
        setError(null);
        // Archiving the pod you're looking at: the cookie falls back to the first live
        // pod server-side — a reload is the same full-context refetch the switcher does.
        if (archived && w.id === activeId) window.location.reload();
      })
      .catch(fail);
  };

  const addPod = (): void => {
    const slug = newSlug.trim();
    const name = newName.trim();
    if (!SLUG_RE.test(slug)) {
      setError("slug must be lowercase letters, digits, and hyphens");
      return;
    }
    if (!name) return;
    void createWorkspace(slug, name)
      .then(() => refetchWorkspaces())
      .then(() => {
        setNewSlug("");
        setNewName("");
        setError(null);
      })
      .catch(fail);
  };

  return (
    <div
      ref={ref}
      className="popover scope-pop"
      style={{ top: anchor.bottom + 6, left: anchor.left, minWidth: 320 }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">Pods</div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          New pods start scoped to <code>pod:&lt;slug&gt;</code>. Archive hides a pod; nothing is deleted.
        </div>
      </div>
      {error && <div className="pop-section users-error">{error}</div>}
      <div className="pop-section">
        {workspaces.map((w) => (
          <div key={w.id} className={"ws-row" + (w.archivedAt ? " archived" : "")}>
            <input
              className="ws-name-input"
              defaultValue={w.name}
              disabled={w.archivedAt !== null}
              onBlur={(e) => rename(w, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="ws-slug">{w.slug}</span>
            {w.archivedAt ? (
              <button className="btn ws-row-btn" onClick={() => setArchived(w, false)}>Unarchive</button>
            ) : (
              <button
                className="btn ws-row-btn"
                disabled={liveCount <= 1}
                title={liveCount <= 1 ? "Cannot archive the last live pod" : "Archive this pod"}
                onClick={() => setArchived(w, true)}
              >
                Archive
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="pop-section">
        <div className="ws-add-row">
          <input
            className="ws-add-input"
            placeholder="slug"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
          />
          <input
            className="ws-add-input"
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addPod(); }}
          />
          <button className="btn" onClick={addPod} disabled={!newSlug.trim() || !newName.trim()}>Add</button>
        </div>
      </div>
    </div>
  );
});
