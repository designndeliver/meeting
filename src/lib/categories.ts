/** Place types the user can choose to meet at. Shared by the Worker (queries) and the page (labels). */
export interface Category {
  key: string;
  label: string;
  /** OpenStreetMap tag and the values that count as this category */
  tag: 'amenity' | 'leisure' | 'shop';
  values: string[];
}

export const CATEGORIES: Category[] = [
  { key: 'cafe', label: 'Cafe', tag: 'amenity', values: ['cafe'] },
  { key: 'restaurant', label: 'Restaurant', tag: 'amenity', values: ['restaurant'] },
  { key: 'fast_food', label: 'Fast food', tag: 'amenity', values: ['fast_food'] },
  { key: 'bar', label: 'Bar / pub', tag: 'amenity', values: ['bar', 'pub', 'biergarten'] },
  { key: 'gas_station', label: 'Gas station', tag: 'amenity', values: ['fuel'] },
  { key: 'library', label: 'Library', tag: 'amenity', values: ['library'] },
  { key: 'park', label: 'Park', tag: 'leisure', values: ['park'] },
  { key: 'mall', label: 'Shopping mall', tag: 'shop', values: ['mall'] },
  { key: 'cinema', label: 'Movie theater', tag: 'amenity', values: ['cinema'] },
];

export const DEFAULT_CATEGORIES = ['cafe', 'restaurant', 'fast_food', 'library', 'park'];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

/** Keep only known keys, de-duplicated, in catalogue order; fall back to the defaults when none are valid. */
export function parseCategories(input: unknown): string[] {
  if (!Array.isArray(input)) return DEFAULT_CATEGORIES;
  const wanted = new Set(input.filter((x): x is string => typeof x === 'string'));
  const valid = CATEGORIES.filter((c) => wanted.has(c.key)).map((c) => c.key);
  return valid.length ? valid : DEFAULT_CATEGORIES;
}

/** Which category an OpenStreetMap element belongs to, from its tags. */
export function categoryOf(tags: Record<string, string | undefined> | undefined): string {
  if (!tags) return 'place';
  for (const c of CATEGORIES) {
    const v = tags[c.tag];
    if (v && c.values.includes(v)) return c.key;
  }
  return 'place';
}
