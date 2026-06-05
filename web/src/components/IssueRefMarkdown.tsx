import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue } from "../../../shared/types";
import { IssueRef } from "./IssueRef";

interface IssueRefMarkdownProps {
  text: string;
  issuesByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
}

interface Ctx {
  issuesByNum: Map<number, Issue>;
  onOpen: (i: Issue) => void;
}

const ISSUE_RE = /#(\d+)\b/g;

function transformString(str: string, ctx: Ctx, keyPrefix: string): ReactNode[] {
  ISSUE_RE.lastIndex = 0;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = ISSUE_RE.exec(str)) !== null) {
    if (m.index > last) parts.push(str.slice(last, m.index));
    const num = Number(m[1]);
    const issue = ctx.issuesByNum.get(num) ?? null;
    parts.push(
      <IssueRef key={`${keyPrefix}-${idx}`} num={num} issue={issue} onOpen={ctx.onOpen} />,
    );
    last = m.index + m[0].length;
    idx++;
  }
  if (last < str.length) parts.push(str.slice(last));
  return parts;
}

// Walk one level: transform string children. For <strong>/<em> elements,
// recurse into their string children too. Other React elements pass through.
function transformChildren(children: ReactNode, ctx: Ctx, keyPrefix = "ir"): ReactNode {
  const out: ReactNode[] = [];
  Children.forEach(children, (child, i) => {
    if (typeof child === "string") {
      out.push(...transformString(child, ctx, `${keyPrefix}-${i}`));
      return;
    }
    if (typeof child === "number" || typeof child === "boolean" || child === null || child === undefined) {
      out.push(child);
      return;
    }
    if (isValidElement(child)) {
      const type = child.type;
      if (type === "strong" || type === "em") {
        const inner = (child.props as { children?: ReactNode }).children;
        const transformed = Children.map(Children.toArray(inner), (c, j) =>
          typeof c === "string" ? transformString(c, ctx, `${keyPrefix}-${i}-${j}`) : c,
        );
        const Tag = type;
        out.push(<Tag key={`${keyPrefix}-${i}`}>{transformed}</Tag>);
        return;
      }
      out.push(child);
      return;
    }
    out.push(child);
  });
  return out;
}

export function IssueRefMarkdown({
  text,
  issuesByNum,
  onOpen,
}: IssueRefMarkdownProps): JSX.Element {
  const ctx: Ctx = { issuesByNum, onOpen };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p>{transformChildren(children, ctx, "p")}</p>,
        li: ({ children }) => <li>{transformChildren(children, ctx, "li")}</li>,
        td: ({ children }) => <td>{transformChildren(children, ctx, "td")}</td>,
        th: ({ children }) => <th>{transformChildren(children, ctx, "th")}</th>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
