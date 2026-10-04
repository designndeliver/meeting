import { describe, expect, it, vi } from 'vitest';
import { findMeetingPoints, type MeetDeps } from '../src/lib/meet';
import { AppError } from '../src/lib/errors';
import { parseOverpass, buildQuery } from '../src/lib/overpass';
import { CATEGORIES, categoryOf, parseCategories } from '../src/lib/categories';
import { disambiguate, geocode, hasUsSignal, isAmbiguous, looksLikeStreetAddress, nameCoverage, parseCensus, rankByName, parsePelias, parsePhoton } from '../src/lib/ors';

const a = { lat: 29.7858, lon: -95.8244 };
const b = { lat: 29.9691, lon: -95.6972 };
const poi = (i: number) => ({ id: `node/${i}`, name: `Place ${i}`, lat: 29.88 + i * 0.002, lon: -95.76 - i * 0.001, category: 'cafe' });

/** Matrix mock: durations/distances looked up by place name, so tests control exactly who is fair. */
function deps(
  pool: ReturnType<typeof poi>[],
  dur: Record<string, number[]>,
  dist: Record<string, number[]> = Object.fromEntries(Object.entries(dur).map(([k, v]) => [k, v.map((x) => x * 10)])),
): MeetDeps {
  return {
    pois: async () => pool,
    matrix: async (_m, origins, dests) => ({
      durations: origins.map((_, p) => dests.map((d) => dur[d.name]?.[p] ?? null)),
      distances: origins.map((_, p) => dests.map((d) => dist[d.name]?.[p] ?? null)),
    }),
  };
}

