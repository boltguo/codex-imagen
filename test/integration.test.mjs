import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
  symlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
import {
  CodexImageClient,
  HttpError,
  ImageResponseError,
} from "../dist/index.js";
import { retryDecision } from "../dist/transport.js";
import { resolveOptions } from "../dist/options.js";
import { atomicWrite } from "../dist/files.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
process.env.CODEX_IMAGEGEN_CODEX_VERSION = "0.154.0";
delete process.env.CODEX_IMAGEGEN_MODEL;
delete process.env.CODEX_IMAGEGEN_BASE_URL;
delete process.env.CODEX_IMAGEGEN_REFRESH_URL;
const jwt = (payload) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
const future = () => jwt({ exp: Date.now() / 1000 + 3600 });
const fakeAuth = (access = future()) => ({
  auth_mode: "chatgpt",
  tokens: {
    access_token: access,
    refresh_token: "fake-refresh",
    id_token: jwt({ email: "test@example.invalid" }),
    account_id: "fake-account",
  },
});
const png = await sharp({
  create: { width: 32, height: 24, channels: 3, background: "blue" },
})
  .png()
  .toBuffer();
const encoded = png.toString("base64");
const jsonImage = (response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
};

async function fixture(
  t,
  handler = (_request, response) => jsonImage(response),
) {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "codex-imagen-test-")),
  );
  const authFile = path.join(dir, "auth.json");
  await writeFile(authFile, JSON.stringify(fakeAuth()), { mode: 0o600 });
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const chunk of request) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push({ url: request.url, headers: request.headers, body });
      await handler(
        { url: request.url, headers: request.headers, body },
        response,
        requests.length,
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    authFile,
    baseUrl,
    requests,
    options: { cd: dir, codexHome: dir, authFile, baseUrl, timeout: 5 },
  };
}

test("native generate sends Codex auth and produces a fully decoded PNG", async (t) => {
  const f = await fixture(t);
  const published = [];
  const client = new CodexImageClient(f.options, {
    onSaved: (image) => published.push(image),
  });
  const result = await client.generate("A blue circle", "out.png");
  assert.equal(result.length, 1);
  assert.equal(published.length, 1);
  assert.deepEqual(await readFile(result[0].path), png);
  assert.deepEqual(
    [result[0].width, result[0].height, result[0].format],
    [32, 24, "png"],
  );
  assert.equal(f.requests[0].url, "/images/generations");
  assert.equal(f.requests[0].headers["chatgpt-account-id"], "fake-account");
  assert.match(f.requests[0].headers.authorization, /^Bearer /);
  assert.equal(f.requests[0].body.model, "gpt-image-2");
});

test("dry-run never reads auth or sends HTTP; image data is redacted", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.dir, "source.png");
  await writeFile(source, png);
  const plans = [];
  const client = new CodexImageClient(
    {
      ...f.options,
      authFile: path.join(f.dir, "missing-auth.json"),
      dryRun: true,
      aspectRatio: "16:9",
      n: 2,
    },
    { onPlan: (plan) => plans.push(plan) },
  );
  assert.deepEqual(await client.edit("Make it red", [source], "out.webp"), []);
  assert.equal(f.requests.length, 0);
  assert.equal(plans[0].outputs.length, 2);
  assert.equal(plans[0].headers.Authorization, "Bearer <redacted>");
  assert.match(plans[0].payload.images[0].image_url, /base64,<redacted>$/);
  assert.match(
    plans[0].payload.prompt,
    /^The frame must have an aspect ratio of 16:9/,
  );
  assert.equal(plans[0].payload.size, "auto");
});

