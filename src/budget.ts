export function parseAmount(input: string): number {
  let s = input
    .trim()
    .toLowerCase()
    .replace(/[$,\s]/g, "");
  let mult = 1;
  if (s.endsWith("k")) {
    mult = 1_000;
    s = s.slice(0, -1);
  } else if (s.endsWith("m")) {
    mult = 1_000_000;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  if (s === "" || !Number.isFinite(n) || n < 0) throw new Error(`Invalid amount: ${input}`);
  return Math.round(n * mult);
}

export const BUDGET_TOLERANCE = 0.15;

export function parseBudget(input: string): [number, number] {
  const upTo = input.trim().match(/^(?:up\s*to|under|max|below|<)\s*(.+)$/i);
  if (upTo) return [0, parseAmount(upTo[1])];

  if (input.includes("-")) {
    const [lo, hi] = input.split("-", 2);
    const range: [number, number] = [parseAmount(lo), parseAmount(hi)];
    if (range[0] > range[1]) throw new Error(`Invalid range: ${input}`);
    return range;
  }

  const target = parseAmount(input);
  return [Math.round(target * (1 - BUDGET_TOLERANCE)), Math.round(target * (1 + BUDGET_TOLERANCE))];
}
