/**
 * Site checks for the feasibility report, from free public map services,
 * looked up by the property's latitude and longitude:
 *
 *   - Flood zone: FEMA's flood hazard map, via Esri's public copy (FEMA's own
 *     server refuses connections from outside the US). It only holds the
 *     higher-risk zones, so "no result" means not in a mapped 100-year
 *     floodplain.
 *   - Soil: the USDA national soil survey (Soil Data Access). Its rating for
 *     houses on concrete slabs (the Texas norm) says how hard the soil makes
 *     building, and why (shrink-swell clay, shallow bedrock, ...). This is a
 *     broad survey, not a soil report from borings on the lot.
 *   - Edwards Aquifer: Texas's (TCEQ) official map of the recharge,
 *     transition and contributing zones, which bring extra water-quality rules
 *     in west and south Austin.
 *   - Utilities: there is no public data on water/sewer capacity, so this only
 *     says whether the lot is inside the City of Austin's zoning map (likely
 *     city water and sewer) or not (possibly a utility district or well and
 *     septic), and what to ask the utility.
 *
 * Every check fails soft: if a service is down, that check says "couldn't
 * check" and the report carries on.
 */
import type { Listing } from "./landSearch.ts";
import { lookupZoning } from "./zoning.ts";

/** "red" = a serious issue, "amber" = something to plan for, "green" = fine, "unknown" = couldn't check. */
export type Flag = "red" | "amber" | "green" | "unknown";

export type SiteCheck = {
  flag: Flag;
  /** One-line result, e.g. "Zone AE: 1% annual chance (100-year) floodplain". */
  summary: string;
  /** What it means and what to do about it. */
  detail: string;
};

export type SiteChecks = {
  flood: SiteCheck;
  soil: SiteCheck;
  edwards: SiteCheck;
  utilities: SiteCheck;
};

const FLOOD_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0/query";
const EDWARDS_URL =
  "https://gisweb.tceq.texas.gov/arcgis/rest/services/Edwards/EdwardsViewer_PRD/MapServer/9/query";
const SOIL_URL = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";
const TIMEOUT = 20_000;

/** Ask an ArcGIS map service which shapes contain the point; returns their attributes. */
async function pointQuery(
  url: string,
  lat: number,
  lon: number,
  fields: string,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields,
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    features?: { attributes: Record<string, unknown> }[];
    error?: { message: string };
  };
  if (data.error) throw new Error(data.error.message);
  return (data.features ?? []).map((f) => f.attributes);
}

const unknown = (what: string, err: unknown): SiteCheck => ({
  flag: "unknown",
  summary: `Couldn't check the ${what}`,
  detail: `The ${what} service didn't answer (${err instanceof Error ? err.message : String(err)}). Check it manually before deciding.`,
});

async function flood(lat: number, lon: number): Promise<SiteCheck> {
  try {
    const zones = await pointQuery(FLOOD_URL, lat, lon, "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE");
    // A lot can touch several zones; the highest-risk one decides.
    const high = zones.find((z) => z.SFHA_TF === "T");
    if (high) {
      const bfe = Number(high.STATIC_BFE);
      return {
        flag: "red",
        summary: `FEMA zone ${String(high.FLD_ZONE)}: 1% annual chance (100-year) floodplain`,
        detail:
          "Building here needs flood insurance, a floor raised above the flood level" +
          (bfe > 0 ? ` (base flood elevation ${bfe} ft)` : "") +
          ", an elevation certificate, and likely a floodplain development permit. Austin's own (Atlas 14) floodplain maps may be stricter than FEMA's.",
      };
    }
    const moderate = zones.find((z) => String(z.ZONE_SUBTY ?? "").includes("0.2"));
    if (moderate)
      return {
        flag: "amber",
        summary: "FEMA moderate risk: 0.2% annual chance (500-year) floodplain",
        detail:
          "Flood insurance isn't required but is recommended; check Austin's floodplain maps.",
      };
    return {
      flag: "green",
      summary: "Not in a mapped FEMA 100-year floodplain",
      detail:
        "FEMA maps no high-risk flood zone at this location. Austin's own floodplain maps can be stricter; confirm with the City for lots near creeks.",
    };
  } catch (err) {
    return unknown("flood map", err);
  }
}

/** Run a SQL query against the USDA Soil Data Access service; returns rows as objects. */
async function soilQuery(sql: string): Promise<Record<string, string>[]> {
  const res = await fetch(SOIL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "JSON+COLUMNNAME", query: sql }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { Table?: string[][] };
  const [head, ...rows] = data.Table ?? [];
  return head ? rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))) : [];
}

