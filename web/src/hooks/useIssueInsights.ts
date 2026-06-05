import { useEffect, useState } from "react";
import type { ApiInsightListItem } from "../../../shared/types";
import { fetchIssueInsights } from "../lib/api";

// Per-issue cache so opening the same issue twice doesn't refetch.
const _cache = new Map<number, ApiInsightListItem[]>();

export interface UseIssueInsightsResult {
  insights: ApiInsightListItem[];
  loading: boolean;
}

export function useIssueInsights(num: number | null): UseIssueInsightsResult {
  const [insights, setInsights] = useState<ApiInsightListItem[]>(
    num !== null ? _cache.get(num) ?? [] : [],
  );
  const [loading, setLoading] = useState(num !== null && !_cache.has(num));

  useEffect(() => {
    if (num === null) {
      setInsights([]);
      setLoading(false);
      return;
    }
    const cached = _cache.get(num);
    if (cached) {
      setInsights(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await fetchIssueInsights(num);
        if (!cancelled) {
          _cache.set(num, list);
          setInsights(list);
        }
      } catch {
        if (!cancelled) setInsights([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [num]);

  return { insights, loading };
}