describe('findMeetingPoints', () => {
  it('ranks by the chosen metric and reports per-person legs', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b], metric: 'duration', mode: 'driving' },
      deps([poi(1), poi(2)], { 'Place 1': [300, 900], 'Place 2': [600, 620] }),
    );
    expect(out.results[0].poi.name).toBe('Place 2');
    expect(out.results[0].legs).toHaveLength(2);
    expect(out.results[0].legs[1].distance).toBe(6200);
    expect(out.results[0].equidistance).toBe('within a minute of each other');
    expect(out.refined).toBe(false);
  });

  it('ranks by distance when asked', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b], metric: 'distance', mode: 'driving' },
      deps([poi(1), poi(2)], { 'Place 1': [100, 100], 'Place 2': [100, 100] }, { 'Place 1': [5000, 3000], 'Place 2': [5000, 3500] }),
    );
    // Place 1 max 5000, Place 2 max 5000 -> tie on max, spread 2000 vs 1500 -> Place 2
    expect(out.results[0].poi.name).toBe('Place 2');
  });

  it('refines around a lopsided first pick and keeps the fairer result', async () => {
    const pool = Array.from({ length: 60 }, (_, i) => poi(i + 1));
    const calls: string[][] = [];
    const matrix = vi.fn(async (_m: unknown, origins: unknown[], dests: { name: string }[]) => {
      calls.push(dests.map((d) => d.name));
      const lopsided = calls.length === 1;
      const row = (v: number) => dests.map(() => v);
      return {
        durations: origins.map((_, p) => row(lopsided ? (p === 0 ? 300 : 1000) : p === 0 ? 700 : 720)),
        distances: origins.map(() => row(1)),
      };
    });
    const out = await findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, { pois: async () => pool, matrix } as unknown as MeetDeps);
    expect(matrix).toHaveBeenCalledTimes(2);
    expect(calls[0]).toHaveLength(40);
    expect(calls[1].every((n) => !calls[0].includes(n))).toBe(true);
    expect(calls[1]).toHaveLength(20); // only 20 places were left unevaluated
    expect(out.refined).toBe(true);
    expect(out.results[0].max).toBe(720);
    expect(calls[1]).toContain(out.results[0].poi.name);
  });

  it('does not refine when the first pick is already fair', async () => {
    const matrix = vi.fn(async (_m: unknown, o: unknown[], d: unknown[]) => ({
      durations: o.map((_, p) => d.map(() => 600 + p * 20)),
      distances: o.map((_) => d.map(() => 1)),
    }));
    const out = await findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, { pois: async () => [poi(1), poi(2)], matrix } as MeetDeps);
    expect(matrix).toHaveBeenCalledTimes(1);
    expect(out.refined).toBe(false);
  });

  it('widens the area once when the first lookup is empty', async () => {
    const pois = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([poi(1)]);
    const matrix = vi.fn(async (_m: unknown, o: unknown[], d: unknown[]) => ({
      durations: o.map(() => d.map(() => 600)),
      distances: o.map(() => d.map(() => 1)),
    }));
    const out = await findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, { pois, matrix } as MeetDeps);
    expect(pois).toHaveBeenCalledTimes(2);
    expect(out.results[0].poi.name).toBe('Place 1');
  });

  it('throws no_pois when nothing is found or everything is unreachable', async () => {
    await expect(findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, deps([], {}))).rejects.toMatchObject({ code: 'no_pois' });
    await expect(
      findMeetingPoints({ origins: [a, b], metric: 'duration', mode: 'driving' }, deps([poi(1)], {})),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('works for three origins', async () => {
    const out = await findMeetingPoints(
      { origins: [a, b, { lat: 30.1658, lon: -95.4613 }], metric: 'duration', mode: 'driving' },
      deps([poi(1), poi(2)], { 'Place 1': [600, 650, 640], 'Place 2': [900, 300, 1000] }),
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
    expect(q).toContain('"leisure"~"^(park)$"');
    expect(q).toContain('around:2000,30.00000,-95.00000');
  });
});

describe('geocode parsing', () => {
  it('parses Pelias and flags ambiguity by confidence', () => {
    const hits = parsePelias({
      features: [
        { geometry: { coordinates: [-95.8, 29.7] }, properties: { label: 'A, Katy, TX', confidence: 1, layer: 'address', match_type: 'exact' } },
        { geometry: { coordinates: [-95.9, 29.6] }, properties: { label: 'A, Houston, TX', confidence: 0.6, layer: 'address', match_type: 'exact' } },
      ],
    });
    expect(hits[0]).toMatchObject({ lat: 29.7, lon: -95.8, label: 'A, Katy, TX', confidence: 1 });
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

describe('geocode precision', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const censusHit = { result: { addressMatches: [{ matchedAddress: '2946 GRANITE VALE RD, HOUSTON, TX, 77084', coordinates: { x: -95.6953, y: 29.8109 } }] } };
  const orsCityOnly = {
    features: [
      { geometry: { coordinates: [-95.36, 29.78] }, properties: { label: 'Houston, TX, USA', confidence: 0.6, layer: 'locality', match_type: 'fallback' } },
      { geometry: { coordinates: [-95.43, 31.33] }, properties: { label: 'Houston County, TX, USA', confidence: 0.4, layer: 'county', match_type: 'fallback' } },
    ],
  };
  const fakeFetch = (routes: { census?: unknown; ors?: unknown; photon?: unknown }) =>
    (async (url: string) => {
      if (url.includes('census.gov')) return json(routes.census ?? { result: { addressMatches: [] } });
      if (url.includes('openrouteservice')) return json(routes.ors ?? { features: [] });
      return json(routes.photon ?? { features: [] });
    }) as unknown as typeof fetch;

  it('treats an exact Pelias match on a city as precise, but a fallback as approximate', () => {
    const [exact, fallback] = parsePelias({
      features: [
        { geometry: { coordinates: [-95.8, 29.79] }, properties: { label: 'Katy, TX, USA', confidence: 1, layer: 'locality', match_type: 'exact' } },
        { geometry: { coordinates: [-95.4, 29.78] }, properties: { label: 'Houston, TX, USA', confidence: 0.6, layer: 'locality', match_type: 'fallback' } },
      ],
    });
    expect(exact.precise).toBe(true);
    expect(fallback.precise).toBe(false);
  });

  it('detects street-address-shaped input', () => {
    expect(looksLikeStreetAddress('2946 Granite Vale Rd, Houston, TX')).toBe(true);
    expect(looksLikeStreetAddress('The Woodlands Mall')).toBe(false);
  });

  it('parses Census matches as precise and tidies the label', () => {
    const [h] = parseCensus(censusHit);
    expect(h).toMatchObject({ lat: 29.8109, lon: -95.6953, precise: true });
    expect(h.label).toBe('2946 Granite Vale Rd, Houston, TX 77084');
  });

  it('prefers the Census match over an ORS city-level fallback', async () => {
    const r = await geocode('2946 Granite Vale Rd, Houston, TX 77084', 'key', fakeFetch({ census: censusHit, ors: orsCityOnly }));
    expect(r.precise).toBe(true);
    expect(r.ambiguous).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].label).toContain('Granite Vale');
  });

  it('flags results as approximate when only areas match, and requires confirmation', async () => {
    const r = await geocode('99999 Nowhere Ln, Houston, TX', 'key', fakeFetch({ ors: orsCityOnly }));
    expect(r.precise).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.results.every((h) => !h.precise)).toBe(true);
  });

  it('falls through to Photon, and keeps only precise hits when any exist', async () => {
    const photon = {
      features: [
        { geometry: { coordinates: [-95.45, 30.16] }, properties: { type: 'house', name: 'The Woodlands Mall', city: 'The Woodlands', state: 'Texas' } },
        { geometry: { coordinates: [-95.46, 30.17] }, properties: { type: 'city', name: 'The Woodlands', state: 'Texas' } },
      ],
    };
    const r = await geocode('The Woodlands Mall', 'key', fakeFetch({ ors: orsCityOnly, photon }));
    expect(r.precise).toBe(true);
    expect(r.results.map((h) => h.label)).toEqual(['The Woodlands Mall, The Woodlands, Texas']);
  });

  it('does not call Census for non-street input', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return json({ features: [] });
    }) as unknown as typeof fetch;
    await geocode('Katy Mills', undefined, f).catch(() => undefined);
    expect(calls.some((u) => u.includes('census.gov'))).toBe(false);
  });

  it('throws geocode_failed when nobody finds anything', async () => {
    await expect(geocode('zzzz qqqq', 'key', fakeFetch({}))).rejects.toMatchObject({ code: 'geocode_failed' });
  });
});

