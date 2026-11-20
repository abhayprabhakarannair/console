import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("build ships every module the page needs, with a versioned mqtt bundle", async () => {
  const out = await mkdtemp(join(tmpdir(), "console-build-"));
  try {
    await run(process.execPath, ["scripts/build.mjs"], { env: { ...process.env, CONSOLE_OUT: `${out}/` } });
    const html = await readFile(join(out, "index.html"), "utf8");
    const { version } = JSON.parse(await readFile("node_modules/mqtt/package.json", "utf8"));
    assert.ok(!html.includes("{{"), "placeholder left in index.html");
    assert.ok(html.includes(`src="vendor/mqtt-${version}.min.js"`));
    assert.deepEqual(await readdir(join(out, "vendor")), [`mqtt-${version}.min.js`]);

    const files = new Set(await readdir(out));
    const referenced = [...html.matchAll(/(?:src|href)="([^":]+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith("vendor/"));
    for (const f of referenced.filter((f) => f !== "config.js")) assert.ok(files.has(f), `${f} is referenced but not built`);

    const preloaded = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]).sort();
    const modules = [...files].filter((f) => f.endsWith(".js")).sort();
    assert.deepEqual(preloaded, modules, "every module is preloaded so the graph loads in parallel");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
