import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function generateArchitectureImage(prompt: string): Promise<string> {
  const outputDir = path.resolve("outputs");
  // mflux saves to "<name>_1.png" instead of overwriting, so each run needs its own name.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputPath = path.join(outputDir, `architecture-${stamp}.png`);

  await mkdir(outputDir, { recursive: true });

  const args = [
    "--model",
    "flux2-klein-4b",
    "--prompt",
    prompt,
    "--steps",
    "4",
    "--width",
    "512",
    "--height",
    "512",
    "--seed",
    "42",
    "-q",
    "4",
    "--small-text-encoder",
    "--output",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const process = spawn("mflux-generate-flux2", args, {
      stdio: "inherit",
    });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`Image generation failed. Exit code: ${code}`));
      }
    });
  });
}
