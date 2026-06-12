import { useEffect, useState } from "react";
import type { AuthMe } from "../../../shared/types";
import { fetchAuthMe } from "../lib/api";

export interface UseAuth {
  me: AuthMe | null;
  loading: boolean;
}

// Module-level cache so a remount doesn't re-flash the login gate.
let cached: AuthMe | null = null;

export function useAuth(): UseAuth {
  const [me, setMe] = useState<AuthMe | null>(cached);
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const m = await fetchAuthMe();
        if (cancelled) return;
        cached = m;
        setMe(m);
      } catch {
        // Treat a failed /me as "auth disabled" so a transient blip never locks the app out.
        if (!cancelled) setMe({ authEnabled: false, user: null, githubOauthEnabled: false, githubLinked: false, githubLogin: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { me, loading };
}
