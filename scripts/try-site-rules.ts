/**
 * Try the site rules research on one lot and print what it found.
 *   node --env-file-if-exists=.env --import tsx scripts/try-site-rules.ts <listing.json>
 *   node --env-file-if-exists=.env --import tsx scripts/try-site-rules.ts "12 Oak St, Springfield, IL 62701"
 */
import { existsSync, readFileSync } from "node:fs";
import type { Listing } from "../src/agents/landSearch.ts";
import { researchSiteRules } from "../src/agents/siteRules.ts";

const arg = process.argv[2] ?? "";
let listing: Listing;
if (existsSync(arg)) {
  const data = JSON.parse(readFileSync(arg, "utf8")) as { listing?: Listing } & Listing;
  listing = data.listing ?? data;
} else {
  const parts = arg.split(",").map((p) => p.trim());
  const [state, zip] = (parts.at(-1) ?? "").split(/\s+/);
  listing = {
    address: arg,
    city: parts.at(-2) ?? null,
    state: state ?? null,
    zipCode: zip ?? null,
    county: null,
    latitude: null,
    longitude: null,
    priceUsd: 0,
    lotSqft: null,
    acres: null,
    url: `address:${arg}`,
  };
}

const started = Date.now();
const result = await researchSiteRules(listing);
console.log(JSON.stringify(result, null, 2));
console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
