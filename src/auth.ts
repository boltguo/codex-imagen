// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import lockfile from "proper-lockfile";
import { atomicWrite } from "./files.js";
import { postJson, validateUrl } from "./transport.js";
import {
  CliError,
  isObject,
  type JsonObject,
  type ResolvedOptions,
} from "./types.js";
import { VERSION } from "./version.js";

export interface AuthState {
  data: JsonObject;
  raw: string;
}
export function jwtPayload(token: string): JsonObject {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return isObject(payload) ? payload : {};
  } catch {
    return {};
  }
}
export function accessToken(auth: JsonObject): string {
  if (
    !isObject(auth.tokens) ||
    typeof auth.tokens.access_token !== "string" ||
    !auth.tokens.access_token
  ) {
    throw new CliError(
      "File-based Codex ChatGPT login not found. Run `codex login` and choose ChatGPT.",
    );
  }
  return auth.tokens.access_token;
}
export function isExpiring(auth: JsonObject): boolean {
  const exp = jwtPayload(accessToken(auth)).exp;
  return typeof exp === "number" && exp <= Date.now() / 1000 + 60;
}
function idClaims(auth: JsonObject): JsonObject {
  if (!isObject(auth.tokens)) return {};
  const token = auth.tokens.id_token;
  if (isObject(token)) return token;
  if (typeof token !== "string") return {};
  const claims = jwtPayload(token)["https://api.openai.com/auth"];
  return isObject(claims) ? claims : {};
}
export function accountId(auth: JsonObject): string | undefined {
  const account =
    (isObject(auth.tokens) ? auth.tokens.account_id : undefined) ??
    idClaims(auth).chatgpt_account_id;
  return typeof account === "string" && account ? account : undefined;
}
export async function readAuth(file: string): Promise<AuthState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new CliError(
      `Could not read Codex auth file: ${file}. Only file-based login is supported; keyring and ephemeral credentials are not supported.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError("Codex auth file contains invalid JSON.");
  }
  if (!isObject(data))
    throw new CliError("Codex auth file must contain an object.");
  accessToken(data);
  return { data, raw };
}

let cachedVersion: string | undefined;
export function codexVersion(): string {
  if (process.env.CODEX_IMAGEGEN_CODEX_VERSION)
    return process.env.CODEX_IMAGEGEN_CODEX_VERSION;
  if (cachedVersion) return cachedVersion;
  try {
    const output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedVersion = /\d+\.\d+\.\d+/.exec(output)?.[0] ?? VERSION;
  } catch {
    cachedVersion = VERSION;
  }
  return cachedVersion;
}
export function authHeaders(auth: JsonObject): Record<string, string> {
  const originator =
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
  const version = codexVersion();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken(auth)}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    originator,
    version,
    "User-Agent": `${originator}/${version} (${os.type()} ${os.release()}; ${os.arch()}) codex-imagen/${VERSION}`,
  };
  const account = accountId(auth);
  if (account) headers["ChatGPT-Account-ID"] = account;
  if (idClaims(auth).chatgpt_account_is_fedramp)
    headers["X-OpenAI-Fedramp"] = "true";
  return headers;
}

export async function refreshAuth(
  previous: AuthState,
  options: ResolvedOptions,
): Promise<AuthState> {
  if (!options.refresh)
    throw new CliError(
      "Credentials need refreshing; --no-refresh is set. Refresh the login with Codex and retry.",
    );
  let compromised = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(options.authFile, {
      realpath: false,
      lockfilePath: `${options.authFile}.imagegen-ts.lock`,
      stale: 30000,
      retries: {
        retries: Math.ceil(Math.min(options.timeout, 30) * 2),
        minTimeout: 100,
        maxTimeout: 500,
      },
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch {
    throw new CliError(
      "Could not acquire the credential refresh lock; another process may be refreshing.",
    );
  }
  try {
    const current = await readAuth(options.authFile);
    if (accountId(current.data) !== accountId(previous.data))
      throw new CliError(
        "Codex account changed during the request. Run the command again.",
      );
    if (
      JSON.stringify(current.data.tokens) !==
        JSON.stringify(previous.data.tokens) &&
      !isExpiring(current.data)
    )
      return current;
    const tokens = current.data.tokens;
    if (
      !isObject(tokens) ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token
    )
      throw new CliError(
        "Codex refresh token missing. Run `codex login` again.",
      );
    let refreshed: JsonObject;
    try {
      refreshed = await postJson(
        validateUrl(
          process.env.CODEX_IMAGEGEN_REFRESH_URL ??
            "https://auth.openai.com/oauth/token",
        ),
        {
          payload: {
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
          },
          timeout: options.timeout,
          signal: options.signal,
        },
      );
    } catch {
      throw new CliError(
        "Codex token refresh failed; auth file was not changed. Refresh the login with Codex and retry.",
      );
    }
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token)
      throw new CliError(
        "Token refresh returned no access token; auth file was not changed.",
      );
    const next = structuredClone(current.data);
    const nextTokens = next.tokens as JsonObject;
    for (const key of ["access_token", "refresh_token", "id_token"]) {
      if (typeof refreshed[key] === "string" && refreshed[key])
        nextTokens[key] = refreshed[key];
    }
    if (isObject(nextTokens.id_token))
      nextTokens.id_token = nextTokens.id_token.raw_jwt;
    if (typeof nextTokens.id_token !== "string" || !nextTokens.id_token)
      throw new CliError(
        "Codex ID token is invalid; auth file was not changed.",
      );
    next.last_refresh = new Date().toISOString();
    if (compromised || (await readAuth(options.authFile)).raw !== current.raw)
      throw new CliError(
        "Codex auth changed while refreshing; refusing to overwrite it. Run the command again.",
      );
    const raw = `${JSON.stringify(next, null, 2)}\n`;
    await atomicWrite(options.authFile, Buffer.from(raw), true);
    return { data: next, raw };
  } finally {
    await release().catch(() => {});
  }
}

export async function readyAuth(options: ResolvedOptions): Promise<AuthState> {
  const auth = await readAuth(options.authFile);
  return isExpiring(auth.data) ? refreshAuth(auth, options) : auth;
}
