import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const out = new URL(process.env.CONSOLE_OUT ?? "dist/", root);
const { version } = JSON.parse(await readFile(new URL("node_modules/mqtt/package.json", root), "utf8"));
const vendor = `vendor/mqtt-${version}.min.js`;

await rm(out, { recursive: true, force: true });
await mkdir(new URL("vendor/", out), { recursive: true });
await cp(new URL("src/", root), out, { recursive: true });
await cp(new URL("node_modules/mqtt/dist/mqtt.min.js", root), new URL(vendor, out));

const html = await readFile(new URL("index.html", out), "utf8");
if (!html.includes("{{MQTT}}")) throw new Error("index.html has no {{MQTT}} placeholder");
await writeFile(new URL("index.html", out), html.replaceAll("{{MQTT}}", vendor));
