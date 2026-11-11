import { generateArchitectureImage } from "./tools/architecture.ts";

async function main() {
  console.log("Generating architectural design...");

  const prompt =
    process.argv.slice(2).join(" ") ||
    "Modern two-storey luxury residential house, minimalist architecture, large glass windows, natural stone facade, landscaped garden, professional architectural visualization, photorealistic";

  const imagePath = await generateArchitectureImage(prompt);

  console.log("Image generated:", imagePath);
}

main().catch(console.error);
