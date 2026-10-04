import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { cachedJson } from '../../lib/cache';
import { parseCategories } from '../../lib/categories';
import { AppError } from '../../lib/errors';
import { errorResponse, guard, json, readJson } from '../../lib/http';
import type { LatLon } from '../../lib/geo';
import { findMeetingPoints } from '../../lib/meet';
import { matrix, type Mode } from '../../lib/ors';
import { buildQuery, fetchOverpass, parseOverpass } from '../../lib/overpass';
import { reverseAddress } from '../../lib/reverse';

export const prerender = false;

const MAX_ORIGINS = 10;
const MODES: Mode[] = ['driving', 'walking', 'cycling'];

function parseOrigins(v: unknown): LatLon[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_ORIGINS) {
    throw new AppError('bad_request', `Provide between 2 and ${MAX_ORIGINS} locations.`);
  }
  return v.map((o) => {
    const lat = Number((o as LatLon)?.lat);
    const lon = Number((o as LatLon)?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new AppError('bad_request', 'Invalid location.');
    }
    return { lat, lon };
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    guard(request, clientAddress);
    const body = await readJson(request);
    const origins = parseOrigins(body.origins);
    const metric = body.metric === 'distance' ? 'distance' : 'duration';
    const mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'driving';

    const categories = parseCategories(body.categories);

    const out = await findMeetingPoints(
      { origins, metric, mode },
      {
        // Cache key uses a coarse (~100 m) grid of the seed, never the addresses.
        pois: (seed, radiusKm) =>
          cachedJson(
            `poi-v4/${seed.lat.toFixed(3)}/${seed.lon.toFixed(3)}/${Math.round(radiusKm * 10)}/${categories.join('+')}`,
            6 * 3600,
            async () => parseOverpass(await fetchOverpass(buildQuery(seed, radiusKm * 1000, categories)), seed),
          ),
        matrix: (m, o, d) => matrix(m, o, d, env.ORS_API_KEY),
      },
    );

    // Most OSM places (gas stations especially) carry no address: look up the street for the few we return.
    await Promise.all(
      out.results.map(async ({ poi }) => {
        if (poi.address) return;
        try {
          const found = await cachedJson<string | null>(
            `rev-v1/${poi.lat.toFixed(4)}/${poi.lon.toFixed(4)}/${encodeURIComponent(poi.name.toLowerCase())}`,
            7 * 24 * 3600,
            () => reverseAddress(poi.name, poi),
          );
          if (found) poi.address = found;
        } catch {
          /* the address is a nicety; never fail a search over it */
        }
      }),
    );
    return json(out);
  } catch (e) {
    return errorResponse(e);
  }
};
