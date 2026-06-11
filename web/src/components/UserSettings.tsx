import { forwardRef, useEffect, useRef, useState } from "react";
import type { AppUser, Role } from "../../../shared/types";
import { createUser, fetchUsers, patchUserRole } from "../lib/api";

const ROLES: readonly Role[] = ["viewer", "editor", "admin"];

// Admin "Users" panel — mirror of the AiSettings popover pattern. Lists signed-in users
// with a role dropdown. ADMIN_EMAILS members are immutable bootstrap admins (locked).
export function UserSettings(): JSX.Element {
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
      <button ref={btnRef} className="btn" onClick={handleOpen} title="Manage user roles (admin)">
        <span>Users</span>
      </button>
      {open && anchor && <UsersPopover ref={popRef} anchor={anchor} />}
    </>
  );
}

const UsersPopover = forwardRef<HTMLDivElement, { anchor: DOMRect }>(function UsersPopover({ anchor }, ref) {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchUsers();
        if (!cancelled) setUsers(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load users");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setRole = (email: string, role: Role): void => {
    void patchUserRole(email, role)
      .then(() => {
        setUsers((prev) => prev?.map((u) => (u.email === email ? { ...u, role } : u)) ?? prev);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to update role"));
  };

  const addUser = (): void => {
    const email = newEmail.trim();
    if (!email) return;
    void createUser(email, newRole)
      .then((u) => {
        setUsers((prev) => [...(prev ?? []).filter((x) => x.email !== u.email), u].sort((a, b) => a.email.localeCompare(b.email)));
        setNewEmail("");
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to add user"));
  };

  return (
    <div
      ref={ref}
      className="popover scope-pop"
      style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right), minWidth: 340 }}
      role="dialog"
    >
      <div className="pop-section">
        <div className="pop-label">Users</div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          viewer = read-only · editor = all writes · admin = editor + settings + roles.
          New sign-ins default to viewer.
        </div>
      </div>
      {error && <div className="pop-section users-error">{error}</div>}
      <div className="pop-section">
        {users === null && !error ? (
          <div className="scope-help">Loading…</div>
        ) : users && users.length === 0 ? (
          <div className="scope-help">No users have signed in yet.</div>
        ) : (
          users?.map((u) => (
            <div key={u.email} className="users-row">
              <span className="users-email" title={u.name ?? u.email}>{u.email}</span>
              {u.envAdmin ? (
                <span className="users-locked" title="In ADMIN_EMAILS — immutable bootstrap admin">admin 🔒</span>
              ) : (
                <select
                  className="users-role-select"
                  value={u.role}
                  onChange={(e) => setRole(u.email, e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              )}
            </div>
          ))
        )}
      </div>
      <div className="pop-section">
        <div className="users-add-row">
          <input
            className="users-add-input"
            type="email"
            placeholder="email@katalon.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addUser(); }}
          />
          <select className="users-role-select" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button className="btn" onClick={addUser} disabled={!newEmail.trim()}>Add</button>
        </div>
        <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
          Pre-provision a teammate before their first sign-in — the role sticks when they log in.
        </div>
      </div>
    </div>
  );
});
