import { describe, expect, it } from 'vitest';
import { geometricMedian, haversineKm, searchRadiusKm, spreadSelect } from '../src/lib/geo';

const katy = { lat: 29.7858, lon: -95.8244 };
const cypress = { lat: 29.9691, lon: -95.6972 };
const woodlands = { lat: 30.1658, lon: -95.4613 };

describe('haversineKm', () => {
  it('is zero for identical points and symmetric', () => {
    expect(haversineKm(katy, katy)).toBe(0);
    expect(haversineKm(katy, cypress)).toBeCloseTo(haversineKm(cypress, katy), 9);
  });
  it('matches a known distance (Katy to The Woodlands ~ 58 km)', () => {
    const d = haversineKm(katy, woodlands);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(65);
  });
});

describe('geometricMedian', () => {
  it('returns the midpoint for two points', () => {
    const m = geometricMedian([katy, woodlands]);
    expect(m.lat).toBeCloseTo((katy.lat + woodlands.lat) / 2, 4);
    expect(m.lon).toBeCloseTo((katy.lon + woodlands.lon) / 2, 4);
  });
  it('returns the point itself for one point', () => {
    expect(geometricMedian([katy])).toEqual(katy);
  });
  it('is the centre of a symmetric triangle', () => {
    const pts = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 2 },
      { lat: 2, lon: 1 },
    ];
    const m = geometricMedian(pts);
    expect(m.lon).toBeCloseTo(1, 1);
  });
  it('is robust to an outlier, unlike the plain average', () => {
    const pts = [
      { lat: 30, lon: -95 },
      { lat: 30.001, lon: -95 },
      { lat: 30, lon: -95.001 },
      { lat: 31, lon: -94 },
    ];
    const m = geometricMedian(pts);
    expect(haversineKm(m, pts[0])).toBeLessThan(1);
  });
  it('does not blow up when the estimate lands on a vertex', () => {
    const p = { lat: 10, lon: 10 };
    const m = geometricMedian([p, p, { lat: 10.5, lon: 10.5 }]);
    expect(Number.isFinite(m.lat) && Number.isFinite(m.lon)).toBe(true);
  });
});

describe('searchRadiusKm', () => {
  it('has a 1.5 km floor', () => {
    const a = { lat: 30, lon: -95 };
    expect(searchRadiusKm([a, { lat: 30.001, lon: -95 }], a)).toBe(1.5);
  });
  it('scales at 0.6 x farthest origin', () => {
    const seed = geometricMedian([katy, cypress]);
    const far = haversineKm(katy, seed);
    expect(far).toBeLessThan(25);
    expect(searchRadiusKm([katy, cypress], seed)).toBeCloseTo(Math.max(1.5, 0.6 * far), 6);
  });
  it('is capped at 15 km', () => {
    const a = { lat: 30, lon: -95 };
    const b = { lat: 35, lon: -90 };
    expect(searchRadiusKm([a, b], geometricMedian([a, b]))).toBe(15);
  });
});

describe('weighted geometricMedian', () => {
  it('moves toward the heavier point', () => {
    const plain = geometricMedian([katy, woodlands]);
    const pulled = geometricMedian([katy, woodlands], [1, 3]);
    expect(haversineKm(pulled, woodlands)).toBeLessThan(haversineKm(plain, woodlands));
  });
});

describe('spreadSelect', () => {
  it('covers the area instead of clustering near the seed', () => {
    const seed = { lat: 30, lon: -95 };
    // 50 points packed within ~100 m of the seed, plus 5 spread far out
    const dense = Array.from({ length: 50 }, (_, i) => ({ lat: 30 + i * 1e-5, lon: -95 }));
    const far = [0.05, 0.1, 0.15, 0.2, 0.25].map((d) => ({ lat: 30 + d, lon: -95 }));
    const picked = spreadSelect([...dense, ...far], seed, 6);
    expect(picked).toHaveLength(6);
    expect(far.every((f) => picked.includes(f))).toBe(true);
  });
  it('returns everything when there are fewer than n, and never duplicates', () => {
    const pts = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
    expect(spreadSelect(pts, pts[0], 5)).toEqual(pts);
    const many = Array.from({ length: 20 }, (_, i) => ({ lat: i, lon: i }));
    const picked = spreadSelect(many, many[0], 10);
    expect(new Set(picked).size).toBe(10);
  });
});
