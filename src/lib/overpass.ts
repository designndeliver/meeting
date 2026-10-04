import { AppError, UA } from './errors';
import { haversineKm, type LatLon } from './geo';

type Fetch = typeof fetch;

export interface Poi extends LatLon {
  id: string;
  name: string;
  category: string;
}

export const DEFAULT_CATEGORIES = ['cafe', 'restaurant', 'fast_food', 'library', 'park'] as const;

// Public Overpass can be slow under load (10-15 s is normal at busy times), so the primary gets a long timeout.
const ENDPOINTS: { url: string; timeoutMs: number }[] = [
  { url: 'https://overpass-api.de/api/interpreter', timeoutMs: 28_000 },
  { url: 'https://overpass.private.coffee/api/interpreter', timeoutMs: 15_000 },
];

export function buildQuery(seed: LatLon, radiusM: number, categories: readonly string[] = DEFAULT_CATEGORIES): string {
  const amenities = categories.filter((c) => c !== 'park');
  const around = `(around:${Math.round(radiusM)},${seed.lat.toFixed(5)},${seed.lon.toFixed(5)})`;
  const parts: string[] = [];
  if (amenities.length) parts.push(`nw["amenity"~"^(${amenities.join('|')})$"]["name"]${around};`);
  if (categories.includes('park')) parts.push(`nw["leisure"="park"]["name"]${around};`);
  return `[out:json][timeout:25];(${parts.join('')});out center 800;`;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string | undefined>;
}

export function parseOverpass(json: { elements?: OverpassElement[] }, seed: LatLon, limit = 800): Poi[] {
  const pois: Poi[] = [];
  for (const el of json.elements ?? []) {
    const name = el.tags?.name;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat == null || lon == null) continue;
    pois.push({
      id: `${el.type}/${el.id}`,
      name,
      lat,
      lon,
      category: el.tags?.amenity ?? el.tags?.leisure ?? 'place',
    });
  }
  return pois
    .map((p) => ({ p, d: haversineKm(p, seed) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.p);
}

export async function fetchOverpass(query: string, f: Fetch = fetch): Promise<{ elements?: OverpassElement[] }> {
  let lastStatus = 0;
  for (const { url, timeoutMs } of ENDPOINTS) {
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      lastStatus = res.status;
    } catch {
      lastStatus = 0;
    }
  }
  throw new AppError('upstream', `Place lookup is busy right now (${lastStatus || 'network'}). Try again in a moment.`);
}
