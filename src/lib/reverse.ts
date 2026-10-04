import { UA } from './errors';
import { haversineKm, type LatLon } from './geo';

type Fetch = typeof fetch;

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const line = (p: Record<string, string | undefined>) =>
  [[p.housenumber, p.street].filter(Boolean).join(' '), p.city ?? p.locality ?? p.district].filter(Boolean).join(', ');

/**
 * Pick the street address for a named place from Photon reverse results. Photon returns nearby
 * features, so prefer the one carrying the place's own name; otherwise fall back to the closest
 * street and say "near" so the user isn't told a neighbour's address is the place's.
 */
export function pickAddress(name: string, at: LatLon, features: PhotonFeature[]): string | null {
  const byDistance = [...features].sort(
    (a, b) =>
      haversineKm(at, { lat: a.geometry.coordinates[1], lon: a.geometry.coordinates[0] }) -
      haversineKm(at, { lat: b.geometry.coordinates[1], lon: b.geometry.coordinates[0] }),
  );
  const self = byDistance.find((f) => norm(f.properties.name) === norm(name) && f.properties.street);
  if (self) return line(self.properties);
  const street = byDistance.find((f) => f.properties.street || f.properties.type === 'street');
  if (!street) return null;
  const p = street.properties;
  const road = p.street ?? p.name;
  return road ? `near ${road}${p.city ? `, ${p.city}` : ''}` : null;
}

export async function reverseAddress(name: string, at: LatLon, f: Fetch = fetch): Promise<string | null> {
  const url = `https://photon.komoot.io/reverse?lat=${at.lat}&lon=${at.lon}&limit=5&lang=en`;
  const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) return null;
  const json = (await res.json()) as { features?: PhotonFeature[] };
  return pickAddress(name, at, json.features ?? []);
}
