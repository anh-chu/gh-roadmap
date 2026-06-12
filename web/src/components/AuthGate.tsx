import { App } from "../App";
import { useAuth } from "../hooks/useAuth";
import { setSessionRole } from "../lib/role";
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

  // Set before App mounts so every component's canEdit() reads the right role.
  // No-auth localhost mode (user null) = local admin, role system dormant.
  setSessionRole(me.user?.role ?? "admin");
  return <App authUser={me.user} initialTheme={me.theme} />;
}
