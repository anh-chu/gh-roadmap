import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue } from "../../../shared/types";
import { IssueRefMarkdown } from "./IssueRefMarkdown";

interface AiBlockProps {
  label: string;
  content: string;
  model: string;
  generatedAt: string;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  issuesByNum?: Map<number, Issue>;
  onOpenIssue?: (i: Issue) => void;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

export function AiBlock(props: AiBlockProps): JSX.Element {
  const { label, content, model, generatedAt, loading, error, onRefresh, issuesByNum, onOpenIssue } = props;
  const canRefify = issuesByNum !== undefined && onOpenIssue !== undefined;
  return (
    <div className="ai-block">
      <div className="ai-block-head">
        <h4>{label}</h4>
        <span className="ai-block-meta">
          {content ? `${model} · ${relTime(generatedAt)}` : ""}
        </span>
        <button
          type="button"
          className={"ai-refresh-btn" + (loading ? " spinning" : "")}
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh"
          title="Refresh"
        >
          ⟳
        </button>
      </div>
      {loading && !content ? (
        <div className="ai-content">
          <div className="skel-bar skel-bar-wide" />
          <div className="skel-bar skel-bar-wide" />
          <div className="skel-bar skel-bar-wide" style={{ width: "60%" }} />
        </div>
      ) : error ? (
        <div className="ai-error">
          Couldn't load {label.toLowerCase()}. <button type="button" onClick={onRefresh}>⟳</button>
        </div>
      ) : (
        <div className="ai-content">
          {canRefify ? (
            <IssueRefMarkdown text={content} issuesByNum={issuesByNum} onOpen={onOpenIssue} />
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          )}
        </div>
      )}
    </div>
  );
}
