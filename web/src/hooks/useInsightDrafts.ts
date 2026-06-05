import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiInsightDraft,
  InsightCapturePayload,
  InsightDraftPatch,
} from "../../../shared/types";
import {
  captureInsight,
  closeInsightDraftPr,
  discardInsightDraft,
  fetchInsightDrafts,
  mergeInsightDraft,
  patchInsightDraft,
  publishInsightDraft,
  regenerateInsightDraft,
} from "../lib/api";

const POLL_MS = 30_000;

export interface UseInsightDraftsResult {
  drafts: ApiInsightDraft[];
  // Published drafts whose PR is still open — awaiting in-app merge.
  published: ApiInsightDraft[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  capture: (payload: InsightCapturePayload) => Promise<ApiInsightDraft>;
  patch: (id: number, patch: InsightDraftPatch) => Promise<ApiInsightDraft>;
  publish: (id: number) => Promise<ApiInsightDraft>;
  merge: (id: number) => Promise<ApiInsightDraft>;
  // Abandon a published draft's open PR; draft returns to pending.
  closePr: (id: number) => Promise<ApiInsightDraft>;
  discard: (id: number) => Promise<ApiInsightDraft>;
  regenerate: (id: number) => Promise<ApiInsightDraft>;
}

export function useInsightDrafts(): UseInsightDraftsResult {
  const [drafts, setDrafts] = useState<ApiInsightDraft[]>([]);
  const [published, setPublished] = useState<ApiInsightDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [pending, pub] = await Promise.all([
        fetchInsightDrafts("pending"),
        fetchInsightDrafts("published"),
      ]);
      if (!mounted.current) return;
      setDrafts(pending);
      setPublished(pub);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "Failed to load drafts");
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

  const capture = useCallback(
    async (payload: InsightCapturePayload): Promise<ApiInsightDraft> => {
      const d = await captureInsight(payload);
      setDrafts((prev) => [d, ...prev]);
      return d;
    },
    [],
  );

  const patch = useCallback(
    async (id: number, p: InsightDraftPatch): Promise<ApiInsightDraft> => {
      // Optimistic: snapshot prev, apply best-effort merge
      const prev = drafts;
      setDrafts((cur) =>
        cur.map((d) =>
          d.id === id
            ? {
                ...d,
                ...(p.title !== undefined ? { title: p.title } : {}),
                ...(p.type !== undefined ? { type: p.type } : {}),
                ...(p.date !== undefined ? { date: p.date } : {}),
                ...(p.owner !== undefined ? { owner: p.owner } : {}),
                ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
                ...(p.accounts !== undefined ? { accounts: p.accounts } : {}),
                ...(p.relatedIssues !== undefined ? { relatedIssues: p.relatedIssues } : {}),
                ...(p.keyQuotes !== undefined ? { keyQuotes: p.keyQuotes } : {}),
                ...(p.bodyDraft !== undefined ? { bodyDraft: p.bodyDraft } : {}),
              }
            : d,
        ),
      );
      try {
        const updated = await patchInsightDraft(id, p);
        setDrafts((cur) => cur.map((d) => (d.id === id ? updated : d)));
        return updated;
      } catch (err) {
        setDrafts(prev);
        throw err;
      }
    },
    [drafts],
  );

  const publish = useCallback(async (id: number): Promise<ApiInsightDraft> => {
    const updated = await publishInsightDraft(id);
    // Move from pending → published (awaiting merge).
    setDrafts((cur) => cur.filter((d) => d.id !== id));
    setPublished((cur) => [updated, ...cur.filter((d) => d.id !== id)]);
    return updated;
  }, []);

  const merge = useCallback(async (id: number): Promise<ApiInsightDraft> => {
    const updated = await mergeInsightDraft(id);
    // Merged → drops out of the awaiting-merge list; next sync indexes the insight.
    setPublished((cur) => cur.filter((d) => d.id !== id));
    return updated;
  }, []);

  const closePr = useCallback(async (id: number): Promise<ApiInsightDraft> => {
    const updated = await closeInsightDraftPr(id);
    // PR abandoned → drops out of awaiting-merge, back onto the pending list.
    setPublished((cur) => cur.filter((d) => d.id !== id));
    setDrafts((cur) => [updated, ...cur.filter((d) => d.id !== id)]);
    return updated;
  }, []);

  const discard = useCallback(async (id: number): Promise<ApiInsightDraft> => {
    const updated = await discardInsightDraft(id);
    setDrafts((cur) => cur.filter((d) => d.id !== id));
    return updated;
  }, []);

  const regenerate = useCallback(async (id: number): Promise<ApiInsightDraft> => {
    const updated = await regenerateInsightDraft(id);
    setDrafts((cur) => cur.map((d) => (d.id === id ? updated : d)));
    return updated;
  }, []);

  return { drafts, published, loading, error, refresh, capture, patch, publish, merge, closePr, discard, regenerate };
}
