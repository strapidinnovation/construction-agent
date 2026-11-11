/**
 * Finding saved house plans by property.
 *
 * Every finished design is a folder in output/ (e.g.
 * output/2026-11-11_10-34-33_12610-river-bnd-austin-tx-78732) containing
 * inputs.json, which records the listing the plan was made for, and plan.svg,
 * the drawing. This file answers "which plan belongs to 3218 Brass Buttons
 * Trl?", so an estimate or timeline works on the property the user named
 * rather than on whatever was designed last.
 *
 * If a property was designed more than once, the newest plan wins (folder
 * names start with the date and time, so sorting them sorts by age).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Listing } from "../agents/landSearch.ts";
import { PROJECT_ROOT } from "../paths.ts";
import { bestMatch, type MatchResult } from "./match.ts";

const OUTPUT = join(PROJECT_ROOT, "output");

export type SavedPlan = { dir: string; listing: Listing };

/** The street part of an address: "8435 Corral Ln, Austin, TX, 78745" -> "8435 Corral Ln". */
export function streetOf(address: string): string {
  return address.split(",")[0]!.trim();
}

/** The listing a plan folder was made for, from its inputs.json (null if it isn't a finished plan). */
export function listingOfPlan(dir: string): Listing | null {
  const inputs = join(dir, "inputs.json");
  if (!existsSync(inputs) || !existsSync(join(dir, "plan.svg"))) return null;
  try {
    return (JSON.parse(readFileSync(inputs, "utf8")) as { listing: Listing }).listing;
  } catch {
    return null;
  }
}

/** The newest finished plan for each property, newest first. */
export function savedPlans(): SavedPlan[] {
  if (!existsSync(OUTPUT)) return [];
  const seen = new Set<string>();
  const plans: SavedPlan[] = [];
  for (const name of readdirSync(OUTPUT).sort().reverse()) {
    const dir = join(OUTPUT, name);
    const listing = listingOfPlan(dir);
    if (!listing || seen.has(listing.url)) continue;
    seen.add(listing.url);
    plans.push({ dir, listing });
  }
  return plans;
}

/** The newest finished plan for the property with this listing URL. */
export function planForListing(url: string): SavedPlan | undefined {
  return savedPlans().find((p) => p.listing.url === url);
}

/** Find a plan by the property's name ("Brass Buttons Trail", "3218"), using the shared matcher. */
export function findPlanByName(name: string): MatchResult<SavedPlan> {
  return bestMatch(name, savedPlans(), (p) => [streetOf(p.listing.address)], {
    extraFiller: ["lot", "property", "land", "house", "home", "parcel", "listing", "plot", "plan"],
  });
}
