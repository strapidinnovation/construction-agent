import type { Listing } from "./agents/landSearch.ts";

export const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;

export function listingDetails(l: Listing): string {
  return `${usd(l.priceUsd)} | ${l.acres ? `${l.acres} acres` : "size n/a"}`;
}

export function noListingsText(city: string, lo: number, hi: number): string {
  return `No land listings found in ${city} between ${usd(lo)} and ${usd(hi)}. Try a wider budget or a nearby city.`;
}
