import { AppError } from './errors';
import { geometricMedian, searchRadiusKm, widenRadiusKm, MAX_RADIUS_KM, type LatLon } from './geo';
import type { MatrixResult, Mode } from './ors';
import type { Poi } from './overpass';
import { compareScored, equidistanceLabel, scoreCandidates, shouldWiden, type Metric, type Scored } from './score';

export interface MeetInput {
  origins: LatLon[];
  metric: Metric;
  mode: Mode;
}

export interface MeetDeps {
  pois(seed: LatLon, radiusKm: number): Promise<Poi[]>;
  matrix(mode: Mode, origins: LatLon[], dests: LatLon[]): Promise<MatrixResult>;
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
  widened: boolean;
  metric: Metric;
  mode: Mode;
  results: MeetResult[];
}

interface Attempt {
  pois: Poi[];
  matrix: MatrixResult;
  scored: Scored[];
  radiusKm: number;
}

async function attempt(input: MeetInput, seed: LatLon, radiusKm: number, deps: MeetDeps): Promise<Attempt | null> {
  const pois = await deps.pois(seed, radiusKm);
  if (pois.length === 0) return null;
  const matrix = await deps.matrix(input.mode, input.origins, pois);
  const values = input.metric === 'duration' ? matrix.durations : matrix.distances;
  return { pois, matrix, scored: scoreCandidates(values, 5), radiusKm };
}

export async function findMeetingPoints(input: MeetInput, deps: MeetDeps): Promise<MeetOutput> {
  const seed = geometricMedian(input.origins);
  const r1 = searchRadiusKm(input.origins, seed);

  let best = await attempt(input, seed, r1, deps);
  let widened = false;

  if (shouldWiden(best?.scored[0]) && r1 < MAX_RADIUS_KM) {
    const second = await attempt(input, seed, widenRadiusKm(r1), deps);
    if (second && second.scored.length) {
      if (!best || !best.scored.length || compareScored(second.scored[0], best.scored[0]) < 0) {
        best = second;
        widened = true;
      }
    }
  }

  if (!best || best.scored.length === 0) {
    throw new AppError('no_pois', 'No reachable cafes, restaurants, parks or libraries found near the middle. Try different addresses.');
  }

  const { pois, matrix, scored, radiusKm } = best;
  const results: MeetResult[] = scored.map((s) => ({
    poi: pois[s.index],
    legs: input.origins.map((_, p) => ({
      duration: matrix.durations[p][s.index] as number,
      distance: matrix.distances[p][s.index] as number,
    })),
    max: s.max,
    spread: s.spread,
    equidistance: equidistanceLabel(s.spread, input.metric),
  }));

  return { seed, radiusKm, widened, metric: input.metric, mode: input.mode, results };
}
