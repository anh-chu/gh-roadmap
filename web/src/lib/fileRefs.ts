// Detect file references in an issue body. Two kinds:
//   blob — a GitHub blob URL (github.com/<owner>/<repo>/blob/<ref>/<path>). Unambiguous:
//          carries repo + ref + path. Only kept when the repo matches the issues repo.
//   path — a bare backtick path (`src/foo.ts`). Best-effort: no ref, may not exist.
//          Resolved lazily on click; a 404 is shown honestly rather than guessed away.

export interface FileRef {
  path: string;
  ref: string | null; // pinned ref (blob URLs only); null = resolve against default branch
  url: string | null; // GitHub blob URL when known
  kind: "blob" | "path";
}

// github.com/<owner>/<repo>/blob/<ref>/<path>[#L..]. Path runs to whitespace or a
// closing markdown-link paren; a trailing #line-anchor is stripped off the path.
const BLOB_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^/\s]+)\/([^\s)]+)/g;

// Inline code spans — the only place a bare path is treated as a file reference.
const CODE_RE = /`([^`\n]+)`/g;

// A bare token reads as a path when it has no spaces, isn't a URL, and either
// contains a slash or ends in a 2–8 char extension (skips `e.g`, `--flag`, `foo()`).
function looksLikePath(tok: string): boolean {
  if (!tok || /\s/.test(tok) || tok.includes("://")) return false;
  if (tok.startsWith("/") || tok.startsWith("-")) return false;
  return tok.includes("/") || /\.[a-zA-Z][a-zA-Z0-9]{1,7}$/.test(tok);
}

export function extractFileRefs(body: string | null, repoSlug: string | null): FileRef[] {
  if (!body) return [];
  const byPath = new Map<string, FileRef>();

  BLOB_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOB_RE.exec(body)) !== null) {
    const [, owner, repo, ref, rawPath] = m;
    if (!owner || !repo || !ref || !rawPath) continue;
    const slug = `${owner}/${repo}`;
    if (repoSlug && slug.toLowerCase() !== repoSlug.toLowerCase()) continue;
    const path = decodeURIComponent(rawPath.replace(/#.*$/, ""));
    if (!path) continue;
    // Blob is higher-confidence than a bare path — let it win the dedupe.
    byPath.set(path, { path, ref, url: m[0].replace(/#.*$/, ""), kind: "blob" });
  }

  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(body)) !== null) {
    const tok = (m[1] ?? "").trim();
    if (!looksLikePath(tok)) continue;
    if (byPath.has(tok)) continue; // a blob ref already covers this path
    byPath.set(tok, { path: tok, ref: null, url: null, kind: "path" });
  }

  return [...byPath.values()];
}
