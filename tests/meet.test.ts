import { describe, expect, it, vi } from 'vitest';
import { findMeetingPoints, type MeetDeps } from '../src/lib/meet';
import { AppError } from '../src/lib/errors';
import { parseOverpass, buildQuery } from '../src/lib/overpass';
import { isAmbiguous, parsePelias, parsePhoton } from '../src/lib/ors';

const a = { lat: 29.7858, lon: -95.8244 };
const b = { lat: 29.9691, lon: -95.6972 };
const poi = (i: number) => ({ id: `node/${i}`, name: `Place ${i}`, lat: 29.88, lon: -95.76, category: 'cafe' });

function deps(pois: ReturnType<typeof poi>[], d: number[][], dist = d.map((r) => r.map((x) => x * 10))): MeetDeps {
  return {
    pois: async () => pois,
    matrix: async () => ({ durations: d, distances: dist }),
  };
}

describe('findMeetingPoints', () => {
  it('ranks by the chosen metric and reports per-person legs', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b], metric: 'duration', mode: 'driving' },
      deps([poi(1), poi(2)], [[300, 600], [900, 620]]),
    );
    expect(out.results[0].poi.name).toBe('Place 2');
    expect(out.results[0].legs).toHaveLength(2);
    expect(out.results[0].legs[1].distance).toBe(6200);
    expect(out.results[0].equidistance).toBe('within a minute of each other');
  });

  it('ranks by distance when asked', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b], metric: 'distance', mode: 'driving' },
      deps([poi(1), poi(2)], [[100, 100], [100, 100]], [[5000, 3000], [5000, 3500]]),
    );
    expect(out.results[0].poi.name).toBe('Place 2');
    expect(out.results[0].max).toBe(3500);
  });

  it('widens once when the first pick is lopsided and keeps the better result', async () => {
    const pois = vi.fn();
    pois.mockResolvedValueOnce([poi(1)]).mockResolvedValueOnce([poi(2)]);
    const matrix = vi.fn();
    matrix
      .mockResolvedValueOnce({ durations: [[300], [1000]], distances: [[1], [1]] })
      .mockResolvedValueOnce({ durations: [[700], [720]], distances: [[1], [1]] });
    const out = await findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, { pois, matrix });
    expect(pois).toHaveBeenCalledTimes(2);
    expect(out.widened).toBe(true);
    expect(out.results[0].poi.name).toBe('Place 2');
  });

  it('does not widen when the first pick is already fair', async () => {
    const pois = vi.fn().mockResolvedValue([poi(1)]);
    const matrix = vi.fn().mockResolvedValue({ durations: [[600], [620]], distances: [[1], [1]] });
    const out = await findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, { pois, matrix });
    expect(pois).toHaveBeenCalledTimes(1);
    expect(out.widened).toBe(false);
  });

  it('throws no_pois when nothing is found or everything is unreachable', async () => {
    await expect(
      findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, deps([], [[], []])),
    ).rejects.toMatchObject({ code: 'no_pois' });
    await expect(
      findMeetingPoints(
        { origins: [a, b], metric: 'duration', mode: 'driving' },
        { pois: async () => [poi(1)], matrix: async () => ({ durations: [[null], [5]], distances: [[null], [5]] }) },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('works for three origins', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b, { lat: 30.1658, lon: -95.4613 }], metric: 'duration', mode: 'driving' },
      deps([poi(1), poi(2)], [[600, 900], [650, 300], [640, 1000]]),
    );
    expect(out.results[0].poi.name).toBe('Place 1');
    expect(out.results[0].legs).toHaveLength(3);
  });
});

describe('overpass parsing', () => {
  it('keeps named places, uses centre for ways, sorts by distance to seed, and caps the list', () => {
    const seed = { lat: 30, lon: -95 };
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 30.05, lon: -95, tags: { name: 'Far Cafe', amenity: 'cafe' } },
        { type: 'way', id: 2, center: { lat: 30.001, lon: -95 }, tags: { name: 'Near Park', leisure: 'park' } },
        { type: 'node', id: 3, lat: 30.0, lon: -95, tags: { amenity: 'cafe' } },
      ],
    };
    const out = parseOverpass(json, seed, 40);
    expect(out.map((p) => p.name)).toEqual(['Near Park', 'Far Cafe']);
    expect(out[0].category).toBe('park');
    expect(parseOverpass(json, seed, 1)).toHaveLength(1);
  });

  it('builds a query with amenities and parks', () => {
    const q = buildQuery({ lat: 30, lon: -95 }, 2000);
    expect(q).toContain('cafe|restaurant|fast_food|library');
    expect(q).toContain('"leisure"="park"');
    expect(q).toContain('around:2000,30.00000,-95.00000');
  });
});

describe('geocode parsing', () => {
  it('parses Pelias and flags ambiguity by confidence', () => {
    const hits = parsePelias({
      features: [
        { geometry: { coordinates: [-95.8, 29.7] }, properties: { label: 'A, Katy, TX', confidence: 1 } },
        { geometry: { coordinates: [-95.9, 29.6] }, properties: { label: 'A, Houston, TX', confidence: 0.6 } },
      ],
    });
    expect(hits[0]).toEqual({ lat: 29.7, lon: -95.8, label: 'A, Katy, TX', confidence: 1 });
    expect(isAmbiguous(hits)).toBe(false);
    expect(isAmbiguous([hits[0], { ...hits[1], confidence: 0.98 }])).toBe(true);
    expect(isAmbiguous([hits[0]])).toBe(false);
    // near-duplicates of the same spot are not worth asking about
    expect(isAmbiguous([hits[0], { ...hits[0], label: 'same place', confidence: 0.99 }])).toBe(false);
  });

  it('parses Photon and treats confidence-less multiples as ambiguous', () => {
    const hits = parsePhoton({
      features: [
        { geometry: { coordinates: [-95.8, 29.7] }, properties: { housenumber: '1', street: 'Main St', city: 'Katy', state: 'Texas', country: 'USA' } },
        { geometry: { coordinates: [-95.9, 29.6] }, properties: { name: 'Main St', city: 'Houston' } },
      ],
    });
    expect(hits[0].label).toBe('1 Main St, Katy, Texas, USA');
    expect(isAmbiguous(hits)).toBe(true);
  });
});
