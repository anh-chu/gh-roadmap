// GitHub link/unlink endpoints (per-user write identity — layer 3).
//
// Registered BEHIND the Google session gate in server.ts: /api/github/* is not in the
// public-path exemptions, so every handler here already has a signed-in req.user.
// The global viewer gate blocks non-GET for viewers — that correctly covers POST /unlink
// (viewers can never link, so they never need to unlink); GET login/callback pass through.
import type { FastifyInstance } from "fastify";
import { encryptToken } from "../crypto.js";
import { linkUserGithub, unlinkUserGithub } from "../db.js";
import { getRepoSlug } from "../github.js";
import {
  buildGithubAuthUrl,
  exchangeCodeForGithubToken,
  githubOauthEnabled,
  tokenCanAccessRepo,
  verifyGithubState,
} from "../githubOauth.js";

export async function githubAuthRoutes(app: FastifyInstance): Promise<void> {
  // Kick off the GitHub consent flow (signed-in only — enforced by the global session gate).
  app.get("/api/github/login", async (_req, reply) => {
    if (!githubOauthEnabled()) return reply.redirect("/");
    return reply.redirect(buildGithubAuthUrl(_req, reply));
  });

  // Callback: exchange code → token, validate before storing, then encrypt + link.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/github/callback",
    async (req, reply) => {
      if (!githubOauthEnabled()) return reply.redirect("/");
      const { code, state, error } = req.query;
      if (error) return reply.redirect(`/?github_error=${encodeURIComponent(error)}`);
      if (!verifyGithubState(req, reply, state)) return reply.redirect("/?github_error=bad_state");
      if (!code) return reply.redirect("/?github_error=no_code");

      try {
        const gh = await exchangeCodeForGithubToken(req, code);
        // (a) classic OAuth App tokens carry X-OAuth-Scopes and must include repo (users can
        // grant fewer than requested). GitHub App user-to-server tokens have NO scopes header —
        // their access is the app-permissions ∩ installation set, validated by check (c) below.
        const isGithubAppToken = gh.scopes.length === 0;
        if (!isGithubAppToken && !gh.scopes.includes("repo")) {
          return reply.redirect("/?github_error=missing_repo_scope");
        }
        // (c) the token must reach the configured target repo.
        const repo = getRepoSlug();
        if (!repo || !(await tokenCanAccessRepo(gh.token, repo))) {
          return reply.redirect("/?github_error=no_repo_access");
        }
        linkUserGithub(req.user.email, gh.login, encryptToken(gh.token));
        return reply.redirect("/");
      } catch (err) {
        // Hygiene: log the error only — never the code/state or token-exchange payloads.
        req.log.error({ err: (err as Error).message }, "github oauth callback failed");
        return reply.redirect("/?github_error=exchange_failed");
      }
    },
  );

  app.post("/api/github/unlink", async (req) => {
    unlinkUserGithub(req.user.email);
    return { ok: true };
  });
}