test("edit compacts and auto-orients input; style reference stays last; saves WebP", async (t) => {
  const f = await fixture(t);
  await sharp({
    create: { width: 60, height: 30, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(path.join(f.dir, "source.jpg"));
  await writeFile(path.join(f.dir, "style.png"), png);
  const client = new CodexImageClient({ ...f.options, inputMaxEdge: 40 });
  const result = await client.edit(
    "",
    ["source.jpg"],
    "edited.webp",
    "style.png",
  );
  assert.equal(f.requests[0].url, "/images/edits");
  assert.match(
    f.requests[0].body.prompt,
    /final input image only as a style reference/,
  );
  const images = f.requests[0].body.images;
  assert.equal(images.length, 2);
  const compacted = await sharp(
    Buffer.from(images[0].image_url.split(",")[1], "base64"),
  ).metadata();
  assert.deepEqual(
    [compacted.width, compacted.height, compacted.format],
    [20, 40, "webp"],
  );
  assert.equal((await sharp(result[0].path).metadata()).format, "webp");
});

test("multiple outputs are sequential and publish progress before a later transport failure", async (t) => {
  const f = await fixture(t, (_request, response, count) =>
    count === 2 ? response.destroy() : jsonImage(response),
  );
  const saved = [];
  const client = new CodexImageClient(
    { ...f.options, n: 3 },
    { onSaved: (image) => saved.push(image.path) },
  );
  await assert.rejects(client.generate("test", "out.png"), /not retried/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(saved, [path.join(f.dir, "out-1.png")]);
  await assert.rejects(stat(path.join(f.dir, "out-2.png")), { code: "ENOENT" });
});

test("existing output is protected before any request", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, "out.png"), "existing");
  await assert.rejects(
    new CodexImageClient(f.options).generate("test", "out.png"),
    /already exists/,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(path.join(f.dir, "out.png"), "utf8"), "existing");
});

test("strict dimension or ratio mismatch preserves existing output even with force", async (t) => {
  const f = await fixture(t);
  const out = path.join(f.dir, "out.png");
  await writeFile(out, "original");
  for (const framing of [{ size: "1024x1024" }, { aspectRatio: "16:9" }]) {
    await assert.rejects(
      new CodexImageClient({
        ...f.options,
        ...framing,
        force: true,
        sizePolicy: "error",
      }).generate("test", out),
      /Output was not written/,
    );
    assert.equal(await readFile(out, "utf8"), "original");
  }
});

test("warn size policy keeps backend dimensions without resizing", async (t) => {
  const f = await fixture(t);
  const logs = [];
  const result = await new CodexImageClient(
    { ...f.options, size: "1024x1024" },
    { log: (message) => logs.push(message) },
  ).generate("test", "out.png");
  assert.deepEqual([result[0].width, result[0].height], [32, 24]);
  assert.ok(logs.some((line) => line.includes("backend returned 32x24")));
});

test("invalid PNG pixels and malformed base64 never replace an existing file", async (t) => {
  let value;
  const f = await fixture(t, (_request, response) =>
    response.end(JSON.stringify({ data: [{ b64_json: value }] })),
  );
  const out = path.join(f.dir, "out.png");
  await writeFile(out, "original");
  for (const invalid of [
    "%%%=",
    png.subarray(0, 50).toString("base64"),
    Buffer.from("not png").toString("base64"),
  ]) {
    value = invalid;
    await assert.rejects(
      new CodexImageClient({ ...f.options, force: true }).generate("test", out),
    );
    assert.equal(await readFile(out, "utf8"), "original");
  }
  assert.equal(
    (await readdir(f.dir)).filter((file) => file.endsWith(".tmp")).length,
    0,
  );
});

test("batch isolates malformed JSON/schema/backend failures and rejects output traversal", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.dir, "jobs.jsonl"),
    [
      "# comment",
      JSON.stringify({ prompt: "first", out: "a.png" }),
      "{broken json",
      JSON.stringify({ prompt: 123 }),
      JSON.stringify({ prompt: "escape", out: "../escape.png" }),
      JSON.stringify({ prompt: "bad edit", mode: "edit", images: [] }),
      JSON.stringify({ prompt: "last", out: "b.webp" }),
    ].join("\n"),
  );
  const result = await new CodexImageClient(f.options).batch(
    "jobs.jsonl",
    "batch",
  );
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 4);
  assert.deepEqual(
    result.errors.map((error) => error.line),
    [3, 4, 5, 6],
  );
  assert.equal(f.requests.length, 2);
  assert.equal(result.images.length, 2);
  await assert.rejects(stat(path.join(f.dir, "escape.png")), {
    code: "ENOENT",
  });
});

test("batch fail-fast stops at the first bad line", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, "jobs.jsonl"), '{invalid\n"valid"\n');
  const result = await new CodexImageClient(f.options).batch(
    "jobs.jsonl",
    "batch",
    true,
  );
  assert.deepEqual(
    [result.succeeded, result.failed, f.requests.length],
    [0, 1, 0],
  );
});

test("batch also confines output through directory symlinks", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.dir, "batch"));
  await mkdir(path.join(f.dir, "outside"));
  await symlink(
    path.join(f.dir, "outside"),
    path.join(f.dir, "batch", "escape"),
    "dir",
  );
  await writeFile(
    path.join(f.dir, "jobs.jsonl"),
    JSON.stringify({ prompt: "test", out: "escape/out.png" }),
  );
  const result = await new CodexImageClient(f.options).batch(
    "jobs.jsonl",
    "batch",
  );
  assert.equal(result.failed, 1);
  assert.equal(f.requests.length, 0);
});