async function soil(lat: number, lon: number): Promise<SiteCheck> {
  try {
    // The soil "map unit" at the point, its main soil, and the survey's rating
    // for houses on a concrete slab (Texas), falling back to the national
    // "dwellings without basements" rating. ruledepth 0 is the overall rating,
    // ruledepth 1 rows are the reasons behind it.
    const at = `SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon} ${lat})')`;
    const rows = await soilQuery(
      `SELECT mu.muname, c.compname, c.comppct_r, ci.mrulename, ci.ruledepth, ci.interphrc, ci.interphr ` +
        `FROM mapunit mu JOIN component c ON c.mukey = mu.mukey ` +
        `JOIN cointerp ci ON ci.cokey = c.cokey ` +
        `WHERE mu.mukey IN (${at}) AND c.majcompflag = 'Yes' ` +
        `AND ci.mrulename IN ('URB - Dwellings on Concrete Slab (TX)', 'ENG - Dwellings W/O Basements') ` +
        `AND (ci.ruledepth = 0 OR ci.interphr > 0) ` +
        `ORDER BY CAST(c.comppct_r AS INT) DESC`,
    );
    if (!rows.length)
      return {
        flag: "unknown",
        summary: "No soil survey rating for this point",
        detail:
          "The USDA survey has no rating here (often in dense urban areas). A geotechnical report is needed.",
      };
    const rule = rows.some((r) => r.mrulename?.startsWith("URB"))
      ? "URB - Dwellings on Concrete Slab (TX)"
      : "ENG - Dwellings W/O Basements";
    const main = rows.find((r) => r.mrulename === rule && r.ruledepth === "0")!;
    const reasons = [
      ...new Set(
        rows
          .filter(
            (r) => r.mrulename === rule && r.ruledepth === "1" && r.compname === main.compname,
          )
          .map((r) => r.interphrc!.toLowerCase()),
      ),
    ];
    const rating = main.interphrc || "Not rated";
    if (/not rated/i.test(rating))
      return {
        flag: "unknown",
        summary: `${main.muname}: not rated by the soil survey`,
        detail:
          "The USDA survey doesn't rate this soil for houses (common for disturbed urban land). A geotechnical report is needed for the foundation design.",
      };
    const flag: Flag = /limited/i.test(rating) && !/not limited/i.test(rating) ? "amber" : "green";
    return {
      flag,
      summary: `${main.muname}: "${rating}" for houses${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
      detail:
        flag === "green"
          ? "The soil survey sees no major limits for building. A geotechnical report is still needed for the foundation design."
          : `Expect extra foundation work${reasons.length ? ` because of ${reasons.join(", ")}` : ""}: plan for a geotechnical report (borings) before buying, and keep a foundation allowance in the budget.`,
    };
  } catch (err) {
    return unknown("soil survey", err);
  }
}

async function edwards(lat: number, lon: number): Promise<SiteCheck> {
  try {
    const zones = await pointQuery(EDWARDS_URL, lat, lon, "CODE,TYPE");
    const zone = zones[0];
    if (!zone)
      return {
        flag: "green",
        summary: "Not in an Edwards Aquifer zone",
        detail: "TCEQ's Edwards Aquifer rules don't apply at this location.",
      };
    const type = String(zone.TYPE);
    const recharge = String(zone.CODE) === "1";
    return {
      flag: "amber",
      summary: type,
      detail: recharge
        ? "Building over the recharge zone needs a TCEQ Water Pollution Abatement Plan, with stricter limits on paved and roofed area and permanent water-quality controls. Expect extra design cost and approval time."
        : "Extra TCEQ water-quality rules apply (e.g. a Contributing Zone Plan for larger sites). Check the impervious cover limits with your engineer.",
    };
  } catch (err) {
    return unknown("Edwards Aquifer map", err);
  }
}

async function utilities(listing: Listing): Promise<SiteCheck> {
  try {
    const zoning = await lookupZoning(listing);
    if (zoning.kind !== "unknown")
      return {
        flag: "green",
        summary: "Inside the City of Austin: likely Austin Water and Austin Energy",
        detail:
          "Capacity isn't public. Ask Austin Water for a Service Extension Request (or confirm existing taps) and budget for connection and impact fees.",
      };
    return {
      flag: "amber",
      summary: "Outside Austin's city zoning map: utility provider unknown",
      detail:
        "The lot may be served by a municipal utility district (MUD) or water supply corporation, or need a private well and septic system. Get a will-serve letter from the provider, or a septic feasibility study, before buying.",
    };
  } catch (err) {
    return unknown("utility check", err);
  }
}

/** Run all site checks at once (each takes a few seconds). */
export async function runSiteChecks(listing: Listing): Promise<SiteChecks> {
  const { latitude: lat, longitude: lon } = listing;
  if (lat === null || lon === null) {
    const none: SiteCheck = {
      flag: "unknown",
      summary: "No map location for this listing",
      detail: "The listing has no coordinates, so map-based checks couldn't run.",
    };
    return { flood: none, soil: none, edwards: none, utilities: await utilities(listing) };
  }
  const [floodCheck, soilCheck, edwardsCheck, utilityCheck] = await Promise.all([
    flood(lat, lon),
    soil(lat, lon),
    edwards(lat, lon),
    utilities(listing),
  ]);
  return { flood: floodCheck, soil: soilCheck, edwards: edwardsCheck, utilities: utilityCheck };
}
