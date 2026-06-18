import { useEffect, useMemo, useState } from "react";
import type { Pull } from "../../../shared/types";
import { fetchPulls } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

const CACHE_KEY = "ghr:pulls:v1";

interface UsePulls {
  pulls: Pull[];
  byIssue: Map<number, Pull[]>;
  loading: boolean;
  error: string | null;
}

export function usePulls(intervalMs = 60_000): UsePulls {
  const [pulls, setPulls] = useState<Pull[]>(() => loadCache<Pull[]>(CACHE_KEY) ?? []);
  const [loading, setLoading] = useState(pulls.length === 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const list = await fetchPulls();
        if (!cancelled) {
          saveCache(CACHE_KEY, list);
          setPulls(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const id = window.setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  const byIssue = useMemo(() => {
    const m = new Map<number, Pull[]>();
    for (const p of pulls) {
      for (const n of p.linkedIssues) {
        const list = m.get(n);
        if (list) list.push(p);
        else m.set(n, [p]);
      }
    }
    return m;
  }, [pulls]);

  return { pulls, byIssue, loading, error };
}
