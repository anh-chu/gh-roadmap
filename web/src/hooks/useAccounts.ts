import { useCallback, useEffect, useState } from "react";
import type { Account } from "../../../shared/types";
import { fetchAccounts } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

// SWR cache: paint the Accounts tab instantly from the last-known list on a cold
// reload, then revalidate silently in the background.
const CACHE_KEY = "ghr:accounts:v1";

export interface UseAccountsResult {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<Account[]>(() => loadCache<Account[]>(CACHE_KEY) ?? []);
  const [loading, setLoading] = useState(accounts.length === 0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const list = await fetchAccounts();
      saveCache(CACHE_KEY, list);
      setAccounts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  // Always revalidate on mount; silent (keep cached rows) when we already have data.
  useEffect(() => {
    void load(accounts.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { accounts, loading, error, refresh: load };
}
