import { useEffect, useState } from "react";
import type { ApiInsightDetail } from "../../../shared/types";
import { fetchInsight } from "../lib/api";

export interface UseInsightResult {
  insight: ApiInsightDetail | null;
  loading: boolean;
  error: string | null;
}

export function useInsight(slug: string | null): UseInsightResult {
  const [insight, setInsight] = useState<ApiInsightDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setInsight(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInsight(null);
    (async () => {
      try {
        const d = await fetchInsight(slug);
        if (!cancelled) setInsight(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load insight");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { insight, loading, error };
}
