/**
 * Turns plan files into things Slack can show.
 *
 * Slack cannot display our HTML reports or SVG drawings inside a message, so
 * for each design we make:
 *   - plan.pdf: the full plan page (drawing + notes), for downloading/printing.
 *   - plan.png: a picture of the drawing, which Slack previews right in the thread.
 *
 * Both are produced by Google Chrome running "headless" (no window). Chrome
 * already knows how to render HTML/SVG perfectly, and it has built-in
 * --print-to-pdf and --screenshot options, so no extra libraries are needed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Chrome's location on macOS. Set CHROME_PATH in .env if it lives elsewhere. */
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Run headless Chrome with the given options, and fail clearly if Chrome is missing. */
async function chrome(args: string[]): Promise<void> {
  if (!existsSync(CHROME))
    throw new Error(`Google Chrome was not found at ${CHROME}. Install it or set CHROME_PATH.`);
  await execFileAsync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", ...args], {
    timeout: 60_000,
  });
}

/**
 * Print an HTML page to PDF, the same as File → Print → Save as PDF, without
 * headers/footers.
 *
 * Chrome has no command-line switch for landscape; the page itself decides
 * via the CSS rule `@page { size: landscape }`. So for landscape we print a
 * temporary copy of the page with that rule added, saved next to the original
 * so its relative links and images still work, and delete it afterwards.
 */
export async function printPdf(
  htmlPath: string,
  pdfPath: string,
  { landscape = false }: { landscape?: boolean } = {},
): Promise<void> {
  let source = htmlPath;
  if (landscape) {
    source = htmlPath.replace(/\.html$/, ".print.html");
    const html = await readFile(htmlPath, "utf8");
    await writeFile(
      source,
      html.replace("</head>", "<style>@page{size:letter landscape}</style></head>"),
    );
  }
  try {
    await chrome([
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(source).href,
    ]);
  } finally {
    if (source !== htmlPath) await rm(source, { force: true });
  }
}

/**
 * Take a picture of a three.js page (the interior designer's 3D views).
 * Chrome draws WebGL in software (SwiftShader), so no graphics card is
 * needed; local files may load each other so the page can import three.js
 * from node_modules. The virtual time budget lets the page finish drawing
 * before the picture is taken.
 */
export async function screenshotWebGl(
  htmlPath: string,
  pngPath: string,
  { width, height, scale }: { width: number; height: number; scale: number },
): Promise<void> {
  await chrome([
    "--allow-file-access-from-files",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    "--default-background-color=ffffffff",
    "--virtual-time-budget=20000",
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ]);
}

/**
 * Take a picture of the SVG drawing. The house designer draws on a
 * 1600 x 1100 canvas, so the browser window is set to exactly that size.
 */
export async function screenshotSvg(svgPath: string, pngPath: string): Promise<void> {
  await chrome([
    "--window-size=1600,1100",
    "--default-background-color=ffffffff",
    `--screenshot=${pngPath}`,
    pathToFileURL(svgPath).href,
  ]);
}
