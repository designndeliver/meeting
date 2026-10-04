# Build and deploy: meeting.vinaygoel.com ("Meeting Point")

Paste this whole file into a new Claude Code session (run from an empty folder or a fresh clone of the new repo) and say: "Follow BUILD_MEETING_APP.md end to end."

## 1. What we are building

A small web app. The user enters **2 or 3 addresses** (design for N, UI allows up to 10 later) and gets back a **point of interest (POI) that is approximately equidistant from everyone**: a cafe, restaurant, park, library, etc. The fairness measure can be **travel time** or **distance**; the user picks. Travel mode: driving (default), walking, cycling.

Phase 1 (ship this): 2 or 3 addresses, time or distance, driving, top 5 POIs on a map with per-person numbers.
Phase 2 (design for it now, build after): more than 3 addresses, walking/cycling, POI category filter, shareable link.

Owner: Vinay Goel (vinaygoel.com). Wants **free hosting and free APIs**, a clean mobile-friendly UI, and the least possible manual work for him.

## 2. Decisions already made (do not re-ask)

- Own private GitHub repo named `meeting` under the `designndeliver` account (Vinay's other sites each have their own repo).
- Hosted on **Cloudflare Workers with static assets** (same as the vinaygoel.com repo, `wrangler deploy`). Domain `meeting.vinaygoel.com` is a **Workers custom domain**; vinaygoel.com's DNS is already on Cloudflare, so the DNS record is created automatically.
- Stack: **Astro (static) + a small Worker API route**, TypeScript, **Leaflet + OpenStreetMap tiles** for the map. No paid services, no credit card.
- API keys never ship to the browser. The browser calls `/api/*` on our own Worker; the Worker calls third parties.

## 3. Free data providers

| Need | Provider | Notes |
|---|---|---|
| Geocoding (address to lat/lng) | OpenRouteService geocode (Pelias), fallback Photon (`photon.komoot.io`) | Do not hit public Nominatim from a deployed app (usage policy forbids heavy or bulk use). |
| Travel time / distance matrix | OpenRouteService Matrix API (`/v2/matrix/{profile}`) | Free key, daily quota (check current limits at openrouteservice.org/dev). Supports `duration` and `distance` metrics. |
| POI candidates | OpenStreetMap via Overpass API | Query amenities in a bounding area around the midpoint. Set a descriptive User-Agent, cache results. |
| Map tiles | OpenStreetMap standard tiles | Keep the attribution. Light usage only. |

Verify the current free-tier limits and endpoints from the providers' own docs before coding; they change. Add simple caching (Cloudflare Cache API or KV, free tier) for geocode and Overpass responses to stay inside quotas. Add basic per-IP rate limiting in the Worker.

## 4. Algorithm

1. Geocode each address. If a result is ambiguous, return the top 3 and let the user choose.
2. **Seed point**: the geometric median of the origins (Weiszfeld iteration), not the plain average. Search radius = max(1.5 km, 0.6 x the largest origin-to-seed distance), capped at ~15 km.
3. Fetch candidate POIs inside that radius from Overpass (default categories: cafe, restaurant, fast_food, library, park). Keep the 40 candidates nearest the seed, require a name.
4. Call the ORS matrix once: origins = addresses, destinations = candidates, metric = user's choice (`duration` or `distance`).
5. Score each candidate:
   - primary: **minimize the maximum** value across people (minimax, which is what "fair" means here)
   - tie-break: minimize the spread (max minus min), then the sum
6. Return the top 5 with each person's time and distance, plus an `equidistance` label ("within 3 min of each other").
7. If the best candidate is much worse than the seed suggests (spread over 30% of max), widen the radius once and retry.

Put the scoring in a pure, unit-tested module (`src/lib/score.ts`) with no network calls. Required tests: symmetric inputs give equal scores, N=2 and N=3 and N=6 work, missing matrix cells (unreachable) are excluded, ties break correctly.

## 5. UI requirements

- Single page. Address inputs (2 by default, "Add address" up to the phase limit), a Time/Distance toggle, a Find button.
- Address autocomplete is optional in phase 1; a plain input with "did you mean" disambiguation is fine.
- Results: ranked list plus a Leaflet map showing origins, the top POI highlighted, and lines from each origin. Each row shows per-person time and distance and the fairness spread.
- Clear empty, loading, and error states (geocode failed, no POIs found, quota exceeded).
- Mobile first, accessible (labels, focus states, keyboard usable), light and dark friendly.
- Footer link back to https://vinaygoel.com. Page title "Meeting Point".
- Privacy: do not store addresses server-side. No analytics that capture addresses. State this in one line in the UI.

## 6. Repo setup

1. `gh repo create designndeliver/meeting --private --clone` (if `gh` is not authenticated, stop and ask Vinay to run `gh auth login`).
2. Scaffold: `npm create astro@latest` (minimal, TypeScript strict) then add `@astrojs/cloudflare`, `leaflet`, `vitest`. Node 22+.
3. Layout: `src/pages/index.astro`, `src/pages/api/geocode.ts`, `src/pages/api/meet.ts`, `src/lib/{geo,score,overpass,ors}.ts`, `tests/`.
4. `wrangler.jsonc`:

```jsonc
{
  "name": "meeting",
  "compatibility_date": "2025-10-08",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./dist/_worker.js/index.js",
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  "routes": [{ "pattern": "meeting.vinaygoel.com", "custom_domain": true }],
  "observability": { "enabled": true }
}
```

5. Scripts: `dev`, `build`, `test`, `check` (`astro build && tsc --noEmit && vitest run && wrangler deploy --dry-run`), `deploy` (`wrangler deploy`).
6. `.dev.vars` (gitignored) holds `ORS_API_KEY=...` for local work. Add `.dev.vars.example` with a placeholder. Never commit a real key.
7. Write a short README: what it is, how to run locally, how to deploy.

## 7. Steps only Vinay can do (ask once, up front, then continue)

1. Create a free OpenRouteService account at openrouteservice.org and copy the API token.
2. Authenticate Wrangler: `npx wrangler login` (opens a browser, uses the Cloudflare account that owns vinaygoel.com).
3. When Claude Code asks, run `npx wrangler secret put ORS_API_KEY` and paste the token. Claude Code must not echo or log it.

If Claude Code is running somewhere with no browser, use a scoped Cloudflare API token instead (Workers Scripts: Edit, Zone DNS: Edit for vinaygoel.com) exported as `CLOUDFLARE_API_TOKEN`.

## 8. Build order

1. Scaffold the repo and confirm `npm run dev` serves a blank page.
2. Implement and test `geo.ts` and `score.ts` (pure code, tests first).
3. Implement the `/api/geocode` and `/api/meet` routes with the ORS and Overpass clients, caching, and rate limiting. Use recorded fixture responses in tests, not live calls.
4. Build the UI and map.
5. Run `npm run check`. Fix everything before deploying.
6. Manual test with three real Houston-area addresses (for example Katy, Cypress, and The Woodlands): confirm the results are sensible and the spread is small.

## 9. Deploy

1. `npx wrangler secret put ORS_API_KEY`
2. `npm run deploy`. The `routes` entry attaches `meeting.vinaygoel.com` and Cloudflare creates the DNS record and certificate (can take a few minutes).
3. Verify: `curl -I https://meeting.vinaygoel.com` returns 200, the page loads, and a real search works end to end.
4. Optional auto-deploy: in the Cloudflare dashboard, Workers & Pages, the `meeting` Worker, Settings, Builds, connect the GitHub repo (build command `npm run build`, deploy command `npx wrangler deploy`). Pushes to `main` then deploy automatically.
5. Commit and push to `main`. Report the live URL.

## 10. Hub site

The vinaygoel.com repo already has the tile (`src/data/apps.ts`, entry "Meeting Point" linking to https://meeting.vinaygoel.com). **Merge that change only after step 9 is verified**, so the tile never points at a dead page. Future apps are added as one more entry in the same file.

## 11. Definition of done

- https://meeting.vinaygoel.com loads over HTTPS and returns sensible results for 2 and 3 real addresses, by time and by distance.
- `npm run check` passes; scoring unit tests pass.
- No API key in git history or in client-side code.
- README present; repo private; tile live on vinaygoel.com.
