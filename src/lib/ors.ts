import { AppError, UA } from './errors';
import { haversineKm, type LatLon } from './geo';

type Fetch = typeof fetch;

export type Mode = 'driving' | 'walking' | 'cycling';
const PROFILE: Record<Mode, string> = {
  driving: 'driving-car',
  walking: 'foot-walking',
  cycling: 'cycling-regular',
};

export interface GeocodeHit extends LatLon {
  label: string;
  confidence: number | null;
  /** false when the geocoder only matched an area (city, county, neighbourhood), not the address itself */
  precise: boolean;
  /** ISO 3166-1 alpha-2, when the geocoder says */
  country?: string;
}

export interface GeocodeResult {
  results: GeocodeHit[];
  ambiguous: boolean;
  /** false when no result pinpoints the address; the UI must make the user confirm an approximate match */
  precise: boolean;
}

const ORS = 'https://api.openrouteservice.org';

function checkOrsStatus(res: Response) {
  if (res.status === 429 || res.status === 403) {
    throw new AppError('quota', 'The free routing quota is used up for now. Try again later.');
  }
  if (!res.ok) throw new AppError('upstream', `Routing service error (${res.status}).`);
}

interface PeliasFeature {
  geometry: { coordinates: [number, number] };
  properties: { label?: string; confidence?: number; layer?: string; match_type?: string; country_a?: string };
}

const PELIAS_PRECISE_LAYERS = new Set(['address', 'venue', 'street']);

export function parsePelias(json: { features?: PeliasFeature[] }): GeocodeHit[] {
  return (json.features ?? [])
    .filter((f) => f.geometry?.coordinates?.length === 2 && f.properties?.label)
    .map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.properties.label as string,
      confidence: typeof f.properties.confidence === 'number' ? f.properties.confidence : null,
      // Pelias answers with a "fallback" centroid of the city/county when it can't match the whole query,
      // which is wrong for an address; an exact match on a city ("Katy, TX") is a legitimate answer.
      precise: f.properties.match_type ? f.properties.match_type !== 'fallback' : PELIAS_PRECISE_LAYERS.has(f.properties.layer ?? ''),
      country: f.properties.country_a === 'USA' ? 'US' : f.properties.country_a,
    }));
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

const PHOTON_AREA_TYPES = new Set(['city', 'county', 'state', 'country', 'district', 'locality', 'region']);

export function parsePhoton(json: { features?: PhotonFeature[] }): GeocodeHit[] {
  return (json.features ?? [])
    .filter((f) => f.geometry?.coordinates?.length === 2)
    .map((f) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const label = [p.name && p.name !== p.street ? p.name : undefined, street || undefined, p.city, p.state, p.country]
        .filter(Boolean)
        .join(', ');
      return {
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        label,
        confidence: null,
        precise: !PHOTON_AREA_TYPES.has(p.type ?? ''),
        country: p.countrycode,
      };
    })
    .filter((h) => h.label);
}

/**
 * Ask the user to choose only when the alternatives are genuinely different places:
 * results within ~1.5 km of the top hit are treated as the same spot, otherwise a
 * clear confidence lead (Pelias) settles it.
 */
export function isAmbiguous(hits: GeocodeHit[]): boolean {
  if (hits.length <= 1) return false;
  const [a, ...rest] = hits;
  const far = rest.filter((h) => haversineKm(a, h) > 1.5);
  if (far.length === 0) return false;
  if (a.confidence != null && far.every((h) => h.confidence != null)) {
    return a.confidence < 0.85 || far.some((h) => (h.confidence as number) >= a.confidence! - 0.05);
  }
  return true;
}

async function geocodeOrs(text: string, key: string, f: Fetch, near?: LatLon, us = false): Promise<GeocodeHit[]> {
  let url = `${ORS}/geocode/search?size=5&text=${encodeURIComponent(text)}`;
  if (us) url += '&boundary.country=US';
  if (near) url += `&focus.point.lat=${near.lat}&focus.point.lon=${near.lon}`;
  const res = await f(url, { headers: { Authorization: key, 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  checkOrsStatus(res);
  return parsePelias(await res.json());
}

interface CensusJson {
  result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] };
}

export function parseCensus(json: CensusJson): GeocodeHit[] {
  return (json.result?.addressMatches ?? []).map((m) => ({
    lat: m.coordinates.y,
    lon: m.coordinates.x,
    label: m.matchedAddress
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/, ([a-z]{2}), /i, (_, st: string) => `, ${st.toUpperCase()} `),
    confidence: null,
    precise: true,
  }));
}

async function geocodeCensus(text: string, f: Fetch): Promise<GeocodeHit[]> {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' +
    encodeURIComponent(text);
  const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new AppError('upstream', `Census geocoder error (${res.status}).`);
  return parseCensus(await res.json());
}

async function geocodePhoton(text: string, f: Fetch, near?: LatLon): Promise<GeocodeHit[]> {
  let url = `https://photon.komoot.io/api/?limit=5&lang=en&q=${encodeURIComponent(text)}`;
  if (near) url += `&lat=${near.lat}&lon=${near.lon}`;
  const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError('upstream', `Geocoder error (${res.status}).`);
  return parsePhoton(await res.json());
}

/** "2946 Granite Vale Rd, Houston, TX": a number followed by a street name. */
export function looksLikeStreetAddress(text: string): boolean {
  return /^\s*\d+[A-Za-z]?\s+\S+/.test(text);
}

/** A ZIP code or a ", TX"-style state suffix: the user is clearly typing a US address. */
export function hasUsSignal(text: string): boolean {
  return /\b\d{5}(-\d{4})?\b/.test(text) || /,\s*[A-Za-z]{2}\b\s*(\d{5}(-\d{4})?)?\s*(,?\s*(USA|US|United States))?\s*$/.test(text);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'at', 'of', 'and', 'in', 'on']);
