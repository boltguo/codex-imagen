// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import {
  CliError,
  HttpError,
  ImageResponseError,
  isObject,
  type JsonObject,
} from "./types.js";

const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_SSE_BYTES = 64 * 1024 * 1024;

export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("Backend URL must be an absolute URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError(
      "Use HTTPS for backend URLs (HTTP is supported only on loopback for tests).",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "Backend URLs must not contain credentials, query strings, or fragments.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function cleanError(body: string, headers: Record<string, string>): string {
  const token = headers.Authorization?.replace(/^Bearer /, "");
  return token ? body.split(token).join("<redacted>") : body;
}

async function readText(
  response: Response,
  limit = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      count += item.value.byteLength;
      if (count > limit)
        throw new CliError("Backend response exceeds the size limit.");
      parts.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}

export interface PostOptions {
  headers?: Record<string, string>;
  payload: JsonObject;
  timeout: number;
  signal?: AbortSignal;
}

async function post(
  url: string,
  options: PostOptions,
  stream: boolean,
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    ...options.headers,
  };
  const deadline = AbortSignal.timeout(Math.ceil(options.timeout * 1000));
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(options.payload),
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted)
      throw new CliError(
        options.signal?.aborted
          ? "Interrupted."
          : `Request timed out after ${options.timeout}s.`,
      );
    throw new CliError(
      "Network request failed. It was not retried because generation may already have started.",
    );
  }
  if (!response.ok) {
    const body = cleanError(await readText(response, 1024 * 1024), headers);
    throw new HttpError(
      response.status,
      body,
      response.headers.get("retry-after") ?? undefined,
    );
  }
  return response;
}

export async function postJson(
  url: string,
  options: PostOptions,
): Promise<JsonObject> {
  const response = await post(url, options, false);
  let value: unknown;
  try {
    value = JSON.parse(await readText(response));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Backend did not return a complete JSON response; request was not retried.",
    );
  }
  if (!isObject(value))
    throw new CliError("Backend JSON response must be an object.");
  return value;
}

function imageInEvent(value: unknown): string | undefined {
  if (!isObject(value)) return;
  if (
    ["response.failed", "response.incomplete", "error"].includes(
      String(value.type),
    )
  ) {
    const response = isObject(value.response) ? value.response : value;
    throw new ImageResponseError(
      isObject(response.error) ? response.error : response,
    );
  }
  const items: unknown[] = [value.item];
  if (
    value.type === "response.completed" &&
    isObject(value.response) &&
    Array.isArray(value.response.output)
  ) {
    items.push(...value.response.output);
  }
  for (const item of items) {
    if (
      isObject(item) &&
      item.type === "image_generation_call" &&
      item.status === "completed" &&
      typeof item.result === "string" &&
      item.result
    ) {
      return item.result;
    }
  }
}

export async function postImageStream(
  url: string,
  options: PostOptions,
): Promise<string> {
  const response = await post(url, options, true);
  if (!response.body) throw new CliError("Responses stream has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    block: string[] = [],
    bytes = 0;
  const parseBlock = (): string | undefined => {
    const data = block
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    block = [];
    if (!data || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(cleanError(data, options.headers ?? {}));
    } catch {
      throw new CliError("Responses stream contained invalid JSON.");
    }
    return imageInEvent(value);
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_SSE_BYTES)
          throw new CliError("Responses stream exceeds the size limit.");
      }
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const index = pending.search(/[\r\n]/);
        if (index < 0 || (!chunk.done && pending.slice(index) === "\r")) break;
        const line = pending.slice(0, index);
        const width = pending.slice(index, index + 2) === "\r\n" ? 2 : 1;
        pending = pending.slice(index + width);
        if (line) block.push(line);
        else {
          const result = parseBlock();
          if (result) return result;
        }
      }
      if (chunk.done) {
        if (pending) block.push(pending);
        const result = parseBlock();
        if (result) return result;
        throw new CliError("Responses stream ended without a completed image.");
      }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Responses stream was interrupted; request was not retried.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function retryDecision(
  error: unknown,
  attempt: number,
): { delay: number; reason: string } | undefined {
  let details: JsonObject = {};
  let retryAfter: string | undefined;
  if (error instanceof HttpError) {
    if (error.status !== 429) return;
    try {
      const value: unknown = JSON.parse(error.body);
      if (isObject(value) && isObject(value.error)) details = value.error;
    } catch {
      /* An unstructured 429 still allows bounded backoff. */
    }
    if (
      (details.code != null && details.code !== "rate_limit_exceeded") ||
      ["insufficient_quota", "image_generation_user_error"].includes(
        String(details.type),
      )
    )
      return;
    retryAfter = error.retryAfter;
  } else if (
    error instanceof ImageResponseError &&
    error.details.code === "rate_limit_exceeded"
  ) {
    details = error.details;
  } else return;
  const message = String(details.message ?? "");
  const used = /Used\s+(\d+(?:\.\d+)?)/i.exec(message);
  const limit = /Limit\s+(\d+(?:\.\d+)?)/i.exec(message);
  let delay = Math.min(2 ** attempt, 16);
  let reason = "image generation rate-limited";
  if (
    /input-images per min/i.test(message) &&
    used &&
    limit &&
    Number(used[1]) >= Number(limit[1])
  ) {
    delay = [65, 130, 260, 300][Math.min(attempt, 3)]!;
    reason = "input-image quota full";
  } else {
    const match = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i.exec(message);
    if (match)
      delay = Math.max(
        delay,
        Number(match[1]) / (match[2]?.toLowerCase() === "ms" ? 1000 : 1),
      );
  }
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const wait = Number.isNaN(seconds)
      ? (Date.parse(retryAfter) - Date.now()) / 1000
      : seconds;
    if (Number.isNaN(wait)) return;
    delay = Math.max(delay, wait);
  }
  return Number.isFinite(delay) && delay <= 300 ? { delay, reason } : undefined;
}
