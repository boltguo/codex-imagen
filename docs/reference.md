# codex-imagen reference

A TypeScript CLI and JavaScript client for generating, editing, and batch-processing images with your existing local Codex ChatGPT login.

- Requires **Node.js 22 or newer**. Python, uv, and `OPENAI_API_KEY` are not required.
- Supports native Codex image endpoints and the streamed Responses backend.
- Saves PNG or WebP, handles reference images, and supports prompt-based aspect-ratio guidance.
- Runs locally and connects directly to the configured backend.

Adapted from [jdmnk/codex-imagegen-cli](https://github.com/jdmnk/codex-imagegen-cli) under Apache-2.0. See [NOTICE](../NOTICE) for the upstream commit and modifications. This is an independent third-party project, unaffiliated with OpenAI.

## Install

```bash
npm install -g codex-imagen
codex-imagen --help
```

Or run without a global installation:

```bash
npx codex-imagen generate --prompt "A watercolor lighthouse" --out lighthouse.png
```

## Local development

```bash
npm ci
npm test
npm run build
node dist/cli.js --help
```

Register the commands locally on your machine:

```bash
npm link
codex-imagen --version
```

Or build and install a tarball without publishing:

```bash
npm pack
npm install -g ./codex-imagen-0.1.1.tgz
codex-imagen --help
```

The installed command is `codex-imagen`. The published package includes compiled JavaScript and TypeScript declarations, without source maps. Each build removes previous build output before compiling.

## Authentication

Use Codex's ChatGPT login flow first:

```bash
codex login
```

The client reads `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default. Override this with `--auth-file PATH` or `--codex-home PATH`. API-key sessions, keyring-only credentials, and ephemeral in-memory credentials are not supported.

If your own Codex configuration uses a keyring, file storage can be selected with `cli_auth_credentials_store = "file"` in `config.toml`, followed by a new Codex login. This package does not change that setting automatically. See the [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Normal requests refresh expired tokens when needed and atomically update the auth file with restricted permissions. Refreshes are coordinated between this client's processes. Codex itself does not share that lock, so the client detects external credential changes and refuses to overwrite them.

Use `--no-refresh` to use only the current token and disable credential refresh and writes. If that token expires, refresh the login with Codex before retrying.

## Generate

```bash
codex-imagen generate \
  --prompt "A watercolor lighthouse on a rocky coast, no text" \
  --aspect-ratio 16:9 \
  --quality low \
  --out output/lighthouse.png
```

```bash
codex-imagen generate \
  --prompt-file prompt.txt \
  --n 3 \
  --out output/icon.webp
```

`--n 3` runs three sequential requests and writes `icon-1.webp`, `icon-2.webp`, and `icon-3.webp`. Each successful path is printed immediately. Earlier files remain available if a later request fails.

## Edit and use style references

```bash
codex-imagen edit \
  --image examples/inputs/scene.svg \
  --prompt "Change the scene to sunset while preserving its composition" \
  --out output/sunset.webp
```

```bash
codex-imagen edit \
  --image examples/inputs/scene.svg \
  --style-image examples/inputs/palette.svg \
  --out output/warm-landscape.png
```

Repeat `--image` for multiple content/reference images. There must be at least one content image, and at most five images total, including the optional style image. The style image is sent last and labeled as style-only in the prompt. With `--style-image`, `--prompt` is optional extra guidance.

Input images are auto-oriented using EXIF, resized to a maximum edge of 1536 pixels by default, and encoded as WebP at quality 90 before upload. Original files are not modified. Use `--input-max-edge 0` to disable resizing or `--input-webp-quality` to adjust encoding. The bundled SVG samples are rasterized locally before upload.

## Batch JSONL format

Each non-empty line is a JSON object or a JSON string prompt:

```jsonl
{"prompt":"A watercolor lighthouse","out":"lighthouse.png"}
{"prompt":"Change the landscape to sunset","images":["examples/inputs/scene.svg"],"out":"sunset.webp"}
"A watercolor sailboat on a calm ocean, no text"
```

| Field    | Type                                       | Required            | Behavior                                                                                                                            |
| -------- | ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` | Non-empty string                           | Yes for object jobs | Generation or editing instructions. A bare JSON string is equivalent to an object with this field.                                  |
| `out`    | Non-empty string                           | No                  | Filename or nested path under `--out-dir`. Defaults to a numbered prompt slug ending in `.png`.                                     |
| `images` | Array of non-empty path strings, or `null` | No                  | Edit/reference inputs. Missing or `null` means no images.                                                                           |
| `mode`   | `generate` or `edit`                       | No                  | Defaults to `edit` when images are present, otherwise `generate`. Explicit `edit` requires images; `generate` rejects image inputs. |

Only these four fields are interpreted in batch objects. `quality`, `size`, `aspectRatio`, `n`, `backend`, `styleImage`, and similar keys are **not per-job options**. Pass the corresponding CLI options for the entire batch. For style guidance in JSONL, use `images` plus explicit instructions identifying each image, as shown in [multi-image.jsonl](../examples/multi-image.jsonl).

Jobs run sequentially. Blank lines and lines beginning with `#` are ignored. Invalid JSON, invalid fields, and individual backend failures are reported per line; later jobs continue unless `--fail-fast` is set. Any failed job makes the command exit with status 1. A failure does not roll back previously saved images.

Paths are resolved as follows:

- `--input`, `--out-dir`, `--out`, `--image`, `--style-image`, and `--prompt-file` are relative to `--cd`, which defaults to the current working directory.
- Image paths inside JSONL are also relative to `--cd`, **not** the JSONL file's directory.
- Each job's `out` is relative to `--out-dir`; paths escaping that directory are rejected, including escapes through existing directory symlinks.
- `--auth-file` and `--codex-home` resolve relative to the process's working directory independently of `--cd`. `~` is supported in paths.

## Bundled batch examples

These commands assume the project directory is your current working directory. The input artwork is included in `examples/inputs/`, so edit examples do not require you to supply images first.

| File                                                     | Jobs | What it demonstrates                                                                      |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| [jobs.jsonl](../examples/jobs.jsonl)                     | 2    | A small generation starter batch.                                                         |
| [generate.jsonl](../examples/generate.jsonl)             | 4    | Scene illustrations, product imagery, nested output paths, PNG and WebP.                  |
| [icons.jsonl](../examples/icons.jsonl)                   | 3    | A related set of fantasy inventory icons with matching prompt wording.                    |
| [edit.jsonl](../examples/edit.jsonl)                     | 3    | Explicit and inferred edit modes using bundled inputs.                                    |
| [multi-image.jsonl](../examples/multi-image.jsonl)       | 2    | Palette references and combining content from multiple images.                            |
| [mixed.jsonl](../examples/mixed.jsonl)                   | 3    | Generation and editing in one batch.                                                      |
| [prompts-only.jsonl](../examples/prompts-only.jsonl)     | 3    | Bare JSON string prompts with automatic output filenames.                                 |
| [error-recovery.jsonl](../examples/error-recovery.jsonl) | 4    | Two valid jobs and two deliberately invalid jobs for continuation and fail-fast behavior. |

Preview requests without reading credentials or consuming image usage:

```bash
codex-imagen batch --input examples/generate.jsonl --out-dir output/generate --aspect-ratio 16:9 --dry-run
codex-imagen batch --input examples/icons.jsonl --out-dir output/icons --aspect-ratio 1:1 --dry-run
codex-imagen batch --input examples/edit.jsonl --out-dir output/edit --dry-run
codex-imagen batch --input examples/multi-image.jsonl --out-dir output/references --dry-run
codex-imagen batch --input examples/mixed.jsonl --out-dir output/mixed --dry-run
codex-imagen batch --input examples/prompts-only.jsonl --out-dir output/prompts --dry-run
```

Remove `--dry-run` to send real requests. `--n 2` applies to every valid job: four valid jobs produce eight sequential image requests. Prompt wording can encourage visual consistency across jobs, but the jobs do not share conversation state.

The error-recovery example intentionally exits with status 1:

```bash
# Expected: 2 succeeded, 2 failed; both valid jobs are planned.
codex-imagen batch --input examples/error-recovery.jsonl --out-dir output/recovery --dry-run

# Expected: 1 succeeded, 1 failed; stop at the invalid second line.
codex-imagen batch --input examples/error-recovery.jsonl --out-dir output/recovery --dry-run --fail-fast
```

## Complete CLI options

### Prompt and command-specific options

| Option               | Commands           | Default / requirement                  | Description                                                                                        |
| -------------------- | ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--prompt TEXT`      | `generate`, `edit` | Required unless an alternative applies | Inline prompt. Mutually exclusive with `--prompt-file`. Optional for an edit with `--style-image`. |
| `--prompt-file PATH` | `generate`, `edit` | Unset                                  | Read a UTF-8 prompt file.                                                                          |
| `--out PATH`         | `generate`, `edit` | Required                               | Output path.                                                                                       |
| `--image PATH`       | `edit`             | At least one                           | Repeat for multiple input images. At most five total images, including a style image.              |
| `--style-image PATH` | `edit`             | Unset                                  | Add a final style-only reference image.                                                            |
| `--input PATH`       | `batch`            | Required                               | JSONL input file.                                                                                  |
| `--out-dir DIR`      | `batch`            | Required                               | Root output directory for batch jobs.                                                              |
| `--fail-fast`        | `batch`            | Off                                    | Stop after the first failed job.                                                                   |

### Image and output options

These options apply to `generate`, `edit`, and `batch`:

| Option                       | Default | Allowed values / behavior                                                                                |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `--n COUNT`                  | `1`     | Positive integer. Runs one request per output image.                                                     |
| `--quality VALUE`            | `auto`  | `auto`, `low`, `medium`, `high`. Passed to the backend.                                                  |
| `--background VALUE`         | `auto`  | `auto`, `opaque`. Explicit `transparent` is rejected in this upstream-compatible version.                |
| `--aspect-ratio W:H`         | Unset   | Ratio between `1:3` and `3:1`. Adds prompt guidance and validates the returned ratio with 2% tolerance.  |
| `--size VALUE`               | `auto`  | `auto` or `WIDTHxHEIGHT`. An explicit size other than `auto` cannot be combined with `--aspect-ratio`.   |
| `--size-policy VALUE`        | `warn`  | `warn` saves backend dimensions with a warning; `error` refuses to save a mismatched result.             |
| `--output-format VALUE`      | `auto`  | `auto`, `png`, `webp`. `auto` chooses WebP for a `.webp` suffix and PNG otherwise.                       |
| `--webp-quality VALUE`       | `85`    | Integer from `1` to `100`; used for WebP output.                                                         |
| `--input-max-edge PIXELS`    | `1536`  | Non-negative integer. Longest input edge after local resizing; `0` disables resizing. Relevant to edits. |
| `--input-webp-quality VALUE` | `90`    | Integer from `1` to `100`; used when encoding edit inputs.                                               |
| `--force`                    | Off     | Allow replacing existing output files. Validation or conversion failures preserve the original file.     |

Explicit dimensions must be multiples of 16, at most 3840 pixels per edge, have an aspect ratio between `1:3` and `3:1`, and contain 655,360 to 8,294,400 pixels. These are request validation rules, **not a guarantee of the returned resolution**. The client does not resize or crop generated output to hide a mismatch. Rejecting a result after generation may still consume usage.

PNG and WebP are the only supported output formats. For example, a `.jpg` suffix with `--output-format auto` still writes PNG bytes; use an appropriate extension.

### Backend, authentication, and execution options

| Option                    | Default                                                              | Description                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--backend VALUE`         | `native`                                                             | `native` or `responses`.                                                                                                          |
| `--model MODEL`           | See precedence below                                                 | Responses reasoning model only; does not select the image generator.                                                              |
| `--reasoning-model MODEL` | Unset                                                                | Alias for `--model`; do not pass both.                                                                                            |
| `--profile NAME`          | Codex configured profile                                             | Responses-only Codex profile for reasoning-model selection.                                                                       |
| `--base-url URL`          | `CODEX_IMAGEGEN_BASE_URL` or `https://chatgpt.com/backend-api/codex` | Backend root URL. It receives your account token. HTTPS is required except for local loopback test servers.                       |
| `--auth-file PATH`        | `<codex-home>/auth.json`                                             | Explicit file-based Codex ChatGPT credentials.                                                                                    |
| `--codex-home PATH`       | `CODEX_HOME` or `~/.codex`                                           | Directory containing Codex configuration and default credentials.                                                                 |
| `--no-refresh`            | Off                                                                  | Disable credential refresh and writes.                                                                                            |
| `--cd DIR`                | Current working directory                                            | Base directory for prompts, image inputs, batch input, and output paths.                                                          |
| `--timeout SECONDS`       | `300`                                                                | Per-request deadline including response reading. Must be greater than zero and no more than 86,400.                               |
| `--dry-run`               | Off                                                                  | Print redacted request plans. Does not read credentials or contact the backend; edit inputs are still read and validated locally. |
| `--help`, `-h`            | N/A                                                                  | Print command usage.                                                                                                              |
| `--version`, `-v`         | N/A                                                                  | Print the package version.                                                                                                        |

Normal stdout contains one absolute path per saved image. Progress and errors go to stderr. Dry-run stdout contains pretty-printed JSON request plans; a batch prints one plan per valid job. Exit codes are `0` for success, `1` for validation or request failure, and `130` for interruption during execution.

### What does `--quality` control?

The client passes `auto`, `low`, `medium`, or `high` to the backend. Keep the default `auto` unless you have a reason to override it. Quality is separate from output dimensions and from local WebP compression.

The official Codex client defines all four values in its [image request types](https://github.com/openai/codex/blob/c15d0ce323f2197da865871502dc6ea7ef5b8ddb/codex-rs/codex-api/src/images.rs#L42-L49), while its [built-in image tool](https://github.com/openai/codex/blob/c15d0ce323f2197da865871502dc6ea7ef5b8ddb/codex-rs/ext/image-generation/src/tool.rs) sends `quality: auto` for generation and editing. This CLI lets you override that field directly. Those client definitions do not establish a public guarantee about how the Codex service renders each setting.

The public [OpenAI image-generation API](https://developers.openai.com/api/docs/guides/image-generation) documents quality settings, but this package uses authenticated Codex endpoints. Do not assume identical server behavior. A small visual comparison cannot establish whether the Codex service honors or ignores a setting.

## Backend behavior and environment variables

The default native backend calls `/images/generations` and `/images/edits`. The alternative `--backend responses` calls `/responses` and forces the hosted `image_generation` tool. There is no automatic fallback between backends.

Responses reasoning-model precedence is: explicit `--model` or `--reasoning-model`, `CODEX_IMAGEGEN_MODEL`, the selected Codex profile, the top-level Codex model, then the upstream fallback `gpt-5.5`. An explicit `--profile` overrides the profile selected in `config.toml`. `--model` and `--profile` are rejected with the native backend.

The native request field `model: "gpt-image-2"` follows the upstream request shape and does not verify the actual image model used by the service. Account eligibility, usage limits, and final image dimensions are controlled by the backend.

| Environment variable                 | Purpose                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `CODEX_HOME`                         | Default Codex configuration and credential directory.                             |
| `CODEX_IMAGEGEN_BASE_URL`            | Default backend root URL.                                                         |
| `CODEX_IMAGEGEN_MODEL`               | Responses reasoning-model override.                                               |
| `CODEX_IMAGEGEN_CODEX_VERSION`       | Override the Codex version reported in request headers; useful for offline tests. |
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | Override the request originator; defaults to `codex_cli_rs`.                      |
| `CODEX_IMAGEGEN_REFRESH_URL`         | Development/testing override for the token refresh endpoint.                      |

Rate limits receive at most four retries with bounded delays. Transport interruptions and ambiguous server failures are not replayed automatically because generation may already have started.

## JavaScript and TypeScript API

After installing the package into your project:

```ts
import { CodexImageClient } from "codex-imagen";

const client = new CodexImageClient(
  { aspectRatio: "16:9", quality: "low" },
  { log: console.error, onSaved: (image) => console.log(image.path) },
);

const images = await client.generate(
  "A watercolor lighthouse",
  "output/lighthouse.png",
);
await client.edit(
  "Change the scene to sunset",
  [images[0].path],
  "output/sunset.webp",
);
const batch = await client.batch("examples/jobs.jsonl", "output/batch");
```

The library also exposes `client.run(job)` and optional `onPlan`, `onSaved`, and `log` hooks. It is silent by default. Pass an `AbortSignal` in client options to cancel requests and rate-limit waits. `client.batch()` returns success/failure counts, completed image results, and per-line errors; `failFast` is its optional third argument.

## Development and packaging

```bash
npm test
npm run check
npm run format:check
npm pack --dry-run
npm pack
```

Offline tests use synthetic credentials and loopback HTTP servers. They do not access your real Codex account or consume image usage. Coverage includes generation, edits, reference ordering, WebP, partial progress, batch error isolation, output confinement, SSE chunking, concurrent token refresh, external credential changes, token redaction, rate limits, timeouts, and CLI exit codes. Bundled JSONL examples are validated through the client's dry-run path.

Real requests require account access and consume usage. Keep private inputs and generated output outside the npm package; `output/` and `artifacts/` are git-ignored and excluded from the package allowlist.

This client depends on Codex internal endpoints, which can change independently of this package. It does not provide a stable public OpenAI Images API contract.
