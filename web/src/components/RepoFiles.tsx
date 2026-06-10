import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RepoFile } from "../../../shared/types";
import { fetchRepoFile } from "../lib/api";
import { extractFileRefs, type FileRef } from "../lib/fileRefs";

const MD_RE = /\.(md|markdown|mdx)$/i;

// Drop a leading YAML frontmatter fence so the rendered markdown doesn't open with
// a stray <hr> + raw key:value lines. View-only — the GitHub link shows the original.
function stripFrontmatter(src: string): string {
  if (!src.startsWith("---\n")) return src;
  const end = src.indexOf("\n---", 4);
  if (end === -1) return src;
  const after = src.indexOf("\n", end + 1);
  return after === -1 ? "" : src.slice(after + 1).replace(/^\s+/, "");
}

interface RepoFilesProps {
  body: string | null;
  repoSlug: string | null;
}

// "Referenced files" — read-only viewer for files a GitHub issue body points at.
// Renders one chip per detected ref; clicking expands the file content inline.
// Bare-path chips (no pinned ref) render dashed to signal they're best-effort.
export function RepoFiles({ body, repoSlug }: RepoFilesProps): JSX.Element | null {
  const refs = useMemo(() => extractFileRefs(body, repoSlug), [body, repoSlug]);
  if (refs.length === 0) return null;
  return (
    <div className="d-files">
      <h4>Referenced files</h4>
      {refs.map((ref) => (
        <RepoFileRow key={`${ref.path}@${ref.ref ?? ""}`} fileRef={ref} repoSlug={repoSlug} />
      ))}
    </div>
  );
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; file: RepoFile }
  | { status: "error"; message: string };

function RepoFileRow({ fileRef, repoSlug }: { fileRef: FileRef; repoSlug: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  const ghUrl =
    fileRef.url ??
    (repoSlug ? `https://github.com/${repoSlug}/blob/HEAD/${fileRef.path}` : null);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && state.status === "idle") {
      setState({ status: "loading" });
      fetchRepoFile(fileRef.path, fileRef.ref)
        .then((file) => setState({ status: "ok", file }))
        .catch((e: unknown) =>
          setState({ status: "error", message: e instanceof Error ? e.message : "Failed to load" }),
        );
    }
  };

  return (
    <div className="d-file">
      <button
        className={"d-file-chip" + (fileRef.kind === "path" ? " tentative" : "") + (open ? " open" : "")}
        onClick={toggle}
        title={fileRef.kind === "path" ? "Best-effort path — resolved on the default branch" : fileRef.path}
      >
        <span className="d-file-caret" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="d-file-path">{fileRef.path}</span>
        {fileRef.ref && <span className="d-file-ref">@{shortRef(fileRef.ref)}</span>}
      </button>
      {open && (
        <div className="d-file-view">
          {state.status === "loading" && <div className="d-file-msg">Loading…</div>}
          {state.status === "error" && (
            <div className="d-file-msg d-file-err">
              {fileRef.kind === "path"
                ? `Not found on the default branch — ${state.message}`
                : state.message}
            </div>
          )}
          {state.status === "ok" && (
            <>
              {MD_RE.test(fileRef.path) ? (
                <div className="d-desc d-file-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {stripFrontmatter(state.file.content)}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="d-file-code">
                  <code>{state.file.content}</code>
                </pre>
              )}
              {(state.file.htmlUrl ?? ghUrl) && (
                <a
                  className="d-file-gh"
                  href={state.file.htmlUrl ?? ghUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  View original on GitHub ↗
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A 40-char commit sha shortens to 7; branch/tag names pass through.
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
