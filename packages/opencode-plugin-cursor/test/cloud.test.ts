import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ToolContext } from "@opencode-ai/plugin";

import { cursorApiRequest } from "../src/lib/cursorApi.js";
import { createCloudTools } from "../src/tools/cloud.js";

type Seen = { method?: string; url?: string; authorization?: string; body: string };

describe("Cursor Cloud Agents client", () => {
  const saved = { ...process.env };
  const seen: Seen[] = [];
  let server: http.Server;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
        if (req.url === "/v0/me" && req.headers.authorization === "Bearer bad") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.CURSOR_API_BASE_URL = `http://127.0.0.1:${address.port}/`;
  });

  after(async () => {
    process.env = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("authenticates from the environment with Basic auth by default", async () => {
    process.env.CURSOR_API_KEY = "key_123";
    delete process.env.CURSOR_API_AUTH_STYLE;
    const data = await cursorApiRequest<{ path: string }>({ method: "GET", path: "/v0/me" });
    assert.equal(data.path, "/v0/me");
    assert.equal(seen.at(-1)?.authorization, `Basic ${Buffer.from("key_123:").toString("base64")}`);
  });

  it("supports bearer auth and reports HTTP failures", async () => {
    process.env.CURSOR_API_KEY = "bad";
    process.env.CURSOR_API_AUTH_STYLE = "bearer";
    await assert.rejects(cursorApiRequest({ method: "GET", path: "/v0/me" }), /401 .*check CURSOR_API_KEY/);
  });

  it("requires CURSOR_API_KEY", async () => {
    delete process.env.CURSOR_API_KEY;
    await assert.rejects(cursorApiRequest({ method: "GET", path: "/v0/me" }), /CURSOR_API_KEY/);
  });

  it("does not let the model choose credentials or the API host", () => {
    const tools = createCloudTools({ cwd: tmpdir() });
    for (const [name, def] of Object.entries(tools)) {
      for (const key of ["apiKey", "baseURL", "authStyle"]) assert.ok(!(key in def.args), `${name}.${key}`);
    }
  });

  it("launches agents with image attachments, rejecting non-images", async () => {
    process.env.CURSOR_API_KEY = "key_123";
    delete process.env.CURSOR_API_AUTH_STYLE;
    const dir = await mkdtemp(path.join(tmpdir(), "cloud-"));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await writeFile(path.join(dir, "shot.png"), png);
    await writeFile(path.join(dir, "secret.txt"), "not an image");
    const tools = createCloudTools({ cwd: dir });
    const ctx = { abort: new AbortController().signal, directory: dir } as unknown as ToolContext;

    await tools.cursor_cloud_launch_agent.execute(
      { prompt: "fix it", repository: "https://github.com/o/r", ref: "main", images: [{ path: "shot.png" }] },
      ctx,
    );
    const body = JSON.parse(seen.at(-1)?.body ?? "{}") as Record<string, any>;
    assert.equal(seen.at(-1)?.method, "POST");
    assert.deepEqual(body.source, { repository: "https://github.com/o/r", ref: "main" });
    assert.equal(body.prompt.images[0].data, png.toString("base64"));

    await assert.rejects(
      tools.cursor_cloud_launch_agent.execute({ prompt: "x", repository: "r", images: [{ path: "secret.txt" }] }, ctx),
      /Only PNG, JPEG, GIF and WebP/,
    );
    await assert.rejects(tools.cursor_cloud_launch_agent.execute({ prompt: "x" }, ctx), /repository is required/);
  });
});
