#!/usr/bin/env node
// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CodexImageClient } from "./client.js";
import { resolvePath } from "./files.js";
import { CliError, type ClientOptions } from "./types.js";
import { VERSION } from "./version.js";

const help = `codex-imagen ${VERSION} — local Codex ChatGPT image CLI

Usage:
  codex-imagen generate --prompt TEXT --out PATH [options]
  codex-imagen edit --image PATH [--image PATH ...] --prompt TEXT --out PATH
  codex-imagen edit --image PATH --style-image PATH --out PATH
  codex-imagen batch --input JOBS.jsonl --out-dir DIR [--fail-fast]

Prompt:   --prompt TEXT | --prompt-file PATH
Images:   --image PATH (repeatable, edit only; up to 5 total) --style-image PATH
Output:   --out PATH --n COUNT --force --output-format auto|png|webp
          --webp-quality 1..100
Framing:  --aspect-ratio W:H | --size auto|WIDTHxHEIGHT
          --size-policy warn|error (default warn; no output resizing)
Quality:  --quality auto|low|medium|high --background auto|opaque
Input:    --input-max-edge PIXELS (default 1536; 0 disables resizing)
          --input-webp-quality 1..100 (default 90)
Backend:  --backend native|responses (default native)
          --model MODEL / --reasoning-model MODEL --profile NAME (responses only)
Auth:     --auth-file PATH --codex-home PATH --no-refresh
Other:    --cd DIR --timeout SECONDS (default 300) --dry-run --help --version
          --base-url URL (receives your account token; use only trusted endpoints)

Batch jobs: {"prompt":"...","out":"image.png"}
            {"prompt":"...","images":["input.png"],"mode":"edit","out":"edit.png"}
Jobs run sequentially. Invalid lines are isolated unless --fail-fast is set.
Saved paths are printed to stdout; progress/errors go to stderr.
Dry runs print request plans without reading auth or contacting the backend.
Requires Node.js >=22 and file-based Codex ChatGPT login for actual generation.
`;

async function main(): Promise<number> {
  const stringKeys = [
    "prompt",
    "prompt-file",
    "out",
    "style-image",
    "input",
    "out-dir",
    "cd",
    "timeout",
    "auth-file",
    "codex-home",
    "backend",
    "base-url",
    "model",
    "reasoning-model",
    "profile",
    "size",
    "aspect-ratio",
    "size-policy",
    "quality",
    "background",
    "n",
    "output-format",
    "webp-quality",
    "input-max-edge",
    "input-webp-quality",
  ];
  const definitions: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean; short?: string }
  > = Object.fromEntries(
    stringKeys.map((key) => [key, { type: "string" as const }]),
  );
  for (const key of ["force", "fail-fast", "dry-run", "no-refresh"])
    definitions[key] = { type: "boolean" };
  definitions.image = { type: "string", multiple: true };
  definitions.help = { type: "boolean", short: "h" };
  definitions.version = { type: "boolean", short: "v" };
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: definitions,
    allowPositionals: true,
    strict: true,
  });
  const text = (key: string): string | undefined =>
    typeof values[key] === "string" ? values[key] : undefined;
  const number = (key: string): number | undefined =>
    text(key) === undefined ? undefined : Number(text(key));
  const flag = (key: string): boolean => values[key] === true;
  if (flag("version")) {
    console.log(`codex-imagen ${VERSION}`);
    return 0;
  }
  if (flag("help") || positionals.length === 0) {
    console.log(help);
    return 0;
  }
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    !["generate", "edit", "batch"].includes(command ?? "")
  )
    throw new CliError(
      "Choose generate, edit, or batch. Use --help for usage.",
    );
  const required = (key: string): string => {
    const value = text(key);
    if (!value?.trim()) throw new CliError(`Missing --${key}.`);
    return value;
  };
  const images = (values.image as string[] | undefined) ?? [];
  const incompatible =
    command === "batch"
      ? ["prompt", "prompt-file", "out", "image", "style-image"]
      : command === "generate"
        ? ["input", "out-dir", "fail-fast", "image", "style-image"]
        : ["input", "out-dir", "fail-fast"];
  for (const key of incompatible)
    if (values[key] !== undefined)
      throw new CliError(`--${key} is not supported by ${command}.`);
  if (text("model") && text("reasoning-model"))
    throw new CliError("Use --model or --reasoning-model, not both.");
  const abort = new AbortController();
  const interrupt = (): void => {
    abort.abort();
  };
  process.once("SIGINT", interrupt);
  const options: ClientOptions = {
    backend: text("backend") as ClientOptions["backend"],
    baseUrl: text("base-url"),
    authFile: text("auth-file"),
    codexHome: text("codex-home"),
    model: text("model") ?? text("reasoning-model"),
    profile: text("profile"),
    timeout: number("timeout"),
    cd: text("cd"),
    refresh: !flag("no-refresh"),
    size: text("size"),
    aspectRatio: text("aspect-ratio"),
    sizePolicy: text("size-policy") as ClientOptions["sizePolicy"],
    quality: text("quality") as ClientOptions["quality"],
    background: text("background") as ClientOptions["background"],
    n: number("n"),
    outputFormat: text("output-format") as ClientOptions["outputFormat"],
    webpQuality: number("webp-quality"),
    inputMaxEdge: number("input-max-edge"),
    inputWebpQuality: number("input-webp-quality"),
    force: flag("force"),
    dryRun: flag("dry-run"),
    signal: abort.signal,
  };
  const client = new CodexImageClient(options, {
    log: (message) => console.error(message),
    onSaved: (result) => console.log(result.path),
    onPlan: (plan) => console.log(JSON.stringify(plan, null, 2)),
  });
  try {
    if (command === "batch") {
      const result = await client.batch(
        required("input"),
        required("out-dir"),
        flag("fail-fast"),
      );
      console.error(
        `Batch: ${result.succeeded} succeeded, ${result.failed} failed.`,
      );
      return result.failed ? 1 : 0;
    }
    if (text("prompt") !== undefined && text("prompt-file") !== undefined)
      throw new CliError("Use --prompt or --prompt-file, not both.");
    const prompt =
      text("prompt-file") !== undefined
        ? await readFile(
            await resolvePath(
              required("prompt-file"),
              await resolvePath(options.cd ?? process.cwd()),
            ),
            "utf8",
          )
        : (text("prompt") ?? "");
    if (command === "edit")
      await client.edit(prompt, images, required("out"), text("style-image"));
    else await client.generate(prompt, required("out"));
    return 0;
  } catch (error) {
    if (abort.signal.aborted) return 130;
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
