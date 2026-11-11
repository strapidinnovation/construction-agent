import { readFile } from "node:fs/promises";
import { PROJECT_ROOT } from "../paths.ts";
import type { Listing } from "./landSearch.ts";

const AUSTIN_ZONING_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Current_Zoning_gdb/FeatureServer/0/query";

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
  source: string;
  notes: string[];
  verified: boolean;
};

type DistrictRules = Omit<
  ZoningRules,
  "jurisdiction" | "district" | "districtName" | "source" | "notes" | "verified"
> & { name: string };

type RulesFile = {
  jurisdiction: string;
  source: string;
  notes: string[];
  districts: Record<string, DistrictRules>;
};

export type ZoningLookup =
  | { kind: "found"; rules: ZoningRules }
  | { kind: "unsupported-district"; district: string; jurisdiction: string }
  | { kind: "unknown" };

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

export async function lookupZoning(listing: Listing): Promise<ZoningLookup> {
  if (listing.state !== "TX" || listing.latitude === null || listing.longitude === null) {
    return { kind: "unknown" };
  }

  let district: string | null;
  try {
    district = await austinDistrictAt(listing.latitude, listing.longitude);
  } catch {
    return { kind: "unknown" };
  }
  if (!district) return { kind: "unknown" };

  const file = JSON.parse(
    await readFile(`${PROJECT_ROOT}data/zoning/austin-tx.json`, "utf8"),
  ) as RulesFile;
  const d = file.districts[district];
  if (!d) return { kind: "unsupported-district", district, jurisdiction: file.jurisdiction };

  const { name, ...rules } = d;
  return {
    kind: "found",
    rules: {
      ...rules,
      jurisdiction: file.jurisdiction,
      district,
      districtName: name,
      source: file.source,
      notes: file.notes,
      verified: true,
    },
  };
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
