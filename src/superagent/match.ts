/**
 * Fuzzy name matching, shared by:
 *   - listings ("design a house on Corral Lane" -> "8435 Corral Ln, Austin, TX"),
 *   - construction projects ("the River Bend job" -> "River Bend Townhomes").
 *
 * This is plain code, not the AI model, so the same words always pick the
 * same thing and nothing is made up. The model only copies the words the user
 * wrote; this file decides what they refer to.
 *
 * How two names are compared:
 *   1. Both are cut into lowercase words, punctuation removed.
 *   2. Street words are shortened the way listings write them ("Lane" -> "ln",
 *      "Trail" -> "trl"), so "Corral Lane" and "Corral Ln" are the same words.
 *   3. Filler words ("the", "lot", "project", ...) are dropped.
 *   4. Score: 1 for an exact match; otherwise the share of the shorter side's
 *      words found in the other side (so "river bend" fully matches "river bnd
 *      townhomes"). House numbers matter: "8446" picks 8446 Corral Ln and rules
 *      out 8435 Corral Ln.
 */

/** Long street words -> the short form used in listing addresses. */
const ABBREVIATIONS: Record<string, string> = {
  lane: "ln",
  trail: "trl",
  road: "rd",
  street: "st",
  avenue: "ave",
  drive: "dr",
  bend: "bnd",
  plaza: "plz",
  court: "ct",
  circle: "cir",
  boulevard: "blvd",
  place: "pl",
  parkway: "pkwy",
  cove: "cv",
  highway: "hwy",
  terrace: "ter",
  hollow: "holw",
  crossing: "xing",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};

/** Words that never help tell two names apart. */
const FILLER = new Set(["the", "a", "an", "at", "on", "in", "of", "for", "to", "please", "one"]);

/** Cut a name into comparable words (see the steps above). */
export function words(text: string, extraFiller: string[] = []): string[] {
  const extra = new Set(extraFiller);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !FILLER.has(w) && !extra.has(w));
}

const isNumber = (w: string) => /^\d+$/.test(w);

/** How well the query words match a name's words, from 0 (not at all) to 1 (exact). */
export function similarity(query: string[], name: string[]): number {
  if (!query.length || !name.length) return 0;
  if (query.join(" ") === name.join(" ")) return 1;

  // House numbers: if both sides have numbers and none agree, it's a different
  // property (8446 Corral Ln is not 8435 Corral Ln), however similar the rest.
  const qNums = query.filter(isNumber);
  const nNums = name.filter(isNumber);
  if (qNums.length && nNums.length && !qNums.some((n) => nNums.includes(n))) return 0;
  const numberHit = qNums.some((n) => nNums.includes(n));

  const qWords = query.filter((w) => !isNumber(w));
  const nWords = name.filter((w) => !isNumber(w));
  if (!qWords.length) return numberHit ? 0.95 : 0; // just "8446"
  if (!nWords.length) return 0;

  const [short, long] = qWords.length <= nWords.length ? [qWords, nWords] : [nWords, qWords];
  const share = short.filter((w) => long.includes(w)).length / short.length;
  return Math.min(0.99, share * 0.9 + (numberHit ? 0.09 : 0));
}

export type MatchResult<T> =
  { kind: "found"; item: T } | { kind: "ambiguous"; items: T[] } | { kind: "none" };

/**
 * Pick the item whose names best match `query`.
 * - `namesOf` gives each item's names (e.g. a project's name and nicknames).
 * - Items scoring under `minScore` don't count.
 * - If several items tie for the best score, the answer is "ambiguous" and
 *   the caller should ask which one was meant.
 */
export function bestMatch<T>(
  query: string,
  items: T[],
  namesOf: (item: T) => string[],
  { extraFiller = [] as string[], minScore = 0.5 } = {},
): MatchResult<T> {
  const q = words(query, extraFiller);
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(0, ...namesOf(item).map((n) => similarity(q, words(n, extraFiller)))),
    }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return { kind: "none" };
  const tied = scored.filter((x) => x.score === best.score);
  return tied.length > 1
    ? { kind: "ambiguous", items: tied.map((x) => x.item) }
    : { kind: "found", item: best.item };
}