test("batch supports edit jobs and prompt strings, resolving inputs under --cd", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, "source.png"), png);
  await writeFile(
    path.join(f.dir, "jobs.jsonl"),
    [
      JSON.stringify({
        prompt: "edit",
        images: ["source.png"],
        out: "edit.png",
      }),
      JSON.stringify("generate"),
    ].join("\n"),
  );
  const result = await new CodexImageClient(f.options).batch(
    "jobs.jsonl",
    "batch",
  );
  assert.equal(result.succeeded, 2);
  assert.deepEqual(
    f.requests.map((request) => request.url),
    ["/images/edits", "/images/generations"],
  );
});

test("Responses parser handles split UTF-8/CRLF and terminal response results", async (t) => {
  const f = await fixture(t, async (_request, response) => {
    response.setHeader("content-type", "text/event-stream");
    const unicodeText = "\u56fe\u7247";
    const first = Buffer.from(
      `data: ${JSON.stringify({ type: "response.created", text: unicodeText })}\r\n\r\n`,
    );
    const split = first.indexOf(Buffer.from(unicodeText[0])) + 1;
    response.write(first.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.write(first.subarray(split, first.length - 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.write(first.subarray(first.length - 1));
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "image_generation_call", status: "completed", result: encoded }] } })}\r\n\r\n`,
    );
  });
  const result = await new CodexImageClient({
    ...f.options,
    backend: "responses",
    model: "test-model",
  }).generate("test", "out.png");
  assert.equal(result.length, 1);
  assert.equal(f.requests[0].url, "/responses");
  assert.equal(f.requests[0].body.model, "test-model");
  assert.deepEqual(f.requests[0].body.tool_choice, {
    type: "image_generation",
  });
});

test("Responses model reads proper TOML profile settings", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.dir, "config.toml"),
    'model = "top"\nprofile = "work"\n[profiles.work]\nmodel = "profile-model" # comment\n',
  );
  const plans = [];
  await new CodexImageClient(
    { ...f.options, backend: "responses", dryRun: true },
    { onPlan: (plan) => plans.push(plan) },
  ).generate("test", "out.png");
  assert.equal(plans[0].payload.model, "profile-model");
  assert.equal(f.requests.length, 0);
});

test("credential refresh is serialized, preserves JWT strings and writes restricted permissions", async (t) => {
  let refreshes = 0;
  const refreshedToken = future();
  const f = await fixture(t, (request, response) => {
    if (request.url === "/oauth/token") {
      refreshes++;
      assert.equal(request.body.refresh_token, "fake-refresh");
      response.end(
        JSON.stringify({
          access_token: refreshedToken,
          refresh_token: "new-fake-refresh",
        }),
      );
    } else jsonImage(response);
  });
  const original = fakeAuth(jwt({ exp: 1 }));
  await writeFile(f.authFile, JSON.stringify(original));
  process.env.CODEX_IMAGEGEN_REFRESH_URL = `${f.baseUrl}/oauth/token`;
  t.after(() => delete process.env.CODEX_IMAGEGEN_REFRESH_URL);
  await Promise.all([
    new CodexImageClient(f.options).generate("a", "a.png"),
    new CodexImageClient(f.options).generate("b", "b.png"),
  ]);
  assert.equal(refreshes, 1);
  const current = JSON.parse(await readFile(f.authFile, "utf8"));
  assert.equal(current.tokens.id_token, original.tokens.id_token);
  assert.equal(current.tokens.access_token, refreshedToken);
  if (process.platform !== "win32")
    assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
});

test("refresh refuses to overwrite credentials changed by another application", async (t) => {
  let f;
  const external = fakeAuth(future());
  external.external = true;
  f = await fixture(t, async (request, response) => {
    if (request.url === "/oauth/token") {
      await writeFile(f.authFile, JSON.stringify(external));
      response.end(JSON.stringify({ access_token: future() }));
    } else jsonImage(response);
  });
  await writeFile(f.authFile, JSON.stringify(fakeAuth(jwt({ exp: 1 }))));
  process.env.CODEX_IMAGEGEN_REFRESH_URL = `${f.baseUrl}/oauth/token`;
  t.after(() => delete process.env.CODEX_IMAGEGEN_REFRESH_URL);
  await assert.rejects(
    new CodexImageClient(f.options).generate("test", "out.png"),
    /refusing to overwrite/,
  );
  assert.deepEqual(JSON.parse(await readFile(f.authFile, "utf8")), external);
});

test("--no-refresh leaves expired credentials untouched and sends no request", async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify(fakeAuth(jwt({ exp: 1 })));
  await writeFile(f.authFile, original);
  await assert.rejects(
    new CodexImageClient({ ...f.options, refresh: false }).generate(
      "test",
      "out.png",
    ),
    /no-refresh/,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(f.authFile, "utf8"), original);
});

test("native 401 refresh and subsequent 429 share the retry loop", async (t) => {
  let nativeCalls = 0;
  const f = await fixture(t, (request, response) => {
    if (request.url === "/oauth/token")
      return response.end(JSON.stringify({ access_token: future() }));
    nativeCalls++;
    if (nativeCalls === 1) {
      response.statusCode = 401;
      return response.end("{}");
    }
    if (nativeCalls === 2) {
      response.statusCode = 429;
      return response.end(
        JSON.stringify({
          error: { code: "rate_limit_exceeded", message: "try again in 1ms" },
        }),
      );
    }
    jsonImage(response);
  });
  process.env.CODEX_IMAGEGEN_REFRESH_URL = `${f.baseUrl}/oauth/token`;
  t.after(() => delete process.env.CODEX_IMAGEGEN_REFRESH_URL);
  const result = await new CodexImageClient(f.options).generate(
    "test",
    "out.png",
  );
  assert.equal(nativeCalls, 3);
  assert.equal(result.length, 1);
});

test("ambiguous HTTP 500 is never replayed", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.statusCode = 500;
    response.end("failure");
  });
  await assert.rejects(
    new CodexImageClient(f.options).generate("test", "out.png"),
    /HTTP 500/,
  );
  assert.equal(f.requests.length, 1);
});

test("cross-host redirects are not followed with credentials", async (t) => {
  let f;
  f = await fixture(t, (_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `${f.baseUrl}/redirected`);
    response.end();
  });
  await assert.rejects(
    new CodexImageClient(f.options).generate("test", "out.png"),
    /Network request failed/,
  );
  assert.equal(f.requests.length, 1);
});

test("request deadline covers stalled response bodies", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await assert.rejects(
    new CodexImageClient({ ...f.options, timeout: 0.1 }).generate(
      "test",
      "out.png",
    ),
    /complete JSON response|timed out/,
  );
  assert.equal(f.requests.length, 1);
});

test("retry decisions cap delays and refuse quota failures", () => {
  assert.equal(retryDecision(new HttpError(429, "{}", "301"), 0), undefined);
  assert.equal(
    retryDecision(new HttpError(429, "{}", "Infinity"), 0),
    undefined,
  );
  assert.equal(
    retryDecision(
      new HttpError(429, '{"error":{"type":"insufficient_quota"}}'),
      0,
    ),
    undefined,
  );
  assert.equal(retryDecision(new HttpError(500, "{}"), 0), undefined);
  assert.equal(
    retryDecision(
      new ImageResponseError({
        code: "rate_limit_exceeded",
        message: "input-images per min Used 5 Limit 5",
      }),
      1,
    ).delay,
    130,
  );
  assert.equal(retryDecision(new HttpError(429, "{}", "2"), 0).delay, 2);
});

test("invalid options are rejected before auth or HTTP", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { size: "32x32" },
    { size: "1024x1024", aspectRatio: "16:9" },
    { aspectRatio: "4:1" },
    { n: 0 },
    { n: 1.5 },
    { timeout: NaN },
    { timeout: Infinity },
    { inputMaxEdge: -1 },
    { background: "transparent" },
    { model: "model" },
    { outputFormat: "jpeg" },
    { baseUrl: "http://example.com" },
    { baseUrl: "https://user:secret@example.com" },
  ])
    await assert.rejects(resolveOptions({ ...f.options, ...options }));
  assert.equal(f.requests.length, 0);
});

test("atomic no-clobber publication protects a competing output", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "race.png");
  const results = await Promise.allSettled([
    atomicWrite(file, Buffer.from("a"), false),
    atomicWrite(file, Buffer.from("b"), false),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    (await readdir(f.dir)).filter((file) => file.endsWith(".tmp")).length,
    0,
  );
});

test("CLI generates and edits through HTTP, with paths on stdout and progress on stderr", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, CODEX_HOME: f.dir };
  const shared = ["--base-url", f.baseUrl, "--cd", f.dir, "--no-refresh"];
  const generated = await exec(
    process.execPath,
    [cli, "generate", "--prompt", "test", "--out", "first.png", ...shared],
    { env },
  );
  assert.equal(generated.stdout.trim(), path.join(f.dir, "first.png"));
  assert.match(generated.stderr, /Saved 32x24 PNG/);
  const edited = await exec(
    process.execPath,
    [
      cli,
      "edit",
      "--prompt",
      "make it red",
      "--image",
      "first.png",
      "--out",
      "edited.webp",
      ...shared,
    ],
    { env },
  );
  assert.equal(edited.stdout.trim(), path.join(f.dir, "edited.webp"));
  assert.deepEqual(
    f.requests.map((request) => request.url),
    ["/images/generations", "/images/edits"],
  );
});

test("CLI batch returns status 1 while preserving successful jobs", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, "jobs.jsonl"), '"first"\n{broken\n"last"\n');
  try {
    await exec(
      process.execPath,
      [
        cli,
        "batch",
        "--input",
        "jobs.jsonl",
        "--out-dir",
        "batch",
        "--base-url",
        f.baseUrl,
        "--cd",
        f.dir,
        "--no-refresh",
      ],
      { env: { ...process.env, CODEX_HOME: f.dir } },
    );
    assert.fail("batch should return exit status 1");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.stdout.trim().split("\n").length, 2);
    assert.match(error.stderr, /2 succeeded, 1 failed/);
  }
  assert.equal(f.requests.length, 2);
});

test("backend errors redact echoed access tokens in both HTTP and SSE responses", async (t) => {
  const f = await fixture(t, (request, response) => {
    const message = `Rejected ${request.headers.authorization}`;
    if (request.url === "/responses") {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ type: "error", error: { message } })}\n\n`,
      );
    } else {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: { message } }));
    }
  });
  const token = JSON.parse(await readFile(f.authFile, "utf8")).tokens
    .access_token;
  for (const backend of ["native", "responses"]) {
    await assert.rejects(
      new CodexImageClient({
        ...f.options,
        backend,
        ...(backend === "responses" ? { model: "test-model" } : {}),
      }).generate("test", `${backend}.png`),
      (error) => {
        assert.ok(!error.message.includes(token));
        assert.match(error.message, /<redacted>/);
        return true;
      },
    );
  }
});

