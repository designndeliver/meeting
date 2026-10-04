import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { AppError } from '../../lib/errors';
import { errorResponse, guard, json, readJson } from '../../lib/http';
import { geocode } from '../../lib/ors';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    guard(request, clientAddress);
    const body = await readJson(request);
    const q = typeof body.q === 'string' ? body.q.trim() : '';
    if (q.length < 3 || q.length > 200) throw new AppError('bad_request', 'Enter a street address or place name.');
    const n = body.near as { lat?: unknown; lon?: unknown } | undefined;
    const lat = Number(n?.lat);
    const lon = Number(n?.lon);
    const near = n && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
    return json(await geocode(q, env.ORS_API_KEY, fetch, near));
  } catch (e) {
    return errorResponse(e);
  }
};
