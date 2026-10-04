import { describe, expect, it } from 'vitest';
import { equidistanceLabel, scoreCandidates, shouldWiden } from '../src/lib/score';

describe('scoreCandidates', () => {
  it('gives equal scores for symmetric inputs and breaks the tie by index', () => {
    const r = scoreCandidates([
      [600, 600],
      [600, 600],
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].max).toBe(r[1].max);
    expect(r[0].spread).toBe(0);
    expect(r.map((x) => x.index)).toEqual([0, 1]);
  });

  it('prefers minimax over smaller sum (N=2)', () => {
    // candidate 0: 100 / 900 (sum 1000, max 900); candidate 1: 600 / 600 (sum 1200, max 600)
    const r = scoreCandidates([
      [100, 600],
      [900, 600],
    ]);
    expect(r[0].index).toBe(1);
  });

  it('works for N=3', () => {
    const r = scoreCandidates([
      [300, 500],
      [700, 500],
      [500, 500],
    ]);
    expect(r[0].index).toBe(1);
    expect(r[0].max).toBe(500);
  });

  it('works for N=6', () => {
    const v = Array.from({ length: 6 }, (_, p) => [100 * (p + 1), 350]);
    const r = scoreCandidates(v);
    expect(r[0].index).toBe(1);
    expect(r[0].spread).toBe(0);
  });

  it('excludes candidates unreachable by anyone', () => {
    const r = scoreCandidates([
      [100, null, 400],
      [100, 200, undefined],
      [100, 200, 400],
    ]);
    expect(r.map((x) => x.index)).toEqual([0]);
  });

  it('breaks max ties by smaller spread, then smaller sum', () => {
    // all max 600. spreads: c0=300, c1=0 (sum 1200), c2=0 (sum 1800 -> but max 600 so sum 1800)
    const r = scoreCandidates([
      [300, 600, 600],
      [600, 600, 600],
      [600, 600, 600],
    ]);
    expect(r[0].index).toBe(1);
    // c1 and c2 identical, index decides; c0 (spread 300) is last
    expect(r[r.length - 1].index).toBe(0);

    const r2 = scoreCandidates([
      [500, 400],
      [500, 400],
    ]);
    // same spread (0), same max? no: max 500 vs 400 -> second wins on minimax
    expect(r2[0].index).toBe(1);
  });

  it('returns at most topN and handles empty input', () => {
    const row = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(scoreCandidates([row, row], 5)).toHaveLength(5);
    expect(scoreCandidates([])).toEqual([]);
  });
});

describe('shouldWiden', () => {
  it('widens when nothing was found or the spread is over 30% of max', () => {
    expect(shouldWiden(undefined)).toBe(true);
    expect(shouldWiden({ index: 0, max: 1000, min: 600, spread: 400, sum: 1600 })).toBe(true);
    expect(shouldWiden({ index: 0, max: 1000, min: 800, spread: 200, sum: 1800 })).toBe(false);
  });
});

describe('equidistanceLabel', () => {
  it('formats time and distance', () => {
    expect(equidistanceLabel(180, 'duration')).toBe('within 3 min of each other');
    expect(equidistanceLabel(20, 'duration')).toBe('within a minute of each other');
    expect(equidistanceLabel(1500, 'distance')).toBe('within 1.5 km of each other');
  });
});
