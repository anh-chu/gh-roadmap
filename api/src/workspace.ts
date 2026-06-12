// Active-workspace resolution (multi-pod step 3).
//
// The active pod is a pure UI preference carried in an unsigned cookie (rm_workspace).
// No access decision rides on it — viewing any pod only requires a valid session — so
// the cookie is validated merely as "points at a live (non-archived) pod" and falls
// back to the first non-archived pod on anything else. Never null: migration seeds
// workspace 1 ('mht') and there is no delete (archive only).
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";
import type { Workspace } from "../../shared/types.js";

const COOKIE_NAME = "rm_workspace";
const COOKIE_TTL_S = 365 * 24 * 60 * 60;

// Resolved per request by the global onRequest hook in server.ts.
declare module "fastify" {
  interface FastifyRequest {
    workspaceId: number;
  }
}

// Returns ALL pods (archived included, archivedAt set): the plain switcher filters to
// live pods client-side; the admin manage popover needs archived rows to unarchive.
export function listWorkspaces(): Workspace[] {
  return db()
    .prepare("SELECT id, slug, name, archived_at AS archivedAt FROM workspace_config ORDER BY id ASC")
    .all() as Workspace[];
}

export function getWorkspace(id: number): Workspace | undefined {
  return db()
    .prepare("SELECT id, slug, name, archived_at AS archivedAt FROM workspace_config WHERE id = ? AND archived_at IS NULL")
    .get(id) as Workspace | undefined;
}

// Fallback / no-request contexts (boot backfill, daily snapshot, AI task defaults).
// Step 4 of the plan makes the background jobs iterate all workspaces; until then they
// operate on the first pod — identical behaviour to the single-workspace world.
export function defaultWorkspaceId(): number {
  const row = db()
    .prepare("SELECT id FROM workspace_config WHERE archived_at IS NULL ORDER BY id ASC LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id ?? 1;
}

// Cookie id if it points at a live pod, else first non-archived pod.
export function activeWorkspaceId(req: FastifyRequest): number {
  const raw = req.cookies?.[COOKIE_NAME];
  if (raw !== undefined) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && getWorkspace(id)) return id;
  }
  return defaultWorkspaceId();
}

export function setActiveWorkspaceCookie(req: FastifyRequest, reply: FastifyReply, id: number): void {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  reply.setCookie(COOKIE_NAME, String(id), {
    httpOnly: true,
    sameSite: "lax",
    secure: proto === "https",
    path: "/",
    maxAge: COOKIE_TTL_S,
  });
}
