// GitHub OAuth (per-user write identity — layer 3). Mirrors the Google flow shape in
// auth.ts but lives in its own module with its OWN state cookie. This flow only LINKS a
// GitHub identity to an already-signed-in Google user; it never creates app sessions.
//
// Logging hygiene: never log tokens, OAuth code/state, or raw response bodies from the
// token exchange / /user calls.
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authEnabled } from "./auth.js";
import { assertTokenEncKeyValid, tokenEncKeySet } from "./crypto.js";

const STATE_COOKIE = "rm_gh_oauth_state";

const CLIENT_ID = (process.env.GITHUB_OAUTH_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "").trim();
const REDIRECT_OVERRIDE = (process.env.GITHUB_OAUTH_REDIRECT ?? "").trim();

// Feature enabled = BOTH client id and secret present.
export function githubOauthEnabled(): boolean {
  return CLIENT_ID.length > 0 && CLIENT_SECRET.length > 0;
}

// Boot guards — refuse to boot on misconfiguration rather than limp along.
// Called from server.ts before listening. Throws with a human-readable reason.
export function assertGithubOauthBootConfig(): void {
  const idSet = CLIENT_ID.length > 0;
  const secretSet = CLIENT_SECRET.length > 0;
  if (idSet !== secretSet) {
    throw new Error(
      "GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET: exactly one is set — set both to enable per-user GitHub writes, or neither",
    );
  }
  if (!githubOauthEnabled()) return; // feature off — TOKEN_ENC_KEY deliberately NOT validated
  if (!tokenEncKeySet()) {
    throw new Error("GitHub OAuth is enabled but TOKEN_ENC_KEY is unset — refusing to store plaintext tokens");
  }
  assertTokenEncKeyValid();
  if (!authEnabled()) {
    throw new Error(
      "GitHub OAuth is enabled but Google login is not (GOOGLE_CLIENT_ID/SECRET unset) — per-user GitHub identity requires authenticated users",
    );
  }
}

// ---- consent URL + state cookie --------------------------------------------------------

const secureCookie = (req: FastifyRequest): boolean => {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return proto === "https";
};

function redirectUri(req: FastifyRequest): string {
  if (REDIRECT_OVERRIDE) return REDIRECT_OVERRIDE;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return `${proto}://${req.headers.host}/api/github/callback`;
}

export function buildGithubAuthUrl(req: FastifyRequest, reply: FastifyReply): string {
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
    scope: "repo",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function verifyGithubState(req: FastifyRequest, reply: FastifyReply, state: string | undefined): boolean {
  const expected = req.cookies?.[STATE_COOKIE];
  reply.clearCookie(STATE_COOKIE, { path: "/" });
  return !!state && !!expected && state === expected;
}

// ---- code → token exchange --------------------------------------------------------------

export interface GithubTokenResult {
  token: string;
  login: string;
  scopes: string[]; // granted scopes from X-OAuth-Scopes (users can grant fewer than requested)
}

export async function exchangeCodeForGithubToken(req: FastifyRequest, code: string): Promise<GithubTokenResult> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
    }),
  });
  if (!tokenRes.ok) throw new Error(`github token exchange failed (${tokenRes.status})`);
  const body = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`github token exchange returned no access_token (${body.error ?? "unknown"})`);
  const token = body.access_token;

  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) throw new Error(`github /user failed (${userRes.status})`);
  const scopes = (userRes.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) throw new Error("github /user returned no login");
  return { token, login: user.login, scopes };
}

// Validation (c): the token can reach the configured target repo. Subsumes
// "org member / collaborator" without rejecting legitimate outside collaborators.
export async function tokenCanAccessRepo(token: string, ownerRepo: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  return res.ok;
}
