import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
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
import { getKv, getUser, getUserGithub, setKv, setUserApiToken, upsertUserOnLogin } from "../db.js";
import { encryptToken, decryptToken, tokenEncKeySet } from "../crypto.js";
import { githubOAuthEnabled } from "../githubWriteIdentity.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Who am I — drives the frontend login gate + admin-control visibility.
  app.get("/api/auth/me", async (req): Promise<AuthMe> => {
    const enabled = authEnabled();
    const user = userFromRequest(req);
    // GitHub link state (layer 3) — passive status for the UserMenu + connect-prompt copy.
    const ghEnabled = githubOAuthEnabled();
    const gh = ghEnabled && user ? getUserGithub(user.email) : undefined;
    // Per-user theme — stored in kv keyed by email (works for the "local" user too).
    const theme = user && getKv(`theme:${user.email}`) === "dark" ? "dark" : "light";
    return {
      authEnabled: enabled,
      user: user
        ? { email: user.email, name: user.name, picture: user.picture, role: user.role, isAdmin: user.isAdmin }
        : null,
      githubOauthEnabled: ghEnabled,
      githubLinked: Boolean(gh?.github_token_enc),
      githubLogin: gh?.github_login ?? null,
      theme,
    };
  });

  // Persist the caller's theme preference. Per-user, not admin-gated (it's a personal pref,
  // unlike workspace_config). kv keyed by email so it follows the account across browsers.
  app.patch<{ Body: { theme?: string } }>(
    "/api/auth/theme",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["theme"],
          properties: { theme: { type: "string", enum: ["light", "dark"] } },
        },
      },
    },
    async (req, reply) => {
      const user = userFromRequest(req);
      if (!user) return reply.code(401).send({ error: "not signed in" });
      setKv(`theme:${user.email}`, req.body.theme === "dark" ? "dark" : "light");
      return { ok: true };
    },
  );

  // Caller API token (capture-scoped bearer). Stored two ways: a sha256 hash for the O(1)
  // gate lookup, plus an AES-GCM copy so the capture guide can prefill the live token. The
  // encrypted copy only exists when TOKEN_ENC_KEY is set (layer 3); without it the token still
  // works (hash gate) but can't be shown again, so the guide falls back to a <token> placeholder.
  const mintToken = (email: string): string => {
    const token = crypto.randomBytes(24).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    setUserApiToken(email, hash, tokenEncKeySet() ? encryptToken(token) : null);
    return token;
  };

  // Fetch the caller's live token, minting one on first call ("token by default"). Returns
  // token:null when a token exists but can't be recovered (no enc key) — caller shows a placeholder.
  app.get("/api/me/token", async (req, reply) => {
    const user = userFromRequest(req);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    const row = getUser(user.email);
    if (!row?.api_token_hash) return { token: mintToken(user.email) };
    if (row.api_token_enc && tokenEncKeySet()) {
      try {
        return { token: decryptToken(row.api_token_enc) };
      } catch {
        return { token: null };
      }
    }
    return { token: null };
  });

  // Rotate: mint a fresh token, overwriting the old (which immediately stops working).
  app.post("/api/me/token", async (req, reply) => {
    const user = userFromRequest(req);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    return { token: mintToken(user.email) };
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
