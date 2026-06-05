// Insight capture dedup. Two tiers, both deterministic (no AI):
//   Tier 0 — normalized exact match: catches the same text re-ingested (agent
//            retry, double paste). Source-agnostic; identical text is identical.
//   Tier 1 — near-duplicate via 3-word-shingle Jaccard, gated on SAME source.
//            Same topic from a *different* source is corroboration, not a dup
//            (see CONTEXT §4 two-axis model), so we never flag cross-source.
// Detection only flags; the PM decides. Candidate sets are the (small) draft
// inbox, so plain O(N) pairwise comparison is fine — no LSH/simhash needed.

export type DupKind = "exact" | "similar";

export interface DupCandidate {
  id: number;
  source_type: string;
  raw_text: string;
}

export interface DupResult {
  dupOf: number;
  dupKind: DupKind;
  dupScore: number; // 0–100
}

// Jaccard threshold above which two same-source captures are "near-duplicate".
const SIMILAR_THRESHOLD = 0.82;
const SHINGLE_K = 3;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Set of k consecutive words. For texts shorter than k, the whole token list is
// one shingle so short identical-ish captures still compare.
function shingles(norm: string, k = SHINGLE_K): Set<string> {
  const tokens = norm.split(" ").filter(Boolean);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Returns the best duplicate match for `rawText`, or null. Exact match wins over
// similar; among similar matches the highest Jaccard wins (ties → lowest id,
// i.e. the earlier/original draft).
export function detectDuplicate(
  rawText: string,
  sourceType: string,
  candidates: DupCandidate[],
): DupResult | null {
  const norm = normalizeText(rawText);
  if (!norm) return null;

  // Tier 0 — exact (source-agnostic). Earliest matching id is the original.
  let exact: DupCandidate | null = null;
  for (const c of candidates) {
    if (normalizeText(c.raw_text) === norm) {
      if (!exact || c.id < exact.id) exact = c;
    }
  }
  if (exact) return { dupOf: exact.id, dupKind: "exact", dupScore: 100 };

  // Tier 1 — near-dup, same source only.
  const mine = shingles(norm);
  let best: { id: number; score: number } | null = null;
  for (const c of candidates) {
    if (c.source_type !== sourceType) continue;
    const j = jaccard(mine, shingles(normalizeText(c.raw_text)));
    if (j < SIMILAR_THRESHOLD) continue;
    if (!best || j > best.score || (j === best.score && c.id < best.id)) {
      best = { id: c.id, score: j };
    }
  }
  if (best) return { dupOf: best.id, dupKind: "similar", dupScore: Math.round(best.score * 100) };

  return null;
}
