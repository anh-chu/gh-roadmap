import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../../../shared/types";
import { logout, unlinkGithub } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

// Avatar button → popout dropdown with the signed-in identity and an explicit Sign out button.
// Only rendered when auth is enabled (authUser is non-null).
export function UserMenu({ user }: { user: AuthUser }): JSX.Element {
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

  const initial = user.name?.[0]?.toUpperCase() ?? user.email[0]?.toUpperCase() ?? "?";

  // GitHub write-identity link state — PASSIVE status only. Write buttons elsewhere are
  // never gated on this; the shared 409 interceptor raises the connect prompt on attempt.
  const { me } = useAuth();
  const ghEnabled = me?.githubOauthEnabled ?? false;

  return (
    <>
      <button ref={btnRef} className="av" onClick={handleOpen} title={user.email}>
        {initial}
      </button>
      {open && anchor && (
        <div
          ref={popRef}
          className="popover scope-pop"
          style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right), minWidth: 220 }}
          role="dialog"
        >
          <div className="pop-section">
            <div className="pop-label">{user.name}</div>
            <div className="scope-help" style={{ fontSize: 11, opacity: 0.75 }}>
              {user.email}
              {user.isAdmin && " · admin"}
            </div>
          </div>
          {ghEnabled && (
            <div className="pop-section">
              {me?.githubLinked ? (
                <div className="scope-help" style={{ fontSize: 11, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>GitHub: @{me.githubLogin}</span>
                  <button
                    className="btn"
                    onClick={() => { void unlinkGithub().then(() => window.location.reload()); }}
                  >
                    <span>Disconnect</span>
                  </button>
                </div>
              ) : (
                <button
                  className="btn"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => { window.location.href = "/api/github/login"; }}
                >
                  <span>Connect GitHub</span>
                </button>
              )}
            </div>
          )}
          <div className="pop-section">
            <button
              className="btn"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => { void logout().then(() => window.location.reload()); }}
            >
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
