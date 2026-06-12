import type { Role } from "../../../shared/types";

// Module-level role, set once by AuthGate before <App> mounts (role is fixed per session).
// Default "admin" matches the no-auth localhost mode where the role system is dormant.
let role: Role = "admin";

export function setSessionRole(r: Role): void {
  role = r;
}

// Viewer UX rule: a viewer's write is NEVER achievable, so write affordances are hidden or
// disabled outright (dead buttons that always 403 are bad UX). This is deliberately the
// OPPOSITE of the GitHub write-identity pattern (lib/api.ts setGithubConnectHandler), where an
// unlinked editor's write IS achievable after connecting — those buttons stay live and the
// shared 409 interceptor prompts to connect. Don't "unify" the two patterns.
export function canEdit(): boolean {
  return role !== "viewer";
}
