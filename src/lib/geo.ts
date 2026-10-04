export interface LatLon {
  lat: number;
  lon: number;
}

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Geometric median (Weiszfeld). Iterates in a local equirectangular plane,
 * which is accurate enough for metro-scale spreads. Two points give the midpoint.
 */
export function geometricMedian(points: LatLon[], weights?: number[], maxIter = 200, eps = 1e-10): LatLon {
  if (points.length === 0) throw new Error('geometricMedian needs at least one point');
  if (points.length === 1) return { ...points[0] };

  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const k = Math.cos(rad(lat0));
  const pts = points.map((p) => ({ x: p.lon * k, y: p.lat }));
  // Weights above 1 pull the result toward that point; used to favour people with longer trips.
  const w = points.map((_, i) => Math.max(weights?.[i] ?? 1, 1e-6));
  const wTotal = w.reduce((a, b) => a + b, 0);

  let x = pts.reduce((s, p, i) => s + p.x * w[i], 0) / wTotal;
  let y = pts.reduce((s, p, i) => s + p.y * w[i], 0) / wTotal;

  for (let i = 0; i < maxIter; i++) {
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    let onVertex: { x: number; y: number } | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 1e-12) {
        onVertex = p;
        break;
      }
      wx += (w[i] * p.x) / d;
      wy += (w[i] * p.y) / d;
      wsum += w[i] / d;
    }
    if (onVertex) {
      x = onVertex.x;
      y = onVertex.y;
      break;
    }
    const nx = wx / wsum;
    const ny = wy / wsum;
    const moved = Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    if (moved < eps) break;
  }
  return { lat: y, lon: x / k };
}

export const MIN_RADIUS_KM = 1.5;
export const MAX_RADIUS_KM = 15;

/** Search radius = max(1.5 km, 0.6 x largest origin-to-seed distance), capped at 15 km. */
export function searchRadiusKm(origins: LatLon[], seed: LatLon): number {
  const far = Math.max(...origins.map((o) => haversineKm(o, seed)));
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, 0.6 * far));
}

export function widenRadiusKm(radiusKm: number): number {
  return Math.min(MAX_RADIUS_KM, radiusKm * 1.8);
}

/**
 * Pick up to n points that cover the whole area (farthest-point sampling), starting from the
 * one nearest the seed. Taking the n nearest instead would cluster everything in a dense centre.
 */
export function spreadSelect<T extends LatLon>(items: T[], seed: LatLon, n: number): T[] {
  if (items.length <= n) return items;
  const first = items.reduce((best, it) => (haversineKm(it, seed) < haversineKm(best, seed) ? it : best));
  const chosen: T[] = [first];
  const minDist = items.map((it) => haversineKm(it, first));
  while (chosen.length < n) {
    let bi = -1;
    for (let i = 0; i < items.length; i++) if (minDist[i] > 0 && (bi < 0 || minDist[i] > minDist[bi])) bi = i;
    if (bi < 0) break;
    const pick = items[bi];
    chosen.push(pick);
    for (let i = 0; i < items.length; i++) minDist[i] = Math.min(minDist[i], haversineKm(items[i], pick));
    minDist[bi] = 0;
  }
  return chosen;
}
