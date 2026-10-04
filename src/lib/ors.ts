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
}

export interface GeocodeResult {
  results: GeocodeHit[];
  ambiguous: boolean;
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
  properties: { label?: string; confidence?: number };
}

export function parsePelias(json: { features?: PeliasFeature[] }): GeocodeHit[] {
  return (json.features ?? [])
    .filter((f) => f.geometry?.coordinates?.length === 2 && f.properties?.label)
    .map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.properties.label as string,
      confidence: typeof f.properties.confidence === 'number' ? f.properties.confidence : null,
    }));
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

export function parsePhoton(json: { features?: PhotonFeature[] }): GeocodeHit[] {
  return (json.features ?? [])
    .filter((f) => f.geometry?.coordinates?.length === 2)
    .map((f) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const label = [p.name && p.name !== p.street ? p.name : undefined, street || undefined, p.city, p.state, p.country]
        .filter(Boolean)
        .join(', ');
      return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label, confidence: null };
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

async function geocodeOrs(text: string, key: string, f: Fetch): Promise<GeocodeHit[]> {
  const url = `${ORS}/geocode/search?size=3&text=${encodeURIComponent(text)}`;
  const res = await f(url, { headers: { Authorization: key, 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  checkOrsStatus(res);
  return parsePelias(await res.json());
}

async function geocodePhoton(text: string, f: Fetch): Promise<GeocodeHit[]> {
  const url = `https://photon.komoot.io/api/?limit=3&q=${encodeURIComponent(text)}`;
  const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError('upstream', `Geocoder error (${res.status}).`);
  return parsePhoton(await res.json());
}

export async function geocode(text: string, key: string | undefined, f: Fetch = fetch): Promise<GeocodeResult> {
  let hits: GeocodeHit[] = [];
  if (key) {
    try {
      hits = await geocodeOrs(text, key, f);
    } catch (e) {
      if (!(e instanceof AppError) || e.code === 'bad_request') throw e;
      // quota or upstream failure: fall through to Photon
    }
  }
  if (hits.length === 0) hits = await geocodePhoton(text, f);
  if (hits.length === 0) throw new AppError('geocode_failed', `Couldn't find "${text}". Try adding the city and state.`);
  return { results: hits, ambiguous: isAmbiguous(hits) };
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
