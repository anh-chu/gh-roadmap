import type { FastifyInstance } from "fastify";
import {
  authEnabled,
  buildAuthUrl,
  clearSessionCookie,
  emailAllowed,
  exchangeCodeForUser,
  setSessionCookie,
  userFromRequest,
  verifyState,
} from "../auth.js";
import type { AuthMe } from "../../../shared/types.js";
import { upsertUserOnLogin } from "../db.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Who am I — drives the frontend login gate + admin-control visibility.
  app.get("/api/auth/me", async (req): Promise<AuthMe> => {
    const enabled = authEnabled();
    const user = userFromRequest(req);
    return {
      authEnabled: enabled,
      user: user
        ? { email: user.email, name: user.name, picture: user.picture, role: user.role, isAdmin: user.isAdmin }
        : null,
    };
  });

  // Kick off the Google consent flow.
  app.get("/api/auth/login", async (req, reply) => {
    if (!authEnabled()) return reply.redirect("/");
    return reply.redirect(buildAuthUrl(req, reply));
  });

  // OAuth callback: exchange code, enforce domain whitelist, set session cookie.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/callback",
    async (req, reply) => {
      if (!authEnabled()) return reply.redirect("/");
      const { code, state, error } = req.query;
      if (error) return reply.redirect(`/?auth_error=${encodeURIComponent(error)}`);
      if (!verifyState(req, reply, state)) return reply.redirect("/?auth_error=bad_state");
      if (!code) return reply.redirect("/?auth_error=no_code");

      try {
        const gu = await exchangeCodeForUser(req, code);
        if (!gu.verified) return reply.redirect("/?auth_error=unverified_email");
        if (!emailAllowed(gu.email)) return reply.redirect("/?auth_error=domain_not_allowed");
        const email = gu.email.toLowerCase(); // emails are lowercase everywhere (users table, ADMIN_EMAILS)
        upsertUserOnLogin(email, gu.name); // role preserved (default viewer on first sight)
        setSessionCookie(req, reply, { email, name: gu.name, picture: gu.picture });
        return reply.redirect("/");
      } catch (err) {
        req.log.error({ err }, "google oauth callback failed");
        return reply.redirect("/?auth_error=exchange_failed");
      }
    },
  );

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
}