const ABBREV: Record<string, string> = {
  rd: 'road', st: 'street', dr: 'drive', cir: 'circle', blvd: 'boulevard', ave: 'avenue', ln: 'lane',
  pkwy: 'parkway', hwy: 'highway', ct: 'court', apts: 'apartments', apt: 'apartment',
};

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => ABBREV[t] ?? t)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/**
 * Share of the typed place name (text before the first comma) that appears in the hit's label.
 * Pelias will happily return "Energy, Wales" for "Vista Energy Corridor, Houston": one word matched.
 */
export function nameCoverage(text: string, label: string): number {
  const want = tokens(text.split(',')[0]);
  if (want.length === 0) return 1;
  const have = new Set(tokens(label));
  return want.filter((t) => have.has(t)).length / want.length;
}

const MIN_COVERAGE = 0.6;

/**
 * For a place name, results whose own name (label up to the first comma) is exactly what was typed
 * beat partial matches like "Wyndham Houston West Energy Corridor" or "Cardiff Castle Road".
 * With no exact name, order by how much of the typed name each covers.
 */
export function rankByName(text: string, hits: GeocodeHit[]): GeocodeHit[] {
  const want = new Set(tokens(text.split(',')[0]));
  const own = (h: GeocodeHit) => new Set(tokens(h.label.split(',')[0]));
  const exact = hits.filter((h) => {
    const have = own(h);
    return have.size === want.size && [...want].every((t) => have.has(t));
  });
  if (exact.length) return exact;
  const whole = (h: GeocodeHit) => nameCoverage(text, h.label);
  const lead = (h: GeocodeHit) => nameCoverage(text, h.label.split(',')[0]);
  return [...hits].sort((a, b) => whole(b) - whole(a) || lead(b) - lead(a));
}

function dedupe(hits: GeocodeHit[]): GeocodeHit[] {
  const out: GeocodeHit[] = [];
  for (const h of hits) if (!out.some((o) => haversineKm(o, h) < 0.15)) out.push(h);
  return out;
}

/**
 * Order matters: the US Census geocoder is authoritative for US street addresses (and free, keyless),
 * OpenRouteService covers places and the world, Photon is the last resort. A source is only
 * consulted further down the list if nothing before it gave a precise, relevant match.
 *
 * `near` (an address the user already entered) biases ranking toward their area.
 */
export async function geocode(text: string, key: string | undefined, f: Fetch = fetch, near?: LatLon): Promise<GeocodeResult> {
  const street = looksLikeStreetAddress(text);
  const us = hasUsSignal(text);

  // Drop hits that are in the wrong country, or (for place names) don't cover what was typed.
  const relevant = (hits: GeocodeHit[]) =>
    hits.filter((h) => (!us || !h.country || h.country === 'US') && (street || nameCoverage(text, h.label) >= MIN_COVERAGE));

  const hits: GeocodeHit[] = [];
  const havePrecise = () => hits.some((h) => h.precise);

  if (street) {
    try {
      hits.push(...(await geocodeCensus(text, f)));
    } catch {
      /* Census is best-effort; carry on */
    }
  }
  if (!havePrecise() && key) {
    try {
      hits.push(...relevant(await geocodeOrs(text, key, f, near, us)));
    } catch (e) {
      if (!(e instanceof AppError) || e.code === 'bad_request') throw e;
      // quota or upstream failure: fall through to Photon
    }
  }
  if (!havePrecise()) {
    try {
      // Photon has no "fallback" flag. A neighbourhood or complex it names exactly as typed is the answer.
      const named = relevant(await geocodePhoton(text, f, near)).map((h) =>
        !street && !h.precise && nameCoverage(text, h.label) >= 0.99 ? { ...h, precise: true } : h,
      );
      hits.push(...named);
    } catch (e) {
      if (hits.length === 0) throw e;
    }
  }
  if (hits.length === 0) {
    throw new AppError(
      'geocode_failed',
      street
        ? `Couldn't find "${text}". Check the spelling and add the city and state.`
        : `Couldn't find "${text}". Try its street address instead, e.g. "123 Main St, Houston, TX".`,
    );
  }

  const preciseHits = hits.filter((h) => h.precise);
  const precise = dedupe(street ? preciseHits : rankByName(text, preciseHits)).slice(0, 3);
  if (precise.length) return { results: precise, ambiguous: isAmbiguous(precise), precise: true };
  // Nothing pinpoints the address: show the closest areas and make the user confirm.
  return { results: dedupe(hits).slice(0, 3), ambiguous: true, precise: false };
}

export interface MatrixResult {
  /** [origin][destination] seconds, null if unreachable */
  durations: (number | null)[][];
  /** [origin][destination] metres, null if unreachable */
  distances: (number | null)[][];
}

export async function matrix(
  mode: Mode,
  origins: LatLon[],
  dests: LatLon[],
  key: string | undefined,
  f: Fetch = fetch,
): Promise<MatrixResult> {
  if (!key) throw new AppError('config', 'Routing is not configured on the server (missing ORS_API_KEY).');
  const locations = [...origins, ...dests].map((p) => [p.lon, p.lat]);
  const body = {
    locations,
    sources: origins.map((_, i) => i),
    destinations: dests.map((_, i) => origins.length + i),
    metrics: ['duration', 'distance'],
    units: 'm',
  };
  const res = await f(`${ORS}/v2/matrix/${PROFILE[mode]}`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  checkOrsStatus(res);
  const json = (await res.json()) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
  if (!json.durations || !json.distances) throw new AppError('upstream', 'Routing service returned no matrix.');
  return { durations: json.durations, distances: json.distances };
}
