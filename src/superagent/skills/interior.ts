/**
 * Skill: furnished 3D top views of every floor in a plan.
 *
 * Wraps the interior designer agent (src/agents/interiorDesigner.ts): it reads
 * the floors from plan.svg, picks a style that suits the house, furnishes each
 * room and renders each floor in 3D. It writes interior.json, one
 * interior-<type>-<level>.png per floor and interior.pdf (only the pictures,
 * no text) into the plan folder.
 */
import * as interiorDesigner from "../../agents/interiorDesigner.ts";

export type InteriorResult = interiorDesigner.InteriorResult & { planDir: string };

export async function designInterior(
  planDir: string,
  onStep: (step: string) => void,
): Promise<InteriorResult> {
  return { ...(await interiorDesigner.run(planDir, onStep)), planDir };
}
