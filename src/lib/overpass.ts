import { AppError, UA } from './errors';
import { CATEGORIES, DEFAULT_CATEGORIES, categoryOf } from './categories';
import { haversineKm, type LatLon } from './geo';

type Fetch = typeof fetch;

export interface Poi extends LatLon {
  id: string;
  name: string;
  category: string;
}

// Public Overpass can be slow or unreachable from some networks (overpass-api.de itself returned 521
// to Cloudflare Workers), so try several healthy servers in order, each with its own timeout.
const ENDPOINTS: { url: string; timeoutMs: number }[] = [
  { url: 'https://lz4.overpass-api.de/api/interpreter', timeoutMs: 20_000 },
  { url: 'https://z.overpass-api.de/api/interpreter', timeoutMs: 15_000 },
  { url: 'https://overpass.openstreetmap.fr/api/interpreter', timeoutMs: 15_000 },
];

export function buildQuery(seed: LatLon, radiusM: number, categories: readonly string[] = DEFAULT_CATEGORIES): string {
  const around = `(around:${Math.round(radiusM)},${seed.lat.toFixed(5)},${seed.lon.toFixed(5)})`;
  // Group the chosen categories by OSM tag so one clause covers e.g. bar|pub|biergarten.
  const byTag = new Map<string, string[]>();
  for (const c of CATEGORIES) {
    if (!categories.includes(c.key)) continue;
    byTag.set(c.tag, [...(byTag.get(c.tag) ?? []), ...c.values]);
  }
  const parts = [...byTag].map(([tag, values]) => `nw["${tag}"~"^(${values.join('|')})$"]["name"]${around};`);
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
      category: categoryOf(el.tags),
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
      console.warn(`overpass ${new URL(url).host} status ${res.status}`);
    } catch (e) {
      lastStatus = 0;
      console.warn(`overpass ${new URL(url).host} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown'}`);
    }
  }
  throw new AppError('upstream', `Place lookup is busy right now (${lastStatus || 'network'}). Try again in a moment.`);
}
