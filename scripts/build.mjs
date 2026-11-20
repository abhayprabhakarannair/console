import { cp, mkdir, rm } from "node:fs/promises";

const out = new URL("../dist/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(new URL("vendor/", out), { recursive: true });
await cp(new URL("../src/", import.meta.url), out, { recursive: true });
await cp(new URL("../node_modules/mqtt/dist/mqtt.min.js", import.meta.url), new URL("vendor/mqtt.min.js", out));
