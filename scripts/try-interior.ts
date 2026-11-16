/**
 * Try the interior designer on a plan folder.
 *   node --env-file-if-exists=.env --import tsx scripts/try-interior.ts <plan dir>           full run
 *   node --env-file-if-exists=.env --import tsx scripts/try-interior.ts <plan dir> --render  redraw from interior.json
 */
import { renderInterior, run } from "../src/agents/interiorDesigner.ts";

const dir = process.argv[2];
if (!dir) throw new Error("Give a plan folder.");
const started = Date.now();
if (process.argv.includes("--render")) {
  console.log(await renderInterior(dir));
} else {
  const r = await run(dir, (s) => console.log(s));
  console.log(JSON.stringify({ ...r, style: r.style.name }, null, 2));
}
console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
