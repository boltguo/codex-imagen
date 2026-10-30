// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
export type Backend = "native" | "responses";
export type Mode = "generate" | "edit";
export type JsonObject = Record<string, unknown>;
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export class CliError extends Error {
  override name = "CliError";
}
export class HttpError extends CliError {
  constructor(
    public status: number,
    public body: string,
    public retryAfter?: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 800)}`);
  }
}
export class ImageResponseError extends CliError {
  constructor(public details: JsonObject) {
    super(
      `Image generation failed: ${String(details.message ?? details.code ?? "unknown error")}`,
    );
  }
}
export interface ClientOptions {
  backend?: Backend;
  baseUrl?: string;
  authFile?: string;
  codexHome?: string;
  model?: string;
  profile?: string;
  timeout?: number;
  refresh?: boolean;
  size?: string;
  aspectRatio?: string;
  sizePolicy?: "warn" | "error";
  quality?: "auto" | "low" | "medium" | "high";
  background?: "auto" | "opaque";
  n?: number;
  force?: boolean;
  dryRun?: boolean;
  outputFormat?: "auto" | "png" | "webp";
  webpQuality?: number;
  inputMaxEdge?: number;
  inputWebpQuality?: number;
  cd?: string;
  signal?: AbortSignal;
}
export interface ResolvedOptions extends Required<
  Omit<
    ClientOptions,
    "authFile" | "model" | "profile" | "aspectRatio" | "signal"
  >
> {
  authFile: string;
  model?: string;
  profile?: string;
  aspectRatio?: string;
  signal?: AbortSignal;
}
export interface ImageJob {
  mode?: Mode;
  prompt: string;
  out: string;
  images?: string[];
  styleImage?: string;
}
export interface ImageResult {
  path: string;
  width: number;
  height: number;
  format: "png" | "webp";
}
export interface RequestPlan {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: JsonObject;
  outputs: string[];
}
export interface ClientHooks {
  log?: (message: string) => void;
  onSaved?: (result: ImageResult) => void;
  onPlan?: (plan: RequestPlan) => void;
}
export interface BatchResult {
  succeeded: number;
  failed: number;
  images: ImageResult[];
  errors: { line: number; message: string }[];
}
