import { useCallback, useEffect, useState } from "react";
import { patchTheme } from "../lib/api";

export type Theme = "light" | "dark";
const KEY = "theme";

function apply(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
}

// Theme state: server (AuthMe.theme) is the source of truth; localStorage mirrors it only as a
// pre-paint hint (see the inline script in index.html that kills the white flash on reload).
export function useTheme(serverTheme: Theme): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(serverTheme);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode / quota — pre-paint hint is best-effort */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      void patchTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
