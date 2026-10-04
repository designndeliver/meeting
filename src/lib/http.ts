import { AppError } from './errors';
import { rateLimit } from './ratelimit';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
  // Deliberately log nothing from the request: addresses must not reach logs.
  return json({ error: { code: 'upstream', message: 'Something went wrong. Please try again.' } }, 500);
}

export function guard(request: Request, clientAddress: string | undefined) {
  const ip = request.headers.get('CF-Connecting-IP') ?? clientAddress ?? 'unknown';
  if (!rateLimit(ip)) throw new AppError('rate_limited', 'Too many requests. Wait a minute and try again.');
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > 20_000) throw new AppError('bad_request', 'Request too large.');
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new AppError('bad_request', 'Invalid request.');
}
