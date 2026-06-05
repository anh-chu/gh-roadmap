import { useCallback, useEffect, useState } from "react";
import type { Account } from "../../../shared/types";
import { fetchAccounts } from "../lib/api";

// Module-level cache so the Accounts tab doesn't refetch on every visit.
let _cache: Account[] | null = null;

export interface UseAccountsResult {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<Account[]>(_cache ?? []);
  const [loading, setLoading] = useState(_cache === null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchAccounts();
      _cache = list;
      setAccounts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (_cache !== null) return;
    void load();
  }, [load]);

  return { accounts, loading, error, refresh: load };
}
