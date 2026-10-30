# codex-imagen

Generate, edit, and batch-process images using your existing local Codex ChatGPT login.

Requires **Node.js 22+** and a file-based Codex login. No API key is needed.

## Install

```bash
npm install -g codex-imagen
codex login
```

Credentials are read from `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.
Keyring-only logins are not supported; see the [full reference](https://unpkg.com/codex-imagen@latest/docs/reference.md) for setup.

## Generate

```bash
codex-imagen generate \
  --prompt "A watercolor lighthouse on a rocky coast" \
  --aspect-ratio 16:9 \
  --out lighthouse.png
```

You can also run it without installing globally: `npx codex-imagen generate ...`.

## Edit

```bash
codex-imagen edit \
  --image photo.png \
  --prompt "Change the scene to sunset" \
  --out sunset.webp
```

Repeat `--image` for multiple references, up to five images total.

## Batch

Create `jobs.jsonl`, with one job per line:

```jsonl
{"prompt":"A watercolor lighthouse","out":"lighthouse.png"}
{"prompt":"Change the scene to sunset","images":["photo.png"],"out":"sunset.webp"}
```

```bash
codex-imagen batch --input jobs.jsonl --out-dir output
```

Jobs run sequentially. Failed jobs are reported while later jobs continue.
Image paths are relative to the current working directory; output paths are relative to `--out-dir`.

## Options

- `--n 3`: generate three images for each prompt.
- `--prompt-file prompt.txt`: read a prompt from a file.
- `--dry-run`: preview requests without logging in or generating images.
- `--force`: replace existing output files.
- `--quality auto|low|medium|high`: pass a quality setting to the backend; defaults to `auto`.

Run `codex-imagen --help` for all flags. The [full reference](https://unpkg.com/codex-imagen@latest/docs/reference.md) covers parameters, authentication, the JavaScript/TypeScript API, and bundled JSONL examples.

## Notes

PNG and WebP output are supported. Aspect ratio and size are requests; the backend controls the final dimensions.
This package uses internal Codex endpoints, which may change. Account access and usage limits apply.

Adapted from [jdmnk/codex-imagegen-cli](https://github.com/jdmnk/codex-imagegen-cli), licensed under Apache-2.0. See `NOTICE` for attribution. Independent project, unaffiliated with OpenAI.
