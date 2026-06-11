import type { FastifyInstance } from "fastify";
import { envAdminsConfigured, isEnvAdmin, requireAdmin } from "../auth.js";
import { getUser, listUsers, setUserRole, upsertUserWithRole } from "../db.js";
import type { AppUser, Role } from "../../../shared/types.js";

const VALID_ROLES: readonly Role[] = ["viewer", "editor", "admin"];

// Role management (admin-only). Roles: viewer (read-only) / editor (all app writes) /
// admin (editor + roles + AI settings + export/import). ADMIN_EMAILS members are the
// immutable bootstrap — always admin, not editable here.
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: requireAdmin }, async (): Promise<AppUser[]> =>
    listUsers().map((u) => ({
      email: u.email,
      name: u.name,
      role: isEnvAdmin(u.email) ? "admin" : u.role,
      envAdmin: isEnvAdmin(u.email),
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    })),
  );

  // Pre-provision: an admin can create a user (and set their role) before that user has
  // ever signed in. Login later preserves the pre-set role (upsertUserOnLogin only
  // refreshes the name).
  app.post<{ Body: { email?: string; role?: string } }>(
    "/api/users",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "role"],
          properties: { email: { type: "string" }, role: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const email = (req.body.email ?? "").trim().toLowerCase();
      const role = req.body.role as Role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ error: "invalid email" });
      }
      if (!VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `role must be one of ${VALID_ROLES.join(", ")}` });
      }
      if (isEnvAdmin(email)) {
        return reply.code(400).send({ error: "this user is in ADMIN_EMAILS — bootstrap admins are immutable" });
      }
      upsertUserWithRole(email, role);
      const u = getUser(email)!;
      const out: AppUser = {
        email: u.email,
        name: u.name,
        role: u.role,
        envAdmin: false,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      };
      return reply.code(201).send(out);
    },
  );

  app.patch<{ Params: { email: string }; Body: { role?: string } }>(
    "/api/users/:email/role",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["role"],
          properties: { role: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const email = req.params.email.toLowerCase();
      const role = req.body.role as Role;
      if (!VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `role must be one of ${VALID_ROLES.join(", ")}` });
      }
      if (isEnvAdmin(email)) {
        return reply.code(400).send({ error: "this user is in ADMIN_EMAILS — bootstrap admins are immutable" });
      }
      const user = getUser(email);
      if (!user) return reply.code(404).send({ error: "user not found" });
      // Lock-out guard: don't demote the last db admin unless env bootstrap admins exist.
      // (A configured ADMIN_EMAILS makes true lock-out impossible; this is belt-and-suspenders.)
      if (user.role === "admin" && role !== "admin" && !envAdminsConfigured()) {
        const otherDbAdmins = listUsers().filter((u) => u.role === "admin" && u.email !== email).length;
        if (otherDbAdmins === 0) {
          return reply.code(400).send({ error: "cannot demote the last admin" });
        }
      }
      setUserRole(email, role);
      return { email, role };
    },
  );
}