test("bundled JSONL examples validate without auth or network, including edit inputs", async (t) => {
  const f = await fixture(t);
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const cases = [
    ["jobs.jsonl", 2, 0],
    ["generate.jsonl", 4, 0],
    ["icons.jsonl", 3, 0],
    ["edit.jsonl", 3, 0],
    ["multi-image.jsonl", 2, 0],
    ["mixed.jsonl", 3, 0],
    ["prompts-only.jsonl", 3, 0],
    ["error-recovery.jsonl", 2, 2],
  ];
  for (const [name, succeeded, failed] of cases) {
    const plans = [];
    const client = new CodexImageClient(
      {
        ...f.options,
        cd: projectRoot,
        authFile: path.join(f.dir, "missing-auth.json"),
        dryRun: true,
      },
      { onPlan: (plan) => plans.push(plan) },
    );
    const result = await client.batch(
      `examples/${name}`,
      path.join(f.dir, name),
    );
    assert.deepEqual(
      [result.succeeded, result.failed],
      [succeeded, failed],
      name,
    );
    assert.equal(plans.length, succeeded, name);
    for (const plan of plans) {
      assert.equal(plan.headers.Authorization, "Bearer <redacted>");
      if (plan.payload.images) {
        for (const image of plan.payload.images) {
          assert.equal(image.image_url, "data:image/webp;base64,<redacted>");
        }
      }
    }
  }
  const failFast = await new CodexImageClient({
    ...f.options,
    cd: projectRoot,
    dryRun: true,
  }).batch(
    "examples/error-recovery.jsonl",
    path.join(f.dir, "fail-fast"),
    true,
  );
  assert.deepEqual([failFast.succeeded, failFast.failed], [1, 1]);
  assert.equal(f.requests.length, 0);
});

test("CLI help/version need no login and invalid options fail clearly", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, CODEX_HOME: path.join(f.dir, "missing") };
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    (await exec(process.execPath, [cli, "--version"], { env })).stdout.trim(),
    `codex-imagen ${version}`,
  );
  assert.match(
    (await exec(process.execPath, [cli, "--help"], { env })).stdout,
    /generate/,
  );
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "generate", "--prompt", "test", "--out", "out.png", "--n", "oops"],
      { env },
    ),
    (error) =>
      error.code === 1 && error.stderr.includes("--n must be an integer"),
  );
});