describe('place-name relevance', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const pelias = (label: string, country_a = 'USA') => ({
    geometry: { coordinates: [-95.4, 29.7] },
    properties: { label, confidence: 1, layer: 'street', match_type: 'exact', country_a },
  });
  const energyJunk = {
    features: [pelias('Energy, Glyncorrwg, Wales, United Kingdom', 'GBR'), pelias('Energy, LG, Philippines', 'PHL'), pelias('Energy, Limestone, ME, USA')],
  };
  const photonVista = {
    features: [
      { geometry: { coordinates: [-95.6408, 29.7572] }, properties: { type: 'locality', name: 'Vista Energy Corridor', city: 'Houston', state: 'Texas', countrycode: 'US' } },
    ],
  };

  it('scores how much of the typed name a result covers', () => {
    expect(nameCoverage('Vista Energy Corridor, Houston, TX', 'Energy, Limestone, ME, USA')).toBeCloseTo(1 / 3, 5);
    expect(nameCoverage('Vista Energy Corridor, Houston, TX', 'Vista Energy Corridor, Houston, Texas')).toBe(1);
    expect(nameCoverage('Katy Mills Cir', 'Katy Mills Circle, Katy, TX, USA')).toBe(1);
    expect(nameCoverage('Estates at Fountain Lake Apartments', 'Estates at Wellington Green Aparments, Wellington')).toBeLessThan(0.6);
  });

  it('detects US context from a ZIP code or state suffix', () => {
    expect(hasUsSignal('Vista Energy Corridor, Houston, TX 77077')).toBe(true);
    expect(hasUsSignal('Katy, TX')).toBe(true);
    expect(hasUsSignal('Cardiff Castle, Wales')).toBe(false);
    expect(hasUsSignal('Estates at Fountain Lake Apartments')).toBe(false);
  });

  it('ignores ORS keyword junk and finds the place through Photon', async () => {
    const f = (async (url: string) => (url.includes('openrouteservice') ? json(energyJunk) : json(photonVista))) as unknown as typeof fetch;
    const r = await geocode('Vista Energy Corridor, Houston, TX 77077', 'key', f);
    expect(r.precise).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].label).toContain('Vista Energy Corridor');
  });

  it('drops non-US hits when the input is clearly a US address', async () => {
    const mixed = { features: [pelias('Vista Energy Corridor, Wales, United Kingdom', 'GBR'), pelias('Vista Energy Corridor, Houston, TX, USA')] };
    const f = (async () => json(mixed)) as unknown as typeof fetch;
    const r = await geocode('Vista Energy Corridor, Houston, TX', 'key', f);
    expect(r.results.map((h) => h.label)).toEqual(['Vista Energy Corridor, Houston, TX, USA']);
  });

  it('fails clearly, rather than showing junk, for a place nobody has', async () => {
    const photonFar = {
      features: [{ geometry: { coordinates: [-80.2, 26.6] }, properties: { type: 'locality', name: 'Estates at Wellington Green Aparments', city: 'Wellington', state: 'Florida', countrycode: 'US' } }],
    };
    const f = (async (url: string) => (url.includes('openrouteservice') ? json({ features: [] }) : json(photonFar))) as unknown as typeof fetch;
    await expect(geocode('Estates at Fountain Lake Apartments', 'key', f)).rejects.toMatchObject({
      code: 'geocode_failed',
      message: expect.stringContaining('street address'),
    });
  });

  it('passes the location bias to ORS and Photon', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return json({ features: [] });
    }) as unknown as typeof fetch;
    await geocode('Some Place', 'key', f, { lat: 29.78, lon: -95.6 }).catch(() => undefined);
    expect(urls.find((u) => u.includes('openrouteservice'))).toContain('focus.point.lat=29.78');
    expect(urls.find((u) => u.includes('photon'))).toContain('lat=29.78&lon=-95.6');
  });
});

