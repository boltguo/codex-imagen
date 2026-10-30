// Adapted from jdmnk/codex-imagegen-cli; rewritten in TypeScript. See NOTICE.
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "./types.js";

export function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : /^~[\\/]/.test(value)
      ? path.join(homedir(), value.slice(2))
      : value;
}

// Resolve existing ancestors too, so batch confinement also covers symlinks.
export async function resolvePath(
  value: string,
  base = process.cwd(),
): Promise<string> {
  const absolute = path.resolve(base, expandHome(value));
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await resolvePath(parent), path.basename(absolute));
  }
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function checkOutput(file: string, force: boolean): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isDirectory())
      throw new CliError(`Output path is a directory: ${file}`);
    if (info.isSymbolicLink())
      throw new CliError(`Refusing to replace an output symlink: ${file}`);
    if (!force)
      throw new CliError(
        `Output already exists: ${file} (use --force to replace)`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function atomicWrite(
  file: string,
  data: Uint8Array,
  replace: boolean,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (replace) await rename(temporary, file);
    else {
      try {
        await link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CliError(
            `Output already exists: ${file} (use --force to replace)`,
          );
        }
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function outputPaths(file: string, n: number): string[] {
  if (n === 1) return [file];
  const parsed = path.parse(file);
  return Array.from({ length: n }, (_, i) =>
    path.join(parsed.dir, `${parsed.name}-${i + 1}${parsed.ext || ".png"}`),
  );
}
