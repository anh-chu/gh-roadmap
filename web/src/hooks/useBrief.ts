import { useCallback, useEffect, useState } from "react";
import type { BriefChanges, BriefSnapshot } from "../../../shared/types";
import { fetchBriefChanges, fetchBriefSnapshot, postBriefMarkSeen } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

const SNAP_KEY = "ghr:brief-snapshot:v1";
const CHANGES_KEY = "ghr:brief-changes:v1";

interface UseBrief {
  snapshot: BriefSnapshot | null;
  changes: BriefChanges | null;
  loading: boolean;
  error: string | null;
  markSeen: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useBrief(active: boolean): UseBrief {
  const [snapshot, setSnapshot] = useState<BriefSnapshot | null>(() => loadCache<BriefSnapshot>(SNAP_KEY));
  const [changes, setChanges] = useState<BriefChanges | null>(() => loadCache<BriefChanges>(CHANGES_KEY));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [snap, ch] = await Promise.all([fetchBriefSnapshot(), fetchBriefChanges()]);
      saveCache(SNAP_KEY, snap);
      saveCache(CHANGES_KEY, ch);
      setSnapshot(snap);
      setChanges(ch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load brief");
    } finally {
      setLoading(false);
    }
  }, []);

  const markSeen = useCallback(async (): Promise<void> => {
    try {
      await postBriefMarkSeen();
      const ch = await fetchBriefChanges();
      saveCache(CHANGES_KEY, ch);
      setChanges(ch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to mark seen");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  return { snapshot, changes, loading, error, markSeen, refresh };
}
