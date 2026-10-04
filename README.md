# Meeting Point

meeting.vinaygoel.com: enter 2 or 3 addresses and get cafes, restaurants, parks and libraries that are about equally far (by travel time or distance) for everyone.

Astro (static) + a small Cloudflare Worker API, Leaflet + OpenStreetMap. No paid services.

## How it works
1. `/api/geocode` turns an address into coordinates (OpenRouteService Pelias, falling back to Photon).
2. `/api/meet` finds the geometric median of the origins, pulls nearby named POIs from Overpass, gets a driving matrix from OpenRouteService, and ranks by minimax (worst-off person), then spread, then total.
3. Scoring lives in `src/lib/score.ts` and `src/lib/geo.ts` (pure, unit-tested). `src/lib/meet.ts` orchestrates with injected dependencies, so tests use fixtures, never live calls.

Both endpoints are POST so addresses never appear in URLs or request logs. Nothing is stored; only Overpass results are cached, keyed by a coarse grid of the search centre.

## Run locally
```bash
npm install
cp .dev.vars.example .dev.vars   # put your OpenRouteService token in it
npm run dev
```
Without a key, geocoding still works (Photon) but routing returns a "not configured" error.

## Checks
```bash
npm run check   # astro build, tsc, vitest, wrangler deploy --dry-run
```

## Deploy
```bash
npx wrangler login
npx wrangler secret put ORS_API_KEY
npm run deploy
```
`wrangler.jsonc` attaches the custom domain `meeting.vinaygoel.com`; Cloudflare creates the DNS record and certificate.
Optional auto-deploy: Workers & Pages, the `meeting` Worker, Settings, Builds, connect the repo (build `npm run build`, deploy `npx wrangler deploy`).

## Notes
- Rate limiting is best-effort in memory per Worker isolate. For a hard limit add a Cloudflare rate-limiting rule on `/api/*`.
- Free-tier quotas (ORS matrix and geocode per day, Overpass fair use) change; check openrouteservice.org/dev. A 429 from ORS is shown to the user as a quota message.
- Public Overpass can take 10-15 s at busy times; the client has timeouts and a mirror fallback.
