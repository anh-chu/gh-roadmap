import { App } from "../App";
import { useAuth } from "../hooks/useAuth";
import { LoginScreen } from "./LoginScreen";

// Wraps the app: when Google OAuth is enabled and there's no session, show the login screen.
// When auth is disabled (single-user localhost) the user is treated as an admin.
export function AuthGate(): JSX.Element {
  const { me, loading } = useAuth();

  if (loading || !me) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "var(--ink-4)" }}>
        Loading…
      </main>
    );
  }

  if (me.authEnabled && !me.user) return <LoginScreen />;

  return <App authUser={me.user} />;
}
