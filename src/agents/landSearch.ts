import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../paths.ts";

const execFileAsync = promisify(execFile);

const PYTHON = `${PROJECT_ROOT}.venv/bin/python`;
const SCRIPT = `${PROJECT_ROOT}scripts/realtor_land.py`;

const SQFT_PER_ACRE = 43_560;

export type Listing = {
  address: string;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  county: string | null;
  latitude: number | null;
  longitude: number | null;
  priceUsd: number;
  lotSqft: number | null;
  acres: number | null;
  url: string;
};

type RawListing = Omit<Listing, "address" | "priceUsd" | "acres" | "url"> & {
  address: string | null;
  priceUsd: number | null;
  url: string | null;
};

export async function run(city: string, minBudget: number, maxBudget: number): Promise<Listing[]> {
  if (!existsSync(PYTHON)) {
    throw new Error("Python environment not found. Run `npm run setup` first.");
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      PYTHON,
      [SCRIPT, city, String(minBudget), String(maxBudget)],
      { maxBuffer: 50 * 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`Listing search failed: ${stderr || (err as Error).message}`, { cause: err });
  }

  const raw = JSON.parse(stdout) as RawListing[];
  return raw
    .filter((l): l is RawListing & { priceUsd: number; url: string } => !!l.priceUsd && !!l.url)
    .filter((l) => l.priceUsd >= minBudget && l.priceUsd <= maxBudget)
    .map((l) => ({
      ...l,
      address: l.address ?? [l.city, l.state].filter(Boolean).join(", "),
      acres: l.lotSqft ? Math.round((l.lotSqft / SQFT_PER_ACRE) * 100) / 100 : null,
    }))
    .sort((a, b) => a.priceUsd - b.priceUsd);
}
