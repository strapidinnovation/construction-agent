import type { Listing } from "./landSearch.ts";

const AUSTIN_ZONING_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Current_Zoning_gdb/FeatureServer/0/query";

/** Residential project types the site rules say yes or no to. */
export const HOUSING_TYPES = [
  "single-family",
  "adu",
  "duplex",
  "triplex-fourplex",
  "townhouse",
  "small-lot-subdivision",
  "multifamily",
  "manufactured-home",
] as const;
export type HousingType = (typeof HOUSING_TYPES)[number];

export const HOUSING_TYPE_LABEL: Record<HousingType, string> = {
  "single-family": "Single-family home",
  adu: "House with accessory dwelling unit",
  duplex: "Duplex",
  "triplex-fourplex": "Triplex / fourplex",
  townhouse: "Townhouses",
  "small-lot-subdivision": "Small-lot subdivision",
  multifamily: "Multifamily",
  "manufactured-home": "Manufactured home",
};

export type HousingTypeRule = {
  type: HousingType;
  allowed: "yes" | "conditional" | "no" | "unknown";
  /** Dwelling units this type allows on one lot, when the rules say. */
  maxUnits: number | null;
  conditions: string;
};

/** A researched rule with where it was found. */
export type Citation = { rule: string; value: string; url: string; quote: string };

/** Everything the site-rules research found beyond the core numbers (see siteRules.ts). */
export type SiteResearch = {
  model: string;
  researchedAt: string;
  /** How the district was determined (the city's zoning map, or the web). */
  districtBasis: string;
  housingTypes: HousingTypeRule[];
  overlays: { name: string; effect: string }[];
  designStandards: string[];
  permits: string[];
  stateLaws: string[];
  citations: Citation[];
  confidence: "high" | "medium" | "low";
  warnings: string[];
  /** Rules the research couldn't confirm, and the default used instead. */
  assumed: string[];
};

/**
 * The rules the site planner and designer work to. The core numbers are
 * always filled in (with defaults where research found nothing); the
 * optional ones and `research` exist for researched rules only, so plans
 * saved before research existed still load.
 */
export type ZoningRules = {
  jurisdiction: string;
  district: string;
  districtName: string;
  frontFt: number;
  streetSideFt: number;
  interiorSideFt: number;
  rearFt: number;
  maxBuildingCoverage: number | null;
  maxImperviousCover: number | null;
  maxHeightFt: number;
  maxUnits: number | null;
  minLotSqft: number;
  minSubdivisionLotSqft: number;
  minLotWidthFt?: number | null;
  maxStories?: number | null;
  /** Floor area ratio: total floor area / lot area. */
  maxFar?: number | null;
  parkingPerUnit?: number | null;
  source: string;
  notes: string[];
  verified: boolean;
  research?: SiteResearch;
};

/** A zoning district read from a city's official zoning map. */
export type MappedDistrict = { district: string; jurisdiction: string; source: string };

async function austinDistrictAt(lat: number, lon: number): Promise<string | null> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "BASE_ZONE",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${AUSTIN_ZONING_URL}?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { features?: { attributes: { BASE_ZONE?: string } }[] };
  return data.features?.[0]?.attributes.BASE_ZONE ?? null;
}

/**
 * The lot's zoning district from an official zoning map, or null where we
 * have no map (only the City of Austin today). Web search can't reliably tell
 * which district one parcel is in, so a map answer is passed to the research
 * as a known fact.
 */
export async function mappedDistrict(listing: Listing): Promise<MappedDistrict | null> {
  if (listing.state !== "TX" || listing.latitude === null || listing.longitude === null)
    return null;
  try {
    const district = await austinDistrictAt(listing.latitude, listing.longitude);
    return district
      ? { district, jurisdiction: "City of Austin, TX", source: "City of Austin zoning map" }
      : null;
  } catch {
    return null;
  }
}

export const DEFAULT_RULES = {
  frontFt: 25,
  sideFt: 5,
  rearFt: 10,
  maxCoveragePct: 40,
  maxHeightFt: 35,
  maxUnits: 1,
  minLotSqft: 5000,
};

export function userRules(input: {
  frontFt: number;
  sideFt: number;
  rearFt: number;
  maxCoveragePct: number;
  maxHeightFt: number;
  maxUnits: number;
  minLotSqft: number;
}): ZoningRules {
  return {
    jurisdiction: "Unknown (rules entered by user)",
    district: "user-entered",
    districtName: "User-entered rules",
    frontFt: input.frontFt,
    streetSideFt: input.sideFt,
    interiorSideFt: input.sideFt,
    rearFt: input.rearFt,
    maxBuildingCoverage: input.maxCoveragePct / 100,
    maxImperviousCover: null,
    maxHeightFt: input.maxHeightFt,
    maxUnits: input.maxUnits,
    minLotSqft: input.minLotSqft,
    minSubdivisionLotSqft: input.minLotSqft,
    source: "Entered at the prompt; not verified against local code",
    notes: ["Check county, HOA/deed restrictions, septic and well rules before building."],
    verified: false,
  };
}
