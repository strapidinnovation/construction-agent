/**
 * Skill: land search.
 *
 * A "skill" is one job SuperAgent knows how to do. Skills do not know anything
 * about Slack: they take plain values and return plain results, so the same
 * code could also be used by a future web app.
 *
 * This skill wraps the existing land search agent (src/agents/landSearch.ts),
 * which calls the Python "homeharvest" scraper for Realtor.com land listings.
 */
import * as landSearch from "../../agents/landSearch.ts";
import { parseBudget } from "../../budget.ts";

export type SearchResult =
  | { ok: true; city: string; lo: number; hi: number; listings: landSearch.Listing[] }
  | { ok: false; reason: "missing-city" | "missing-budget" | "bad-budget"; budget?: string };

/**
 * Search for land in `city` within `budget`.
 *
 * `budget` is the text form produced by the router ("300k", "200k-350k",
 * "under 400k"). parseBudget turns it into a price range; "300k" means "around
 * 300k" and becomes roughly $255k to $345k.
 */
export async function searchLand(city: string, budget: string): Promise<SearchResult> {
  if (!city) return { ok: false, reason: "missing-city" };
  if (!budget) return { ok: false, reason: "missing-budget" };

  let lo: number, hi: number;
  try {
    [lo, hi] = parseBudget(budget);
  } catch {
    return { ok: false, reason: "bad-budget", budget };
  }

  // Listings come back sorted from cheapest to most expensive.
  const listings = await landSearch.run(city, lo, hi);
  return { ok: true, city, lo, hi, listings };
}
