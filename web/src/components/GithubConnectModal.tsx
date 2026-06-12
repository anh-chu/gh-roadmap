import type { GithubConnectReason } from "../lib/api";

// App-level Connect/Reconnect prompt for the GitHub write-identity gate (layer 3).
// Raised by the shared 409 interceptor in lib/api.ts — never wired per action.
// Write buttons everywhere stay live; this modal IS the enforcement UX: the ask appears
// at the moment of the attempted write, explaining why it needs a linked GitHub account.
export function GithubConnectModal({
  reason,
  onClose,
}: {
  reason: GithubConnectReason | null;
  onClose: () => void;
}): JSX.Element | null {
  if (!reason) return null;
  const reauth = reason === "github_reauth_required";
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{reauth ? "Reconnect GitHub" : "Connect GitHub"}</span>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            {reauth
              ? "Your GitHub authorization is no longer valid (the token was revoked or expired). Reconnect your GitHub account to continue — writes are made as you on GitHub."
              : "This action writes to GitHub as you, so it needs your GitHub account connected. Connect once and retry the action."}
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}><span>Cancel</span></button>
          <button
            className="btn primary"
            onClick={() => { window.location.href = "/api/github/login"; }}
          >
            <span>{reauth ? "Reconnect GitHub" : "Connect GitHub"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
