import { describe, expect, it } from 'vitest';
import { geometricMedian, haversineKm, searchRadiusKm } from '../src/lib/geo';

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
