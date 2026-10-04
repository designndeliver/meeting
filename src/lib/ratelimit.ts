/**
 * Best-effort per-IP limiter, in memory per Worker isolate. No storage, no KV.
 * It blunts casual abuse; for a hard limit add a Cloudflare rate-limiting rule on /api/*.
 */
const hits = new Map<string, number[]>();

export function rateLimit(ip: string, limit = 20, windowMs = 60_000, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  }
  return true;
}
