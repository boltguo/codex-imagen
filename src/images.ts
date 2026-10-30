// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { atomicWrite, checkOutput } from "./files.js";
import { parseRatio } from "./options.js";
import { CliError, type ImageResult, type ResolvedOptions } from "./types.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export async function inputDataUrl(
  file: string,
  options: ResolvedOptions,
): Promise<string> {
  if (!(await stat(file)).isFile())
    throw new CliError(`Input image is not a file: ${file}`);
  try {
    let pipeline = sharp(file, {
      failOn: "warning",
      limitInputPixels: 100_000_000,
    }).autoOrient();
    if (options.inputMaxEdge)
      pipeline = pipeline.resize(options.inputMaxEdge, options.inputMaxEdge, {
        fit: "inside",
        withoutEnlargement: true,
      });
    const bytes = await pipeline
      .webp({ quality: options.inputWebpQuality })
      .toBuffer();
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new CliError("Compacted input image exceeds 32 MiB.");
    return `data:image/webp;base64,${bytes.toString("base64")}`;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not read or compact input image: ${file}`);
  }
}

export async function saveImage(
  encoded: string,
  file: string,
  options: ResolvedOptions,
  log: (message: string) => void,
): Promise<ImageResult> {
  await checkOutput(file, options.force);
  const clean = encoded.trim();
  if (clean.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    throw new CliError("Image result exceeds 32 MiB.");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw new CliError("Image result is not valid base64.");
  const bytes = Buffer.from(clean, "base64");
  if (bytes.toString("base64") !== clean)
    throw new CliError("Image result is not canonical base64.");
  let width: number, height: number;
  try {
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png")
      throw new CliError(
        `Expected PNG image data, received ${metadata.format ?? "unknown"}.`,
      );
    // metadata() alone does not detect truncated pixel data.
    const decoded = await image.raw().toBuffer({ resolveWithObject: true });
    width = decoded.info.width;
    height = decoded.info.height;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Backend returned an invalid or truncated PNG image.");
  }
  const actual = `${width}x${height}`;
  let mismatch: string | undefined;
  if (options.size !== "auto" && options.size !== actual)
    mismatch = `Requested ${options.size}, backend returned ${actual}.`;
  if (
    options.aspectRatio &&
    Math.abs(width / height / parseRatio(options.aspectRatio) - 1) > 0.02
  ) {
    mismatch = `Requested aspect ratio ${options.aspectRatio}, backend returned ${actual}.`;
  }
  if (mismatch) {
    if (options.sizePolicy === "error")
      throw new CliError(
        `${mismatch} Output was not written (--size-policy error).`,
      );
    log(`Warning: ${mismatch} Saving the original dimensions.`);
  }
  const format =
    options.outputFormat === "auto"
      ? path.extname(file).toLowerCase() === ".webp"
        ? "webp"
        : "png"
      : options.outputFormat;
  const output =
    format === "webp"
      ? await sharp(bytes).webp({ quality: options.webpQuality }).toBuffer()
      : bytes;
  await atomicWrite(file, output, options.force);
  log(`Saved ${actual} ${format.toUpperCase()}: ${file}`);
  return { path: file, width, height, format };
}
