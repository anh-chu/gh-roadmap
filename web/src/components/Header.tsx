import { useRef } from "react";
import type { AuthUser, MetaResponse, WorkspaceConfig } from "../../../shared/types";
import { ScopePill } from "./ScopePill";
import { AiSettings } from "./AiSettings";
import { DataSettings } from "./DataSettings";
import { UserSettings } from "./UserSettings";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSettings";
import { canEdit } from "../lib/role";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

interface HeaderProps {
  meta: MetaResponse | null;
  config: WorkspaceConfig;
  // Signed-in Google user (null when auth is disabled / single-user localhost).
  authUser: AuthUser | null;
  // Gates admin-only controls (AI model settings + data export/import).
  isAdmin: boolean;
  onScopeChange: (patch: { masterFilterInclude?: string[]; masterFilterExclude?: string[] }) => void;
  onAiChange: (patch: { aiModelSummary?: string | null; aiModelProgress?: string | null; aiModelExtract?: string | null; aiMaxTokensPerRequest?: number; aiRateLimitRpm?: number; aiDailyTokenBudget?: number }) => void;
  onOpenFilter: (rect: DOMRect) => void;
  onNewIssue: () => void;
  filterActive: boolean;
  onSync: () => void;
  syncing: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Header({ meta, config, authUser, isAdmin, onScopeChange, onAiChange, onOpenFilter, onNewIssue, filterActive, onSync, syncing, theme, onToggleTheme }: HeaderProps): JSX.Element {
  const filterBtnRef = useRef<HTMLButtonElement | null>(null);
  const open = meta ? String(meta.openCount) : "—";
  const closed = meta ? String(meta.closedCount) : "—";
  const synced = meta ? relativeTime(meta.lastSyncAt) : "—";
  const apiBudget = meta && meta.rateLimitLimit > 0
    ? Math.round((meta.rateLimitRemaining / meta.rateLimitLimit) * 100) + "%"
    : "—";
  const userInitial = meta?.currentUser?.[0]?.toUpperCase() ?? null;
  const currentUserLogin = meta?.currentUser ?? null;
  const currentUserName = authUser?.name ?? null;
  const currentUserTitle = currentUserName && currentUserLogin
    ? `${currentUserName} · @${currentUserLogin}`
    : currentUserLogin
      ? `@${currentUserLogin}`
      : currentUserName ?? "";

  return (
    <header className="top reveal" style={{ animationDelay: "0ms" }}>
      <div className="brand">
        <div className="logo"></div>
        <span className="name">Roadmap</span>
        <span className="repo">katalon-studio/product</span>
        <WorkspaceSwitcher isAdmin={isAdmin} />
        <ScopePill config={config} isAdmin={isAdmin} onChange={onScopeChange} />
      </div>

      <div className="meta">
        {/* Viewers see sync freshness but can't trigger a sync (a mutation). */}
        {canEdit() ? (
          <button
            type="button"
            className={"item sync-item" + (syncing ? " syncing" : "")}
            onClick={onSync}
            disabled={syncing}
            title={meta ? `Sync now — pull latest from GitHub + insights · API budget ${apiBudget}` : "Sync now — pull latest from GitHub + insights"}
          >
            <span className="dot"></span>
            {syncing ? "Syncing…" : <>Synced <b>{synced}</b></>}
          </button>
        ) : (
          <span className="item"><span className="dot"></span>Synced <b>{synced}</b></span>
        )}
        <span className="item"><b>{open}</b> open · <b>{closed}</b> closed</span>
      </div>

      <div className="head-actions">
        <button
          ref={filterBtnRef}
          className={"btn" + (filterActive ? " has-dot" : "")}
          onClick={() => {
            const r = filterBtnRef.current?.getBoundingClientRect();
            if (r) onOpenFilter(r);
          }}
        >
          <span>Filter</span>
          <span className="kbd">F</span>
        </button>
        <button
          className="btn icon-only"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label="Toggle theme"
        >
          <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
        </button>
        {isAdmin && <AiSettings config={config} envDefault={meta?.aiEnvDefault ?? null} meta={meta ?? null} onChange={onAiChange} />}
        {isAdmin && meta && (
          <DataSettings
            rateLimitRemaining={meta.rateLimitRemaining}
            rateLimitLimit={meta.rateLimitLimit}
          />
        )}
        {/* Users panel only makes sense with auth on (roles are dormant in localhost mode). */}
        {isAdmin && authUser && <UserSettings />}
        {/* Hidden for viewers — a viewer's write is never achievable (see lib/role.ts). */}
        {canEdit() && <button className="btn primary" onClick={onNewIssue}><span>+ New issue</span></button>}
        <div className="avatars">
          {authUser ? (
            <UserMenu user={authUser} />
          ) : userInitial ? (
            <span className="av" title={meta?.currentUser ?? ""}>{userInitial}</span>
          ) : (
            <span className="av" title="signed-in user unavailable">—</span>
          )}
          {currentUserTitle && (
            <span className="current-user" title={currentUserTitle}>
              {currentUserName ? <span className="current-user-name">{currentUserName}</span> : null}
              {currentUserLogin ? <span className="current-user-login">@{currentUserLogin}</span> : null}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
