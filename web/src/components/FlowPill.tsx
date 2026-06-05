import type { CSSProperties } from "react";
import type { FlowResult, FlowState } from "../../../shared/types";

interface Props {
  result: FlowResult | undefined;
  size?: "sm" | "md";
}

// Maps flow state → CSS token. Tokens defined in styles.css (no new tokens introduced).
const COLOR: Record<FlowState, string> = {
  shipping: "var(--green)",
  "in-review": "var(--accent)",
  "in-code": "var(--n)",
  discussing: "var(--e)",
  stalled: "var(--r)",
  cold: "var(--ink-3)",
  fresh: "var(--purple)",
  closed: "var(--ink-3)",
};

const LABEL: Record<FlowState, string> = {
  shipping: "shipping",
  "in-review": "in review",
  "in-code": "in code",
  discussing: "discussing",
  stalled: "stalled",
  cold: "cold",
  fresh: "fresh",
  closed: "closed",
};

export function FlowPill({ result, size = "md" }: Props): JSX.Element | null {
  if (!result) return null;
  if (result.state === "closed" && size === "sm") return null;
  const color = COLOR[result.state];
  const tooltip =
    `${LABEL[result.state]} (score ${result.score.toFixed(1)})` +
    (result.signals.length ? ` · ${result.signals.join(" · ")}` : "");
  const style: CSSProperties = { color };
  const cls = "flow-pill " + result.state + " size-" + size;
  if (size === "sm") {
    return <span className={cls} style={style} title={tooltip}><i className="flow-dot" /></span>;
  }
  return (
    <span className={cls} style={style} title={tooltip}>
      <i className="flow-dot" />
      <span className="flow-label">{LABEL[result.state]}</span>
    </span>
  );
}