describe('rankByName', () => {
  const hit = (label: string) => ({ lat: 0, lon: 0, label, confidence: null, precise: true });
  it('keeps only results named exactly as typed when there are any', () => {
    const out = rankByName('Vista Energy Corridor, Houston, TX', [
      hit('Wyndham Houston West Energy Corridor, Park Row, Houston'),
      hit('Vista Energy Corridor, Houston, Texas'),
    ]);
    expect(out.map((h) => h.label)).toEqual(['Vista Energy Corridor, Houston, Texas']);
    const castle = rankByName('Cardiff Castle, Wales', [hit('Cardiff Castle Road, Dublin'), hit('Cardiff Castle, Cardiff County, Wales')]);
    expect(castle).toHaveLength(1);
    expect(castle[0].label).toContain('Cardiff County');
  });
  it('falls back to ordering by coverage when nothing matches exactly', () => {
    const out = rankByName('Starbucks Katy', [hit('Katy Freeway, Houston'), hit('Starbucks, Katy, TX')]);
    expect(out[0].label).toContain('Starbucks');
  });
});

describe('categories', () => {
  it('parses a selection: keeps valid keys, drops junk, falls back to defaults', () => {
    expect(parseCategories(['bar', 'gas_station', 'nope', 7])).toEqual(['bar', 'gas_station']);
    expect(parseCategories(['nope'])).toEqual(['cafe', 'restaurant', 'fast_food', 'library', 'park']);
    expect(parseCategories(undefined)).toEqual(['cafe', 'restaurant', 'fast_food', 'library', 'park']);
    expect(parseCategories(['park', 'park', 'cafe'])).toEqual(['cafe', 'park']);
  });

  it('maps OSM tags to a category', () => {
    expect(categoryOf({ amenity: 'pub' })).toBe('bar');
    expect(categoryOf({ amenity: 'fuel' })).toBe('gas_station');
    expect(categoryOf({ shop: 'mall' })).toBe('mall');
    expect(categoryOf({ leisure: 'park' })).toBe('park');
    expect(categoryOf({ amenity: 'bank' })).toBe('place');
    expect(categoryOf(undefined)).toBe('place');
  });

  it('every category has a unique key and at least one value', () => {
    expect(new Set(CATEGORIES.map((c) => c.key)).size).toBe(CATEGORIES.length);
    expect(CATEGORIES.every((c) => c.values.length > 0)).toBe(true);
  });

  it('builds a query only for the chosen categories, grouped by tag', () => {
    const q = buildQuery({ lat: 30, lon: -95 }, 2000, ['bar', 'gas_station', 'mall']);
    expect(q).toContain('"amenity"~"^(bar|pub|biergarten|fuel)$"');
    expect(q).toContain('"shop"~"^(mall)$"');
    expect(q).not.toContain('leisure');
    expect(q).not.toContain('restaurant');
    expect(q).toContain('around:2000,30.00000,-95.00000');
  });
});

describe('disambiguate', () => {
  const h = (lat: number, lon: number, detail?: string) => ({ lat, lon, label: 'Starbucks, Katy, TX, USA', confidence: null, precise: true, detail });
  it('leaves distinct labels alone and strips their detail', () => {
    const out = disambiguate([{ ...h(29.7, -95.8, '1 Main St'), label: 'A' }, { ...h(29.8, -95.7, '2 Main St'), label: 'B' }]);
    expect(out.every((x) => x.detail === undefined && x.compass === undefined)).toBe(true);
  });
  it('keeps street detail and adds direction for colliding labels', () => {
    const out = disambiguate([h(29.9, -95.7, '19914 Park Row Dr, 77449'), h(29.7, -95.7), h(29.8, -95.6, '1711 Westgreen Blvd')]);
    expect(out[0].detail).toBe('19914 Park Row Dr, 77449');
    expect(out[0].compass).toBe('north');
    expect(out[1].compass).toBe('south');
    expect(out[2].compass).toBe('east');
    expect(out.every((x) => x.fromNearKm === undefined)).toBe(true);
  });
  it('adds distance from the near point when given', () => {
    const out = disambiguate([h(29.81, -95.69), h(29.7, -95.8)], { lat: 29.81, lon: -95.69 });
    expect(out[0].fromNearKm).toBe(0);
    expect(out[1].fromNearKm).toBeGreaterThan(10);
  });
});

describe('pelias detail', () => {
  it('captures street address and postcode', () => {
    const [hit] = parsePelias({
      features: [
        {
          geometry: { coordinates: [-95.8, 29.7] },
          properties: { label: 'Starbucks, Katy, TX, USA', confidence: 1, layer: 'venue', match_type: 'exact', housenumber: '19914', street: 'Park Row Dr', neighbourhood: 'Eldridge', postalcode: '77449' },
        },
      ],
    });
    expect(hit.detail).toBe('19914 Park Row Dr, 77449');
  });
});
