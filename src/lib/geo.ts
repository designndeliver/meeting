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
export function geometricMedian(points: LatLon[], maxIter = 200, eps = 1e-10): LatLon {
  if (points.length === 0) throw new Error('geometricMedian needs at least one point');
  if (points.length === 1) return { ...points[0] };

  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const k = Math.cos(rad(lat0));
  const pts = points.map((p) => ({ x: p.lon * k, y: p.lat }));

  let x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  let y = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  for (let i = 0; i < maxIter; i++) {
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    let onVertex: { x: number; y: number } | null = null;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 1e-12) {
        onVertex = p;
        break;
      }
      wx += p.x / d;
      wy += p.y / d;
      wsum += 1 / d;
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
