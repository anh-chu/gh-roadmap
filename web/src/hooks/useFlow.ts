import { useEffect, useMemo, useState } from "react";
import type { FlowResult, FlowResultMap } from "../../../shared/types";
import { fetchFlow } from "../lib/api";

interface UseFlow {
  flow: Map<number, FlowResult>;
  loading: boolean;
  error: string | null;
}

// 60s poll mirrors usePulls.ts pattern. Auto-refresh on mutation is optional and not
// wired here — flow recomputes on next interval tick.
export function useFlow(intervalMs = 60_000): UseFlow {
  const [map, setMap] = useState<FlowResultMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const r = await fetchFlow();
        if (!cancelled) {
          setMap(r);
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

  const flow = useMemo(() => {
    const m = new Map<number, FlowResult>();
    for (const [k, v] of Object.entries(map)) {
      const n = Number(k);
      if (Number.isFinite(n)) m.set(n, v);
    }
    return m;
  }, [map]);

  return { flow, loading, error };
}
