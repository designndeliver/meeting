/**
 * Cloudflare Cache API wrapper. Keys are synthetic URLs and never contain addresses.
 * Falls back to a plain call where the Cache API is unavailable (dev, tests).
 */
export async function cachedJson<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const req = new Request(`https://cache.meeting.internal/${key}`);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return (await hit.json()) as T;
    } catch {
      /* ignore cache errors */
    }
  }
  const value = await produce();
  if (cache) {
    try {
      await cache.put(
        req,
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` },
        }),
      );
    } catch {
      /* ignore cache errors */
    }
  }
  return value;
}
