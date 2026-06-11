const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Your account isn't in an allowed domain for this workspace.",
  unverified_email: "Your Google email isn't verified.",
  bad_state: "Login session expired — please try again.",
  exchange_failed: "Could not complete sign-in with Google. Please try again.",
  no_code: "Sign-in was cancelled.",
};

export function LoginScreen(): JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const errKey = params.get("auth_error");
  const errMsg = errKey ? ERROR_MESSAGES[errKey] ?? "Sign-in failed. Please try again." : null;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg, #0e1116)",
      }}
    >
      <div
        style={{
          width: 340,
          padding: "32px 28px",
          borderRadius: 12,
          background: "var(--panel, #161b22)",
          border: "1px solid var(--line, #232a33)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Roadmap</div>
        <div style={{ fontSize: 13, color: "var(--ink-4, #8b949e)", marginBottom: 24 }}>
          Sign in to continue
        </div>
        {errMsg && (
          <div
            role="alert"
            style={{
              background: "rgba(200, 60, 60, 0.08)",
              color: "var(--red, #c83c3c)",
              border: "1px solid rgba(200, 60, 60, 0.25)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
              marginBottom: 16,
            }}
          >
            {errMsg}
          </div>
        )}
        <a
          href="/api/auth/login"
          className="btn primary"
          style={{ display: "block", textDecoration: "none", textAlign: "center" }}
        >
          <span>Sign in with Google</span>
        </a>
      </div>
    </main>
  );
}
