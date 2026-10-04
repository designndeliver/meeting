import { AppError } from './errors';
import { geometricMedian, haversineKm, searchRadiusKm, spreadSelect, widenRadiusKm, type LatLon } from './geo';
import type { MatrixResult, Mode } from './ors';
import type { Poi } from './overpass';
import { equidistanceLabel, scoreCandidates, shouldWiden, type Metric } from './score';

export interface MeetInput {
  origins: LatLon[];
  metric: Metric;
  mode: Mode;
}

export interface MeetDeps {
  pois(seed: LatLon, radiusKm: number): Promise<Poi[]>;
  matrix(mode: Mode, origins: LatLon[], dests: Poi[]): Promise<MatrixResult>;
}

export interface PersonLeg {
  /** seconds */
  duration: number;
  /** metres */
  distance: number;
}

export interface MeetResult {
  poi: Poi;
  legs: PersonLeg[];
  /** worst-off person's value in the chosen metric */
  max: number;
  /** max minus min in the chosen metric */
  spread: number;
  equidistance: string;
}

export interface MeetOutput {
  seed: LatLon;
  radiusKm: number;
  /** true when a second, finer pass around the first pick was needed */
  refined: boolean;
  metric: Metric;
  mode: Mode;
  results: MeetResult[];
}

const MAX_CANDIDATES = 40;

interface Evaluated {
  poi: Poi;
  legs: PersonLeg[];
}

/**
 * Coarse-to-fine search over one pool of places:
 * 1. score candidates spread across the whole search area;
 * 2. if the best is lopsided, score the unevaluated places nearest that best and re-rank everything.
 * Two matrix calls at most, one place lookup (plus one widened lookup if the first finds nothing usable).
 */
export async function findMeetingPoints(input: MeetInput, deps: MeetDeps): Promise<MeetOutput> {
  const { origins, metric, mode } = input;
  const seed = geometricMedian(origins);
  let radiusKm = searchRadiusKm(origins, seed);

  const evaluated: Evaluated[] = [];
  const seen = new Set<string>();

  async function evaluate(batch: Poi[]) {
    const fresh = batch.filter((p) => !seen.has(p.id));
    if (fresh.length === 0) return;
    const m = await deps.matrix(mode, origins, fresh);
    fresh.forEach((poi, j) => {
      seen.add(poi.id);
      const legs = origins.map((_, p) => ({ duration: m.durations[p]?.[j] as number, distance: m.distances[p]?.[j] as number }));
      evaluated.push({ poi, legs });
    });
  }

  const rank = () =>
    scoreCandidates(
      origins.map((_, p) => evaluated.map((e) => e.legs[p][metric === 'duration' ? 'duration' : 'distance'])),
      5,
    );

  let pool = await deps.pois(seed, radiusKm);
  if (pool.length) await evaluate(spreadSelect(pool, seed, MAX_CANDIDATES));

  if (rank().length === 0) {
    // Nothing found or nothing reachable: widen the area once and start over.
    const wider = widenRadiusKm(radiusKm);
    if (wider > radiusKm) {
      radiusKm = wider;
      pool = await deps.pois(seed, radiusKm);
      if (pool.length) await evaluate(spreadSelect(pool, seed, MAX_CANDIDATES));
    }
  }

  let refined = false;
  const first = rank()[0];
  if (first && shouldWiden(first)) {
    const centre = evaluated[first.index].poi;
    const near = pool
      .filter((p) => !seen.has(p.id))
      .map((p) => ({ p, d: haversineKm(p, centre) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.p);
    if (near.length) {
      await evaluate(near);
      refined = true;
    }
  }

  const top = rank();
  if (top.length === 0) {
    throw new AppError('no_pois', 'No reachable cafes, restaurants, parks or libraries found near the middle. Try different addresses.');
  }

  const results: MeetResult[] = top.map((s) => ({
    poi: evaluated[s.index].poi,
    legs: evaluated[s.index].legs,
    max: s.max,
    spread: s.spread,
    equidistance: equidistanceLabel(s.spread, metric),
  }));

  return { seed, radiusKm, refined, metric, mode, results };
}
