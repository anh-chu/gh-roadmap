// Per-user GitHub write identity (layer 3) — the single policy module that answers
// "as whom on GitHub?" for user-initiated writes. By the time a request gets here the
// role layer has already 403'd viewers, so the caller is an authorized writer; this
// module only resolves which Octokit performs the write.
//
// Policy (locked in docs/github-oauth-write-identity-plan.md):
// - GitHub OAuth disabled → serviceOctokit() — localhost / Google-only deploys behave
//   exactly as before this layer existed.
// - Enabled + user linked → decrypt the stored token, fresh Octokit per call (no
//   per-user client cache — avoids token-lifetime/invalidation state).
// - Enabled + unlinked → GithubLinkRequired → 409 github_not_linked (writes blocked,
//   reads untouched; the UI shows a connect prompt at the moment of the action).
//
// Background contexts (sync, webhook, boot reconcile, scheduled jobs) never come through
// here — they pass serviceOctokit() explicitly.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Octokit } from "octokit";
import { decryptToken } from "./crypto.js";
import { getUserGithub, unlinkUserGithub } from "./db.js";
import { octokitForToken, serviceOctokit } from "./github.js";
import { githubOauthEnabled } from "./githubOauth.js";

export class GithubLinkRequired extends Error {
  constructor() {
    super("github account not linked");
    this.name = "GithubLinkRequired";
  }
}

export function githubOAuthEnabled(): boolean {
  return githubOauthEnabled();
}

// The single resolution path. Returns the email only when a *user* token was used,
// so the 401-unlink in runGithubWrite can never fire against the service token.
function resolveIdentity(req: FastifyRequest): { octo: Octokit; userEmail: string | null } {
  if (!githubOauthEnabled()) return { octo: serviceOctokit(), userEmail: null };
  const email = req.user.email;
  const gh = getUserGithub(email);
  if (!gh?.github_token_enc) throw new GithubLinkRequired();
  return { octo: octokitForToken(decryptToken(gh.github_token_enc)), userEmail: email };
}

export async function resolveWriteOctokit(req: FastifyRequest): Promise<Octokit> {
  return resolveIdentity(req).octo;
}

function isGithub401(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 401;
}

// One wrapper for every user-initiated GitHub write route. Resolves the identity, runs
// the body, and maps the two identity failures to 409s:
// - GithubLinkRequired           → 409 { error: "github_not_linked" }
// - GitHub 401 on a USER token   → unlink (token revoked) + 409 { error: "github_reauth_required" }
//   ONLY 401 — a 403 is branch protection / rate limit / org policy, a normal denial,
//   not a dead token, and must never unlink.
// All other errors rethrow so each route's existing catch (502 etc.) keeps working.
// Returns undefined after sending a 409 — callers check `reply.sent` (or undefined) and bail.
export async function runGithubWrite<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (octo: Octokit) => Promise<T>,
): Promise<T | undefined> {
  let identity: { octo: Octokit; userEmail: string | null };
  try {
    identity = resolveIdentity(req);
  } catch (err) {
    if (err instanceof GithubLinkRequired) {
      await reply.code(409).send({ error: "github_not_linked" });
      return undefined;
    }
    throw err;
  }
  try {
    return await fn(identity.octo);
  } catch (err) {
    if (identity.userEmail !== null && isGithub401(err)) {
      unlinkUserGithub(identity.userEmail);
      await reply.code(409).send({ error: "github_reauth_required" });
      return undefined;
    }
    throw err;
  }
}
