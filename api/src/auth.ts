// Google OAuth login + session gating.
//
// Auth is OPTIONAL and off by default: when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are
// unset the app behaves exactly as the original single-user localhost tool — every request
// is treated as a local admin. Set both to require "Sign in with Google" for the whole app.
//
// This layer only authenticates the *human* (who may open the app). It does NOT change the
// GitHub *write* identity — writes go through the shared service identity (serviceOctokit():
// a GitHub App installation token or GITHUB_TOKEN) unless per-user GitHub OAuth is enabled.
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "../../shared/types.js";
import { getUser } from "./db.js";

export interface SessionUser {
  email: string;
  name: string;
  picture: string | null;
  role: Role;
  // Derived: role === "admin". Kept so existing admin gating (AI settings, export/import) is untouched.
  isAdmin: boolean;
}

// Augment Fastify's request with the resolved user (set by the global preHandler).
declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser;
  }
}

const COOKIE_NAME = "rm_session";
const STATE_COOKIE = "rm_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
const REDIRECT_OVERRIDE = (process.env.GOOGLE_OAUTH_REDIRECT ?? "").trim();
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
const SESSION_SECRET = (process.env.SESSION_SECRET ?? "").trim() || CLIENT_SECRET;
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

// Auth is enabled only when both Google credentials are present.
export function authEnabled(): boolean {
  return CLIENT_ID.length > 0 && CLIENT_SECRET.length > 0;
}

// When auth is off (local single-user), everyone is a local admin — the role system is dormant.
const LOCAL_USER: SessionUser = { email: "local", name: "Local", picture: null, role: "admin", isAdmin: true };

// True only for exact ADMIN_EMAILS membership — the immutable bootstrap-admin list.
// (Distinct from roleFor's empty-list default, which keeps the small-team behaviour.)
export function isEnvAdmin(email: string): boolean {
  return ADMIN_EMAILS.has(email.toLowerCase());
}

export function envAdminsConfigured(): boolean {
  return ADMIN_EMAILS.size > 0;
}

// Role resolution: env bootstrap admins → admin; otherwise the users-table role set by an
// admin in-app; otherwise viewer (default for any newly signed-in user).
export function roleFor(email: string): Role {
  // No ADMIN_EMAILS configured → every signed-in user is an admin (small team default, pre-roles behaviour).
  if (ADMIN_EMAILS.size === 0) return "admin";
  const lower = email.toLowerCase();
  if (ADMIN_EMAILS.has(lower)) return "admin";
  return getUser(lower)?.role ?? "viewer";
}

export function emailAllowed(email: string): boolean {
  if (!ALLOWED_DOMAIN) return true;
  return email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

// ---- stateless signed-cookie session -------------------------------------------------

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function makeSession(user: Omit<SessionUser, "isAdmin" | "role">): string {
  const body = { email: user.email, name: user.name, picture: user.picture, exp: Date.now() + SESSION_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  // Constant-time compare; lengths must match first.
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email: string; name: string; picture: string | null; exp: number;
    };
    if (typeof body.exp !== "number" || body.exp < Date.now()) return null;
    // Role is resolved fresh on every request (env list + users table), never baked into the cookie.
    const role = roleFor(body.email);
    return { email: body.email, name: body.name, picture: body.picture ?? null, role, isAdmin: role === "admin" };
  } catch {
    return null;
  }
}

// ---- request helpers -----------------------------------------------------------------

const secureCookie = (req: FastifyRequest): boolean => {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return proto === "https";
};

export function userFromRequest(req: FastifyRequest): SessionUser | null {
  if (!authEnabled()) return LOCAL_USER;
  return readSession(req.cookies?.[COOKIE_NAME]);
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, user: Omit<SessionUser, "isAdmin" | "role">): void {
  reply.setCookie(COOKIE_NAME, makeSession(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

// ---- Google OAuth flow ---------------------------------------------------------------

function redirectUri(req: FastifyRequest): string {
  if (REDIRECT_OVERRIDE) return REDIRECT_OVERRIDE;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.headers.host;
  return `${proto}://${host}/api/auth/callback`;
}

export function buildAuthUrl(req: FastifyRequest, reply: FastifyReply): string {
  const state = crypto.randomBytes(16).toString("base64url");
  reply.setCookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function verifyState(req: FastifyRequest, reply: FastifyReply, state: string | undefined): boolean {
  const expected = req.cookies?.[STATE_COOKIE];
  reply.clearCookie(STATE_COOKIE, { path: "/" });
  return !!state && !!expected && state === expected;
}

interface GoogleUser {
  email: string;
  name: string;
  picture: string | null;
  verified: boolean;
}

export async function exchangeCodeForUser(req: FastifyRequest, code: string): Promise<GoogleUser> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error(`google token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("google token exchange returned no access_token");

  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`google userinfo failed (${userRes.status})`);
  const info = (await userRes.json()) as {
    email?: string; email_verified?: boolean; name?: string; picture?: string;
  };
  if (!info.email) throw new Error("google userinfo returned no email");
  return {
    email: info.email,
    name: info.name ?? info.email,
    picture: info.picture ?? null,
    verified: info.email_verified !== false,
  };
}

// preHandler that rejects non-admin users. Use on admin-only endpoints (export/import).
// When auth is off, req.user is the local admin so this is a no-op.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.isAdmin) {
    reply.code(403).send({ error: "admin access required" });
  }
}

export { COOKIE_NAME };
