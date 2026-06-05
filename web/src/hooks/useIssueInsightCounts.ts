import { useEffect, useState } from "react";
import { fetchIssueInsightCounts } from "../lib/api";

let _cached: Record<number, number> | null = null;
let _inflight: Promise<Record<number, number>> | null = null;

export function useIssueInsightCounts(): Record<number, number> {
  const [counts, setCounts] = useState<Record<number, number>>(_cached ?? {});

  useEffect(() => {
    if (_cached) return;
    if (!_inflight) {
      _inflight = fetchIssueInsightCounts()
        .then((c) => {
          _cached = c;
          return c;
        })
        .catch(() => {
          _cached = {};
          return {};
        });
    }
    let cancelled = false;
    void _inflight.then((c) => {
      if (!cancelled) setCounts(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}
