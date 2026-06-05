import { useCallback, useEffect, useState } from "react";
import type { AccountAiRead, AccountDetail, AccountProfilePatch } from "../../../shared/types";
import { fetchAccount, regenerateAccountRead, patchAccountProfile } from "../lib/api";

// Module-level cache by slug.
const _cache = new Map<string, AccountDetail>();

export interface UseAccountResult {
  detail: AccountDetail | null;
  loading: boolean;
  error: string | null;
  regenerate: () => Promise<void>;
  saveProfile: (patch: AccountProfilePatch) => Promise<void>;
}

export function useAccount(slug: string | null): UseAccountResult {
  const [detail, setDetail] = useState<AccountDetail | null>(
    slug !== null ? _cache.get(slug) ?? null : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    const cached = _cache.get(slug);
    if (cached) {
      setDetail(cached);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    (async () => {
      try {
        const d = await fetchAccount(slug);
        if (!cancelled) {
          _cache.set(slug, d);
          setDetail(d);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load account");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const regenerate = useCallback(async (): Promise<void> => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const aiRead: AccountAiRead | null = await regenerateAccountRead(slug);
      setDetail((prev) => {
        if (!prev) return prev;
        const updated: AccountDetail = { ...prev, aiRead: aiRead ?? null };
        _cache.set(slug, updated);
        return updated;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regenerate failed");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const saveProfile = useCallback(
    async (patch: AccountProfilePatch): Promise<void> => {
      if (!slug) return;
      setError(null);
      try {
        const profile = await patchAccountProfile(slug, patch);
        setDetail((prev) => {
          if (!prev) return prev;
          const updated: AccountDetail = { ...prev, profile };
          _cache.set(slug, updated);
          return updated;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
        throw e;
      }
    },
    [slug],
  );

  return { detail, loading, error, regenerate, saveProfile };
}
