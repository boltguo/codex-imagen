// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { authHeaders, isExpiring, readyAuth, refreshAuth } from "./auth.js";
import { checkOutput, isWithin, outputPaths, resolvePath } from "./files.js";
import { inputDataUrl, saveImage } from "./images.js";
import { parseRatio, reasoningModel, resolveOptions } from "./options.js";
import { postImageStream, postJson, retryDecision } from "./transport.js";
import {
  CliError,
  HttpError,
  isObject,
  type BatchResult,
  type ClientHooks,
  type ClientOptions,
  type ImageJob,
  type ImageResult,
  type JsonObject,
  type RequestPlan,
  type ResolvedOptions,
} from "./types.js";

function stylePrompt(extra: string): string {
  return (
    "Create a new version of the first input image. Preserve its main subject, identity, composition, proportions, and important details. Use the final input image only as a style reference: apply its visual medium, rendering approach, color palette, lighting, texture, finish, and mood. Do not copy the style reference's subject or scene content." +
    (extra ? `\n\nAdditional instruction: ${extra}` : "")
  );
}
function redactImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImages);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactImages(item)]),
    );
  if (
    typeof value === "string" &&
    value.startsWith("data:") &&
    value.includes(";base64,")
  )
    return `${value.split(";base64,")[0]};base64,<redacted>`;
  return value;
}

export class CodexImageClient {
  private resolved?: Promise<ResolvedOptions>;
  constructor(
    private input: ClientOptions = {},
    private hooks: ClientHooks = {},
  ) {}
  private options(): Promise<ResolvedOptions> {
    return (this.resolved ??= resolveOptions(this.input));
  }
  private log(message: string): void {
    this.hooks.log?.(message);
  }

