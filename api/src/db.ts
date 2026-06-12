import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type IssueRow = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  assignee: string | null;
  milestone: string | null;
  labels: string; // JSON array of strings
  updated_at: string;
  raw: string; // JSON of full payload
};

export type CommentRow = {
  id: number;
  issue_number: number;
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type PullRow = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: number; // 0/1
  merged_at: string | null;
  author: string | null;
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  body: string | null;
  linked_issues: string; // JSON array of issue numbers
  raw: string;
};

export type RoadmapMetaRow = {
  issue_number: number;
  planned_month: string | null;
  planned_week: string | null;
  roadmap_notes: string | null;
  position: number | null;
  is_todo: number; // 0/1 — SQLite has no bool
  app_updated_at: string;
};

let _db: Database.Database | null = null;

export function initDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Multi-user shared instance: WAL lets readers not block the single writer; the
  // busy_timeout makes a concurrent writer wait briefly instead of throwing SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      number       INTEGER PRIMARY KEY,
      title        TEXT NOT NULL,
      body         TEXT,
      state        TEXT NOT NULL,
      assignee     TEXT,
      milestone    TEXT,
      milestone_due TEXT,
      labels       TEXT NOT NULL DEFAULT '[]',
      updated_at   TEXT NOT NULL,
      created_at   TEXT,
      closed_at    TEXT,
      raw          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id           INTEGER PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      author       TEXT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_number);

    CREATE TABLE IF NOT EXISTS roadmap_meta (
      workspace_id   INTEGER NOT NULL,
      issue_number   INTEGER NOT NULL,
      planned_month  TEXT,
      planned_week   TEXT,
      ren            TEXT, -- deprecated: R/E/N taxonomy removed; column kept (SQLite drop is destructive), reads/writes are no-ops
      roadmap_notes  TEXT,
      position       INTEGER,
      is_todo        INTEGER NOT NULL DEFAULT 0,
      app_updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, issue_number)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT NOT NULL,
      payload      TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      number          INTEGER PRIMARY KEY,
      node_id         TEXT NOT NULL,
      title           TEXT NOT NULL,
      status_field_id TEXT,
      fields_json     TEXT NOT NULL,
      last_synced_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_items (
      item_id          TEXT PRIMARY KEY,
      project_number   INTEGER NOT NULL,
      content_type     TEXT NOT NULL,
      content_number   INTEGER,
      content_title    TEXT NOT NULL,
      content_repo     TEXT,
      status_option_id TEXT,
      status_label     TEXT,
      assignees_json   TEXT NOT NULL DEFAULT '[]',
      raw_json         TEXT NOT NULL,
      last_synced_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_items_project ON project_items(project_number);

    CREATE TABLE IF NOT EXISTS pulls (
      number        INTEGER PRIMARY KEY,
      title         TEXT NOT NULL,
      state         TEXT NOT NULL,
      merged        INTEGER NOT NULL DEFAULT 0,
      merged_at     TEXT,
      author        TEXT,
      created_at    TEXT,
      updated_at    TEXT NOT NULL,
      closed_at     TEXT,
      body          TEXT,
      linked_issues TEXT NOT NULL DEFAULT '[]',
      raw           TEXT NOT NULL,
      is_draft      INTEGER NOT NULL DEFAULT 0,
      last_commit_at TEXT,
      head_ref      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pulls_state ON pulls(state);

    -- Pull request reviews (one row per review).
    CREATE TABLE IF NOT EXISTS pull_reviews (
      id            INTEGER PRIMARY KEY,
      pull_number   INTEGER NOT NULL,
      author        TEXT,
      state         TEXT NOT NULL,
      submitted_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pull_reviews_pull ON pull_reviews(pull_number);

    -- Latest commit-status / check-runs rollup per PR.
    CREATE TABLE IF NOT EXISTS pull_checks (
      pull_number  INTEGER PRIMARY KEY,
      status       TEXT,
      conclusion   TEXT,
      updated_at   TEXT NOT NULL
    );

    -- Timeline events for issues.
    CREATE TABLE IF NOT EXISTS issue_events (
      id            INTEGER PRIMARY KEY,
      issue_number  INTEGER NOT NULL,
      event_type    TEXT NOT NULL,
      actor         TEXT,
      created_at    TEXT NOT NULL,
      payload       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issue_events_issue_created ON issue_events(issue_number, created_at DESC);

    CREATE TABLE IF NOT EXISTS health_snapshots (
      workspace_id   INTEGER NOT NULL,
      snapshot_date  TEXT NOT NULL,
      confidence     INTEGER,
      sample_size    INTEGER NOT NULL,
      at_risk_json   TEXT NOT NULL,
      computed_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS ai_summaries (
      issue_number  INTEGER PRIMARY KEY,
      summary       TEXT NOT NULL,
      model         TEXT NOT NULL,
      source_hash   TEXT NOT NULL,
      generated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_insights (
      kind          TEXT PRIMARY KEY,
      content       TEXT NOT NULL,
      model         TEXT NOT NULL,
      generated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insights (
      path           TEXT PRIMARY KEY,
      slug           TEXT NOT NULL,
      title          TEXT NOT NULL,
      type           TEXT,
      date           TEXT,
      owner          TEXT,
      confidence     TEXT,
      sources_json   TEXT NOT NULL DEFAULT '[]',
      body_markdown  TEXT NOT NULL,
      body_excerpt   TEXT NOT NULL,
      file_sha256    TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      synced_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(date DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type);

    CREATE TABLE IF NOT EXISTS insight_issues (
      insight_path   TEXT NOT NULL,
      issue_number   INTEGER NOT NULL,
      source         TEXT NOT NULL,
      PRIMARY KEY (insight_path, issue_number)
    );
    CREATE INDEX IF NOT EXISTS idx_insight_issues_issue ON insight_issues(issue_number);

    CREATE TABLE IF NOT EXISTS insight_accounts (
      insight_path   TEXT NOT NULL,
      account_slug   TEXT NOT NULL,
      account_name   TEXT NOT NULL,
      PRIMARY KEY (insight_path, account_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_insight_accounts_slug ON insight_accounts(account_slug);

    CREATE TABLE IF NOT EXISTS insight_drafts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      source_type     TEXT NOT NULL,
      source_url      TEXT,
      raw_text        TEXT NOT NULL,
      hint            TEXT,

      title           TEXT,
      type            TEXT,
      date            TEXT,
      owner           TEXT,
      confidence      TEXT,
      accounts_json   TEXT NOT NULL DEFAULT '[]',
      related_issues_json TEXT NOT NULL DEFAULT '[]',
      key_quotes_json TEXT NOT NULL DEFAULT '[]',
      body_draft      TEXT,

      state           TEXT NOT NULL DEFAULT 'pending',
      pr_url          TEXT,
      pr_number       INTEGER,
      published_path  TEXT,
      discarded_at    TEXT,

      dup_of          INTEGER,
      dup_kind        TEXT,
      dup_score       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_insight_drafts_state ON insight_drafts(state, created_at DESC);

    -- PM-initiated retire/consolidate operations on published insight files.
    -- Each row tracks one GH PR (delete one file, or merge victims into a survivor).
    CREATE TABLE IF NOT EXISTS insight_ops (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      kind                  TEXT NOT NULL,                 -- 'delete' | 'merge'
      target_path           TEXT NOT NULL,                 -- delete: file removed; merge: survivor file
      victim_paths_json     TEXT NOT NULL DEFAULT '[]',    -- merge: other insight files to delete
      victim_draft_ids_json TEXT NOT NULL DEFAULT '[]',    -- merge: draft ids folded in
      pr_url                TEXT,
      pr_number             INTEGER,
      state                 TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'merged' | 'closed'
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insight_ops_state ON insight_ops(state, created_at DESC);

    CREATE TABLE IF NOT EXISTS accounts (
      slug         TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      ai_read      TEXT,
      ai_read_hash TEXT,
      ai_read_at   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      email       TEXT PRIMARY KEY,            -- always stored lowercase (matches auth.ts)
      name        TEXT,
      role        TEXT NOT NULL DEFAULT 'viewer',  -- viewer | editor | admin
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_config (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                    TEXT NOT NULL UNIQUE,
      name                    TEXT NOT NULL,
      archived_at             TEXT,
      bucketing_field         TEXT NOT NULL DEFAULT 'label',
      bucketing_value         TEXT NOT NULL DEFAULT 'area',
      master_filter_include   TEXT NOT NULL DEFAULT '[]',
      master_filter_exclude   TEXT NOT NULL DEFAULT '[]',
      range_granularity       TEXT NOT NULL DEFAULT 'month',
      range_count             INTEGER NOT NULL DEFAULT 3,
      range_offset            INTEGER NOT NULL DEFAULT 0,
      stall_days              INTEGER NOT NULL DEFAULT 7,
      hot_comments            INTEGER NOT NULL DEFAULT 3,
      hot_window_hours        INTEGER NOT NULL DEFAULT 48,
      todo_stale_days         INTEGER NOT NULL DEFAULT 14,
      pin_meta_cols           INTEGER NOT NULL DEFAULT 1,
      pod_last_seen_at        TEXT,
      ai_model_summary        TEXT,
      ai_model_progress       TEXT,
      ai_model_extract        TEXT,
      updated_at              TEXT NOT NULL
    );
  `);

  // Migrate older DBs that pre-date created_at / closed_at columns.
  const issueCols = db.prepare("PRAGMA table_info(issues)").all() as { name: string }[];
  const issueColNames = new Set(issueCols.map((c) => c.name));
  if (!issueColNames.has("created_at")) db.exec("ALTER TABLE issues ADD COLUMN created_at TEXT");
  if (!issueColNames.has("closed_at")) db.exec("ALTER TABLE issues ADD COLUMN closed_at TEXT");
  if (!issueColNames.has("milestone_due")) db.exec("ALTER TABLE issues ADD COLUMN milestone_due TEXT");

  // Schedule trend: snapshots predate on_time. Backfill repopulates it.
  const hsCols = db.prepare("PRAGMA table_info(health_snapshots)").all() as { name: string }[];
  if (!new Set(hsCols.map((c) => c.name)).has("on_time")) {
    db.exec("ALTER TABLE health_snapshots ADD COLUMN on_time INTEGER");
  }

  // Per-user GitHub write identity (layer 3): connection columns on users. Older DBs
  // pre-date them; null github_login = unlinked.
  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has("github_login")) db.exec("ALTER TABLE users ADD COLUMN github_login TEXT");
  if (!userColNames.has("github_token_enc")) db.exec("ALTER TABLE users ADD COLUMN github_token_enc TEXT");
  if (!userColNames.has("github_linked_at")) db.exec("ALTER TABLE users ADD COLUMN github_linked_at TEXT");

  // PM-actions cache reuses ai_insights but needs a candidate-set hash to invalidate when
  // the underlying issues change. Older DBs pre-date it.
  const aiCols = db.prepare("PRAGMA table_info(ai_insights)").all() as { name: string }[];
  if (!new Set(aiCols.map((c) => c.name)).has("source_hash")) {
    db.exec("ALTER TABLE ai_insights ADD COLUMN source_hash TEXT");
  }

  // Migrate older DBs that pre-date master_filter_* columns. Must run before the seed
  // INSERT below — for existing DBs the CREATE TABLE IF NOT EXISTS above is a no-op
  // and the table still lacks these columns.
  const wcCols = db.prepare("PRAGMA table_info(workspace_config)").all() as { name: string }[];
  const wcColNames = new Set(wcCols.map((c) => c.name));
  if (!wcColNames.has("master_filter_include")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN master_filter_include TEXT NOT NULL DEFAULT '[]'");
  }
  if (!wcColNames.has("master_filter_exclude")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN master_filter_exclude TEXT NOT NULL DEFAULT '[]'");
  }
  if (!wcColNames.has("range_granularity")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN range_granularity TEXT NOT NULL DEFAULT 'month'");
  }
  if (!wcColNames.has("range_count")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN range_count INTEGER NOT NULL DEFAULT 3");
  }
  if (!wcColNames.has("range_offset")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN range_offset INTEGER NOT NULL DEFAULT 0");
  }
  if (!wcColNames.has("stall_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN stall_days INTEGER NOT NULL DEFAULT 7");
  }
  if (!wcColNames.has("hot_comments")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN hot_comments INTEGER NOT NULL DEFAULT 3");
  }
  if (!wcColNames.has("hot_window_hours")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN hot_window_hours INTEGER NOT NULL DEFAULT 48");
  }
  if (!wcColNames.has("todo_stale_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN todo_stale_days INTEGER NOT NULL DEFAULT 14");
  }
  if (!wcColNames.has("flow_shipping_hours")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_shipping_hours INTEGER NOT NULL DEFAULT 24");
  }
  if (!wcColNames.has("flow_review_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_review_days INTEGER NOT NULL DEFAULT 3");
  }
  if (!wcColNames.has("flow_code_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_code_days INTEGER NOT NULL DEFAULT 3");
  }
  if (!wcColNames.has("flow_discussion_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_discussion_days INTEGER NOT NULL DEFAULT 5");
  }
  if (!wcColNames.has("flow_stall_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_stall_days INTEGER NOT NULL DEFAULT 14");
  }
  if (!wcColNames.has("flow_cold_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_cold_days INTEGER NOT NULL DEFAULT 60");
  }
  if (!wcColNames.has("flow_fresh_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN flow_fresh_days INTEGER NOT NULL DEFAULT 7");
  }
  if (!wcColNames.has("pin_meta_cols")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN pin_meta_cols INTEGER NOT NULL DEFAULT 1");
  }
  if (!wcColNames.has("predict_pr_stale_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN predict_pr_stale_days INTEGER NOT NULL DEFAULT 3");
  }
  if (!wcColNames.has("predict_pr_min_age")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN predict_pr_min_age INTEGER NOT NULL DEFAULT 7");
  }
  if (!wcColNames.has("predict_review_wait_days")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN predict_review_wait_days INTEGER NOT NULL DEFAULT 2");
  }
  if (!wcColNames.has("predict_promise_confidence_min")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN predict_promise_confidence_min INTEGER NOT NULL DEFAULT 60");
  }
  if (!wcColNames.has("predict_reply_overdue_hours")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN predict_reply_overdue_hours INTEGER NOT NULL DEFAULT 24");
  }
  if (!wcColNames.has("pod_last_seen_at")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN pod_last_seen_at TEXT");
  }
  if (!wcColNames.has("ai_model_summary")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN ai_model_summary TEXT");
  }
  if (!wcColNames.has("ai_model_progress")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN ai_model_progress TEXT");
  }
  if (!wcColNames.has("ai_model_extract")) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN ai_model_extract TEXT");
  }

  // Mini-CRM: structured profile fields on accounts. No CRM source historically — these
  // are hydrated by ingest (bulk JSON / CSV) or manual entry in the drawer. profile_updated_at
  // doubles as the provenance marker: set iff this account carries a CRM profile, which lets
  // a CRM-only account (zero insight signals) surface in the index.
  const acctCols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
  const acctColNames = new Set(acctCols.map((c) => c.name));
  const acctProfileCols: Array<[string, string]> = [
    ["arr", "REAL"],
    ["renewal_date", "TEXT"],
    ["owner", "TEXT"],
    ["tier", "TEXT"],
    ["segment", "TEXT"],
    ["region", "TEXT"],
    ["industry", "TEXT"],
    ["website", "TEXT"],
    ["domain", "TEXT"],
    ["salesforce_id", "TEXT"],
    ["notes", "TEXT"],
    ["profile_updated_at", "TEXT"],
  ];
  for (const [col, type] of acctProfileCols) {
    if (!acctColNames.has(col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${type}`);
  }

  // Migrate pulls to add is_draft / last_commit_at / head_ref.
  const pullCols = db.prepare("PRAGMA table_info(pulls)").all() as { name: string }[];
  const pullColNames = new Set(pullCols.map((c) => c.name));
  if (!pullColNames.has("is_draft")) {
    db.exec("ALTER TABLE pulls ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0");
  }
  if (!pullColNames.has("last_commit_at")) {
    db.exec("ALTER TABLE pulls ADD COLUMN last_commit_at TEXT");
  }
  if (!pullColNames.has("head_ref")) {
    db.exec("ALTER TABLE pulls ADD COLUMN head_ref TEXT");
  }

  // Insights are now GitHub-API-sourced; blob_sha (git blob sha from the dir listing)
  // is the change-detection key, replacing the old file-mtime check.
  const insightCols = db.prepare("PRAGMA table_info(insights)").all() as { name: string }[];
  if (!new Set(insightCols.map((c) => c.name)).has("blob_sha")) {
    db.exec("ALTER TABLE insights ADD COLUMN blob_sha TEXT");
  }

  // Insight capture dedup flags (set once at capture; null = no dup detected).
  const draftCols = db.prepare("PRAGMA table_info(insight_drafts)").all() as { name: string }[];
  const draftColNames = new Set(draftCols.map((c) => c.name));
  if (!draftColNames.has("dup_of")) {
    db.exec("ALTER TABLE insight_drafts ADD COLUMN dup_of INTEGER");
  }
  if (!draftColNames.has("dup_kind")) {
    db.exec("ALTER TABLE insight_drafts ADD COLUMN dup_kind TEXT");
  }
  if (!draftColNames.has("dup_score")) {
    db.exec("ALTER TABLE insight_drafts ADD COLUMN dup_score INTEGER");
  }

  // AI-estimated effort rating, stored alongside the issue summary.
  const aiSumCols = db.prepare("PRAGMA table_info(ai_summaries)").all() as { name: string }[];
  if (!new Set(aiSumCols.map((c) => c.name)).has("effort")) {
    db.exec("ALTER TABLE ai_summaries ADD COLUMN effort TEXT");
  }

  // Migrate roadmap_meta to add planned_week column.
  const rmCols = db.prepare("PRAGMA table_info(roadmap_meta)").all() as { name: string }[];
  const rmColNames = new Set(rmCols.map((c) => c.name));
  if (!rmColNames.has("planned_week")) {
    db.exec("ALTER TABLE roadmap_meta ADD COLUMN planned_week TEXT");
  }
  if (!rmColNames.has("is_todo")) {
    db.exec("ALTER TABLE roadmap_meta ADD COLUMN is_todo INTEGER NOT NULL DEFAULT 0");
  }

  // Multi-pod: de-singleton workspace_config (drop CHECK (id = 1), add slug/name/archived_at)
  // and re-key roadmap_meta / health_snapshots to (workspace_id, ...). SQLite can't drop a
  // CHECK or change a PK in place, so each is a guarded table rebuild; all three run in one
  // transaction. Guards: the sentinel column (slug / workspace_id) absent on the old table.
  // Existing rows become workspace 1 ('mht'). Explicit column lists — never positional.
  const wcNeedsRebuild = !wcColNames.has("slug");
  const rmNeedsRebuild = !rmColNames.has("workspace_id");
  const hsNeedsRebuild = !new Set(hsCols.map((c) => c.name)).has("workspace_id");
  if (wcNeedsRebuild || rmNeedsRebuild || hsNeedsRebuild) {
    db.exec("BEGIN");
    try {
      if (wcNeedsRebuild) {
        db.exec(`
          CREATE TABLE workspace_config_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            slug                    TEXT NOT NULL UNIQUE,
            name                    TEXT NOT NULL,
            archived_at             TEXT,
            bucketing_field         TEXT NOT NULL DEFAULT 'label',
            bucketing_value         TEXT NOT NULL DEFAULT 'area',
            master_filter_include   TEXT NOT NULL DEFAULT '[]',
            master_filter_exclude   TEXT NOT NULL DEFAULT '[]',
            range_granularity       TEXT NOT NULL DEFAULT 'month',
            range_count             INTEGER NOT NULL DEFAULT 3,
            range_offset            INTEGER NOT NULL DEFAULT 0,
            stall_days              INTEGER NOT NULL DEFAULT 7,
            hot_comments            INTEGER NOT NULL DEFAULT 3,
            hot_window_hours        INTEGER NOT NULL DEFAULT 48,
            todo_stale_days         INTEGER NOT NULL DEFAULT 14,
            pin_meta_cols           INTEGER NOT NULL DEFAULT 1,
            flow_shipping_hours     INTEGER NOT NULL DEFAULT 24,
            flow_review_days        INTEGER NOT NULL DEFAULT 3,
            flow_code_days          INTEGER NOT NULL DEFAULT 3,
            flow_discussion_days    INTEGER NOT NULL DEFAULT 5,
            flow_stall_days         INTEGER NOT NULL DEFAULT 14,
            flow_cold_days          INTEGER NOT NULL DEFAULT 60,
            flow_fresh_days         INTEGER NOT NULL DEFAULT 7,
            predict_pr_stale_days   INTEGER NOT NULL DEFAULT 3,
            predict_pr_min_age      INTEGER NOT NULL DEFAULT 7,
            predict_review_wait_days INTEGER NOT NULL DEFAULT 2,
            predict_promise_confidence_min INTEGER NOT NULL DEFAULT 60,
            predict_reply_overdue_hours INTEGER NOT NULL DEFAULT 24,
            pod_last_seen_at        TEXT,
            ai_model_summary        TEXT,
            ai_model_progress       TEXT,
            ai_model_extract        TEXT,
            updated_at              TEXT NOT NULL
          );
          INSERT INTO workspace_config_new (
            id, slug, name, archived_at,
            bucketing_field, bucketing_value, master_filter_include, master_filter_exclude,
            range_granularity, range_count, range_offset, stall_days, hot_comments,
            hot_window_hours, todo_stale_days, pin_meta_cols,
            flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days,
            flow_stall_days, flow_cold_days, flow_fresh_days,
            predict_pr_stale_days, predict_pr_min_age, predict_review_wait_days,
            predict_promise_confidence_min, predict_reply_overdue_hours,
            pod_last_seen_at, ai_model_summary, ai_model_progress, ai_model_extract, updated_at
          )
          SELECT
            id, 'mht', 'MHT', NULL,
            bucketing_field, bucketing_value, master_filter_include, master_filter_exclude,
            range_granularity, range_count, range_offset, stall_days, hot_comments,
            hot_window_hours, todo_stale_days, pin_meta_cols,
            flow_shipping_hours, flow_review_days, flow_code_days, flow_discussion_days,
            flow_stall_days, flow_cold_days, flow_fresh_days,
            predict_pr_stale_days, predict_pr_min_age, predict_review_wait_days,
            predict_promise_confidence_min, predict_reply_overdue_hours,
            pod_last_seen_at, ai_model_summary, ai_model_progress, ai_model_extract, updated_at
          FROM workspace_config;
          DROP TABLE workspace_config;
          ALTER TABLE workspace_config_new RENAME TO workspace_config;
        `);
      }
      if (rmNeedsRebuild) {
        db.exec(`
          CREATE TABLE roadmap_meta_new (
            workspace_id   INTEGER NOT NULL,
            issue_number   INTEGER NOT NULL,
            planned_month  TEXT,
            planned_week   TEXT,
            ren            TEXT,
            roadmap_notes  TEXT,
            position       INTEGER,
            is_todo        INTEGER NOT NULL DEFAULT 0,
            app_updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, issue_number)
          );
          INSERT INTO roadmap_meta_new (
            workspace_id, issue_number, planned_month, planned_week, ren,
            roadmap_notes, position, is_todo, app_updated_at
          )
          SELECT
            1, issue_number, planned_month, planned_week, ren,
            roadmap_notes, position, is_todo, app_updated_at
          FROM roadmap_meta;
          DROP TABLE roadmap_meta;
          ALTER TABLE roadmap_meta_new RENAME TO roadmap_meta;
        `);
      }
      if (hsNeedsRebuild) {
        db.exec(`
          CREATE TABLE health_snapshots_new (
            workspace_id   INTEGER NOT NULL,
            snapshot_date  TEXT NOT NULL,
            confidence     INTEGER,
            sample_size    INTEGER NOT NULL,
            at_risk_json   TEXT NOT NULL,
            computed_at    TEXT NOT NULL,
            on_time        INTEGER,
            PRIMARY KEY (workspace_id, snapshot_date)
          );
          INSERT INTO health_snapshots_new (
            workspace_id, snapshot_date, confidence, sample_size, at_risk_json, computed_at, on_time
          )
          SELECT
            1, snapshot_date, confidence, sample_size, at_risk_json, computed_at, on_time
          FROM health_snapshots;
          DROP TABLE health_snapshots;
          ALTER TABLE health_snapshots_new RENAME TO health_snapshots;
        `);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  db.exec(`
    INSERT OR IGNORE INTO workspace_config (id, slug, name, bucketing_field, bucketing_value, master_filter_include, master_filter_exclude, range_granularity, range_count, range_offset, stall_days, hot_comments, hot_window_hours, todo_stale_days, pin_meta_cols, updated_at)
      VALUES (1, 'mht', 'MHT', 'label', 'area', '[]', '[]', 'month', 3, 0, 7, 3, 48, 14, 1, datetime('now'));
  `);

  _db = db;
  return db;
}

export function db(): Database.Database {
  if (!_db) throw new Error("db not initialised — call initDb() first");
  return _db;
}

export function setKv(key: string, value: string): void {
  db()
    .prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);
}

export function getKv(key: string): string | null {
  const row = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// ---- users (app-level roles — layer 2) -------------------------------------------------
// Emails are stored lowercase everywhere (matches auth.ts ADMIN_EMAILS / domain checks).

export type UserRow = {
  email: string;
  name: string | null;
  role: "viewer" | "editor" | "admin";
  created_at: string;
  updated_at: string;
  github_login: string | null;
  github_token_enc: string | null;
  github_linked_at: string | null;
};

export function getUser(email: string): UserRow | undefined {
  return db().prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined;
}

// Upsert on each successful Google login: refresh the name, preserve the role
// (default viewer on first sight).
export function upsertUserOnLogin(email: string, name: string): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO users(email, name, role, created_at, updated_at) VALUES(?, ?, 'viewer', ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    )
    .run(email.toLowerCase(), name, now, now);
}

// Admin pre-provision: create (or re-role) a user before their first login.
// upsertUserOnLogin preserves the role on conflict, so the pre-set role survives sign-in.
export function upsertUserWithRole(email: string, role: UserRow["role"]): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO users(email, name, role, created_at, updated_at) VALUES(?, NULL, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    )
    .run(email.toLowerCase(), role, now, now);
}

export function setUserRole(email: string, role: UserRow["role"]): void {
  db()
    .prepare("UPDATE users SET role = ?, updated_at = ? WHERE email = ?")
    .run(role, new Date().toISOString(), email.toLowerCase());
}

// ---- GitHub connection (per-user write identity — layer 3) ----------------------------

export function getUserGithub(
  email: string,
): { github_login: string | null; github_token_enc: string | null; github_linked_at: string | null } | undefined {
  return db()
    .prepare("SELECT github_login, github_token_enc, github_linked_at FROM users WHERE email = ?")
    .get(email.toLowerCase()) as
    | { github_login: string | null; github_token_enc: string | null; github_linked_at: string | null }
    | undefined;
}

export function linkUserGithub(email: string, login: string, tokenEnc: string): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      "UPDATE users SET github_login = ?, github_token_enc = ?, github_linked_at = ?, updated_at = ? WHERE email = ?",
    )
    .run(login, tokenEnc, now, now, email.toLowerCase());
}

export function unlinkUserGithub(email: string): void {
  db()
    .prepare(
      "UPDATE users SET github_login = NULL, github_token_enc = NULL, github_linked_at = NULL, updated_at = ? WHERE email = ?",
    )
    .run(new Date().toISOString(), email.toLowerCase());
}

export function listUsers(): UserRow[] {
  return db().prepare("SELECT * FROM users ORDER BY email").all() as UserRow[];
}
