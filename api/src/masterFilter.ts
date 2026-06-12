import { db } from "./db.js";

export interface MasterFilter {
  include: string[];
  exclude: string[];
}

type Row = { master_filter_include: string; master_filter_exclude: string };

export function getMasterFilter(workspaceId: number): MasterFilter {
  const row = db()
    .prepare("SELECT master_filter_include, master_filter_exclude FROM workspace_config WHERE id = ?")
    .get(workspaceId) as Row | undefined;
  if (!row) return { include: [], exclude: [] };
  try {
    return {
      include: JSON.parse(row.master_filter_include) as string[],
      exclude: JSON.parse(row.master_filter_exclude) as string[],
    };
  } catch {
    return { include: [], exclude: [] };
  }
}

// Returns a SQL WHERE fragment (without leading WHERE/AND) plus the bound params.
// `issueAlias` is the table alias for the issues table in the outer query.
// Returns null when the filter has no constraints.
export function masterFilterSql(
  mf: MasterFilter,
  issueAlias = "i",
): { sql: string; params: string[] } | null {
  const parts: string[] = [];
  const params: string[] = [];
  for (const label of mf.include) {
    parts.push(`EXISTS (SELECT 1 FROM json_each(${issueAlias}.labels) WHERE value = ?)`);
    params.push(label);
  }
  for (const label of mf.exclude) {
    parts.push(`NOT EXISTS (SELECT 1 FROM json_each(${issueAlias}.labels) WHERE value = ?)`);
    params.push(label);
  }
  if (parts.length === 0) return null;
  return { sql: parts.join(" AND "), params };
}

// JS-side check for narrow endpoints.
export function passesMasterFilter(labels: string[], mf: MasterFilter): boolean {
  for (const l of mf.include) if (!labels.includes(l)) return false;
  for (const l of mf.exclude) if (labels.includes(l)) return false;
  return true;
}
