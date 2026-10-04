export type Metric = 'duration' | 'distance';

/** values[person][candidate]; null/undefined/non-finite means unreachable. */
export type Matrix = ReadonlyArray<ReadonlyArray<number | null | undefined>>;

export interface Scored {
  /** Candidate index into the matrix columns. */
  index: number;
  max: number;
  min: number;
  spread: number;
  sum: number;
}

const EPS = 1e-6;

function cmp(a: number, b: number): number {
  return Math.abs(a - b) <= EPS ? 0 : a - b;
}

/**
 * Rank candidates for fairness: minimise the worst-off person (minimax), then the
 * spread (max - min), then the total. Candidates unreachable by anyone are dropped.
 */
export function scoreCandidates(values: Matrix, topN = 5): Scored[] {
  const people = values.length;
  if (people === 0) return [];
  const candidates = values[0].length;
  const out: Scored[] = [];

  for (let c = 0; c < candidates; c++) {
    let max = -Infinity;
    let min = Infinity;
    let sum = 0;
    let ok = true;
    for (let p = 0; p < people; p++) {
      const v = values[p][c];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        ok = false;
        break;
      }
      max = Math.max(max, v);
      min = Math.min(min, v);
      sum += v;
    }
    if (ok) out.push({ index: c, max, min, spread: max - min, sum });
  }

  out.sort(compareScored);
  return out.slice(0, topN);
}

/** Negative when a is the fairer pick. */
export function compareScored(a: Scored, b: Scored): number {
  return cmp(a.max, b.max) || cmp(a.spread, b.spread) || cmp(a.sum, b.sum) || a.index - b.index;
}

/** True when the best pick is lopsided (spread over 30% of max) and a wider search is worth one retry. */
export function shouldWiden(best: Scored | undefined): boolean {
  if (!best) return true;
  return best.max > 0 && best.spread > 0.3 * best.max;
}

export function equidistanceLabel(spread: number, metric: Metric): string {
  if (metric === 'duration') {
    const min = Math.round(spread / 60);
    if (min < 1) return 'within a minute of each other';
    return `within ${min} min of each other`;
  }
  const km = spread / 1000;
  if (km < 0.1) return 'within 100 m of each other';
  return `within ${km < 10 ? km.toFixed(1) : Math.round(km)} km of each other`;
}