  async run(job: ImageJob): Promise<ImageResult[]> {
    const options = await this.options();
    options.signal?.throwIfAborted();
    const mode =
      job.mode ?? (job.images?.length || job.styleImage ? "edit" : "generate");
    if (!["generate", "edit"].includes(mode))
      throw new CliError("Mode must be generate or edit.");
    if (typeof job.prompt !== "string")
      throw new CliError("Prompt must be a string.");
    let prompt = job.prompt.trim();
    if (mode === "edit" && job.styleImage) prompt = stylePrompt(prompt);
    if (!prompt) throw new CliError("Prompt must not be empty.");
    if (typeof job.out !== "string" || !job.out.trim())
      throw new CliError("Output path must not be empty.");
    if (
      job.images &&
      (!Array.isArray(job.images) ||
        !job.images.every((image) => typeof image === "string" && image.trim()))
    )
      throw new CliError("Images must be a list of non-empty paths.");
    const images = [
      ...(job.images ?? []),
      ...(job.styleImage ? [job.styleImage] : []),
    ];
    if (mode === "edit" && (!job.images?.length || images.length > 5))
      throw new CliError(
        "Edit requires one to five images including the optional style reference.",
      );
    if (mode === "generate" && images.length)
      throw new CliError("Generate does not accept image inputs; use edit.");
    if (options.aspectRatio) {
      const ratio = parseRatio(options.aspectRatio);
      prompt = `The frame must have an aspect ratio of ${options.aspectRatio} (${ratio > 1 ? "landscape, wider than it is tall" : ratio < 1 ? "portrait, taller than it is wide" : "square"}).\n\n${prompt}`;
    }
    const output = await resolvePath(job.out, options.cd);
    const paths = outputPaths(output, options.n);
    if (!options.dryRun)
      for (const file of paths) await checkOutput(file, options.force);
    const imageUrls = await Promise.all(
      images.map(async (image) =>
        inputDataUrl(await resolvePath(image, options.cd), options),
      ),
    );
    const payload: JsonObject =
      options.backend === "native"
        ? {
            model: "gpt-image-2",
            prompt,
            size: options.size,
            quality: options.quality,
            background: options.background,
            ...(mode === "edit"
              ? { images: imageUrls.map((image_url) => ({ image_url })) }
              : {}),
          }
        : {
            model: await reasoningModel(options),
            instructions:
              "Use the available image generation tool to generate exactly one PNG image for the user request. Do not use any other tool." +
              (mode === "edit"
                ? " Treat the provided input images as edit/reference images for the request."
                : ""),
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: prompt },
                  ...imageUrls.map((image_url) => ({
                    type: "input_image",
                    image_url,
                  })),
                ],
              },
            ],
            tools: [
              {
                type: "image_generation",
                output_format: "png",
                size: options.size,
                quality: options.quality,
                background: options.background,
              },
            ],
            tool_choice: { type: "image_generation" },
            parallel_tool_calls: false,
            reasoning: null,
            store: false,
            stream: true,
            include: [],
            prompt_cache_key: "codex-imagen",
            client_metadata: { "x-codex-installation-id": "codex-imagen" },
          };
    const url = `${options.baseUrl}/${options.backend === "responses" ? "responses" : mode === "edit" ? "images/edits" : "images/generations"}`;
    if (options.dryRun) {
      const plan: RequestPlan = {
        method: "POST",
        url,
        headers: { Authorization: "Bearer <redacted>" },
        payload: redactImages(payload) as JsonObject,
        outputs: paths,
      };
      this.hooks.onPlan?.(plan);
      return [];
    }
    let auth = await readyAuth(options);
    const results: ImageResult[] = [];
    for (const [index, file] of paths.entries()) {
      options.signal?.throwIfAborted();
      if (isExpiring(auth.data)) auth = await refreshAuth(auth, options);
      this.log(`${mode} ${index + 1}/${paths.length}: ${file}`);
      let refreshed = false,
        attempt = 0,
        encoded: string;
      for (;;) {
        try {
          const request = {
            headers: authHeaders(auth.data),
            payload,
            timeout: options.timeout,
            signal: options.signal,
          };
          if (options.backend === "responses")
            encoded = await postImageStream(url, request);
          else {
            const response = await postJson(url, request);
            if (
              !Array.isArray(response.data) ||
              response.data.length !== 1 ||
              !isObject(response.data[0]) ||
              typeof response.data[0].b64_json !== "string" ||
              !response.data[0].b64_json
            )
              throw new CliError(
                "Native response must contain exactly one data[].b64_json image.",
              );
            encoded = response.data[0].b64_json;
          }
          break;
        } catch (error) {
          if (
            error instanceof HttpError &&
            error.status === 401 &&
            !refreshed
          ) {
            auth = await refreshAuth(auth, options);
            refreshed = true;
            continue;
          }
          const retry = retryDecision(error, attempt);
          if (!retry || attempt >= 4) throw error;
          attempt++;
          this.log(
            `Warning: ${retry.reason}; retrying in ${retry.delay.toFixed(1)}s (${attempt}/4).`,
          );
          await sleep(retry.delay * 1000, undefined, {
            signal: options.signal,
          });
        }
      }
      const saved = await saveImage(encoded, file, options, (message) =>
        this.log(message),
      );
      results.push(saved);
      this.hooks.onSaved?.(saved);
    }
    return results;
  }

  generate(prompt: string, out: string): Promise<ImageResult[]> {
    return this.run({ mode: "generate", prompt, out });
  }
  edit(
    prompt: string,
    images: string[],
    out: string,
    styleImage?: string,
  ): Promise<ImageResult[]> {
    return this.run({ mode: "edit", prompt, images, out, styleImage });
  }

  async batch(
    input: string,
    outDir: string,
    failFast = false,
  ): Promise<BatchResult> {
    const options = await this.options();
    const file = await resolvePath(input, options.cd);
    const directory = await resolvePath(outDir, options.cd);
    const result: BatchResult = {
      succeeded: 0,
      failed: 0,
      images: [],
      errors: [],
    };
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0,
      jobCount = 0;
    try {
      for await (const raw of lines) {
        line++;
        options.signal?.throwIfAborted();
        if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
        jobCount++;
        try {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            throw new CliError("Invalid JSON.");
          }
          if (typeof value === "string") value = { prompt: value };
          if (!isObject(value))
            throw new CliError("Job must be a JSON string or object.");
          if (typeof value.prompt !== "string" || !value.prompt.trim())
            throw new CliError("Job needs a non-empty string prompt.");
          const images: unknown = value.images ?? [];
          if (
            !Array.isArray(images) ||
            !images.every((image) => typeof image === "string" && image.trim())
          )
            throw new CliError("Job images must be a list of non-empty paths.");
          if (
            value.out !== undefined &&
            (typeof value.out !== "string" || !value.out.trim())
          )
            throw new CliError("Job out must be a non-empty path.");
          const slug =
            value.prompt
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 60) || "image";
          const output = await resolvePath(
            typeof value.out === "string"
              ? value.out
              : `${String(jobCount).padStart(3, "0")}-${slug}.png`,
            directory,
          );
          if (!isWithin(directory, output))
            throw new CliError("Job output must stay under --out-dir.");
          const mode = value.mode ?? (images.length ? "edit" : "generate");
          if (mode !== "generate" && mode !== "edit")
            throw new CliError("Job mode must be generate or edit.");
          result.images.push(
            ...(await this.run({
              mode,
              prompt: value.prompt,
              out: output,
              images: images as string[],
            })),
          );
          result.succeeded++;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          result.failed++;
          result.errors.push({ line, message });
          this.log(`Warning: batch line ${line} failed: ${message}`);
          if (failFast) break;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!jobCount) throw new CliError("Batch input contains no jobs.");
    return result;
  }
}
