import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInsightOp, InsightMergePayload } from "../../../shared/types";
import { closeInsightOp, fetchInsightOps, markInsightForDeletion, mergeInsightOp, mergeInsights } from "../lib/api";

const POLL_MS = 30_000;

export interface UseInsightOpsResult {
  // Open delete/merge ops — each tracks a PR awaiting in-app merge.
  ops: ApiInsightOp[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markDelete: (slug: string) => Promise<ApiInsightOp>;
  merge: (payload: InsightMergePayload) => Promise<ApiInsightOp>;
  approveMerge: (id: number) => Promise<ApiInsightOp>;
  // Abandon an op's open PR (close + delete branch); op drops out of the open list.
  closePr: (id: number) => Promise<ApiInsightOp>;
  // Path → open op, for surfacing "PR open" state on a given insight.
  openOpForPath: (path: string) => ApiInsightOp | undefined;
}

export function useInsightOps(): UseInsightOpsResult {
  const [ops, setOps] = useState<ApiInsightOp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const open = await fetchInsightOps("open");
      if (!mounted.current) return;
      setOps(open);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "Failed to load insight ops");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  const markDelete = useCallback(async (slug: string): Promise<ApiInsightOp> => {
    const op = await markInsightForDeletion(slug);
    setOps((cur) => [op, ...cur]);
    return op;
  }, []);

  const merge = useCallback(async (payload: InsightMergePayload): Promise<ApiInsightOp> => {
    const op = await mergeInsights(payload);
    setOps((cur) => [op, ...cur]);
    return op;
  }, []);

  const approveMerge = useCallback(async (id: number): Promise<ApiInsightOp> => {
    const op = await mergeInsightOp(id);
    // Merged → drops out of the open list; next sync removes the file's local rows.
    setOps((cur) => cur.filter((o) => o.id !== id));
    return op;
  }, []);

  const closePr = useCallback(async (id: number): Promise<ApiInsightOp> => {
    const op = await closeInsightOp(id);
    setOps((cur) => cur.filter((o) => o.id !== id));
    return op;
  }, []);

  const openOpForPath = useCallback(
    (path: string): ApiInsightOp | undefined =>
      ops.find((o) => o.targetPath === path || o.victimPaths.includes(path)),
    [ops],
  );

  return { ops, loading, error, refresh, markDelete, merge, approveMerge, closePr, openOpForPath };
}
