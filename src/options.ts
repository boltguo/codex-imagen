// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { resolvePath } from "./files.js";
import { validateUrl } from "./transport.js";
import {
  CliError,
  isObject,
  type ClientOptions,
  type ResolvedOptions,
} from "./types.js";

export function parseSize(value: string): string {
  if (value === "auto") return value;
  const match = /^([1-9]\d{0,3})x([1-9]\d{0,3})$/.exec(value);
  if (match) {
    const w = Number(match[1]),
      h = Number(match[2]);
    if (
      w % 16 === 0 &&
      h % 16 === 0 &&
      Math.max(w, h) <= 3840 &&
      Math.max(w, h) <= 3 * Math.min(w, h) &&
      w * h >= 655360 &&
      w * h <= 8294400
    )
      return value;
  }
  throw new CliError(
    "Size must be auto or WIDTHxHEIGHT: multiples of 16, at most 3840 per edge, 1:3 to 3:1 aspect, 655360–8294400 pixels.",
  );
}

export function parseRatio(value: string): number {
  const match = /^([1-9]\d{0,5}):([1-9]\d{0,5})$/.exec(value);
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN;
  if (!Number.isFinite(ratio) || ratio < 1 / 3 || ratio > 3)
    throw new CliError("Aspect ratio must be W:H between 1:3 and 3:1.");
  return ratio;
}

function integer(
  value: number,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new CliError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
}

export async function resolveOptions(
  input: ClientOptions = {},
): Promise<ResolvedOptions> {
  const cd = await resolvePath(input.cd ?? process.cwd());
  if (!(await stat(cd)).isDirectory())
    throw new CliError(`--cd is not a directory: ${cd}`);
  const codexHome = await resolvePath(
    input.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  const options: ResolvedOptions = {
    backend: input.backend ?? "native",
    baseUrl: validateUrl(
      input.baseUrl ??
        process.env.CODEX_IMAGEGEN_BASE_URL ??
        "https://chatgpt.com/backend-api/codex",
    ),
    codexHome,
    authFile: await resolvePath(
      input.authFile ?? path.join(codexHome, "auth.json"),
    ),
    model: input.model,
    profile: input.profile,
    timeout: input.timeout ?? 300,
    refresh: input.refresh ?? true,
    size: parseSize(input.size ?? "auto"),
    aspectRatio: input.aspectRatio,
    sizePolicy: input.sizePolicy ?? "warn",
    quality: input.quality ?? "auto",
    background: input.background ?? "auto",
    n: input.n ?? 1,
    force: input.force ?? false,
    dryRun: input.dryRun ?? false,
    outputFormat: input.outputFormat ?? "auto",
    webpQuality: input.webpQuality ?? 85,
    inputMaxEdge: input.inputMaxEdge ?? 1536,
    inputWebpQuality: input.inputWebpQuality ?? 90,
    cd,
    signal: input.signal,
  };
  if (!["native", "responses"].includes(options.backend))
    throw new CliError("Backend must be native or responses.");
  if (options.backend === "native" && (options.model || options.profile))
    throw new CliError(
      "--model/--reasoning-model and --profile require --backend responses; they do not select the image generator.",
    );
  if (!["auto", "low", "medium", "high"].includes(options.quality))
    throw new CliError("Quality must be auto, low, medium, or high.");
  if (!["auto", "opaque"].includes(options.background))
    throw new CliError(
      "This upstream-compatible client supports background auto or opaque.",
    );
  if (!["warn", "error"].includes(options.sizePolicy))
    throw new CliError("Size policy must be warn or error.");
  if (!["auto", "png", "webp"].includes(options.outputFormat))
    throw new CliError("Output format must be auto, png, or webp.");
  if (
    !Number.isFinite(options.timeout) ||
    options.timeout <= 0 ||
    options.timeout > 86400
  )
    throw new CliError(
      "Timeout must be a positive number no greater than 86400 seconds.",
    );
  integer(options.n, "--n", 1);
  integer(options.webpQuality, "--webp-quality", 1, 100);
  integer(options.inputMaxEdge, "--input-max-edge", 0);
  integer(options.inputWebpQuality, "--input-webp-quality", 1, 100);
  if (options.aspectRatio) {
    parseRatio(options.aspectRatio);
    if (options.size !== "auto")
      throw new CliError("Use --aspect-ratio or --size, not both.");
  }
  return options;
}

export async function reasoningModel(
  options: ResolvedOptions,
): Promise<string> {
  if (options.model?.trim()) return options.model;
  if (process.env.CODEX_IMAGEGEN_MODEL?.trim())
    return process.env.CODEX_IMAGEGEN_MODEL;
  let config: Record<string, unknown> = {};
  try {
    config = parse(
      await readFile(path.join(options.codexHome, "config.toml"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CliError("Could not parse Codex config.toml.");
  }
  let model: unknown = config.model ?? "gpt-5.5";
  const profile = options.profile ?? config.profile;
  if (profile) {
    if (
      typeof profile !== "string" ||
      !isObject(config.profiles) ||
      !isObject(config.profiles[profile])
    )
      throw new CliError(`Unknown Codex profile: ${String(profile)}`);
    model = config.profiles[profile].model ?? model;
  }
  if (typeof model !== "string" || !model.trim())
    throw new CliError("Codex reasoning model must be a non-empty string.");
  return model;
}
