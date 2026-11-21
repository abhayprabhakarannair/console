import assert from "node:assert/strict";
import { test } from "node:test";

import { ago, bytes, celsius, duration, level, percent, quality, rate, signalBars } from "../src/format.js";

test("duration", () => {
  const cases = [[0, "0s"], [59.9, "59s"], [60, "1m"], [61, "1m 1s"], [2280, "38m"], [3599, "59m 59s"], [3600, "1h"],
    [3660, "1h 1m"], [86399, "23h 59m"], [86400, "1d"], [90061, "1d 1h"], [-1, "–"], [Number.NaN, "–"], [Infinity, "–"], [undefined, "–"]];
  for (const [input, expected] of cases) assert.equal(duration(input), expected, String(input));
});

test("celsius and percent", () => {
  assert.equal(celsius(45.25), "45.3 °C");
  assert.equal(celsius(-1.5), "-1.5 °C");
  assert.equal(celsius(null), "–");
  assert.equal(percent(14.06), "14.1%");
  assert.equal(percent("14"), "–");
});

test("bytes in decimal units", () => {
  assert.deepEqual([0, 999, 1_500, 312_400_000_000, 1_000_000_000_000, -1, NaN].map(bytes),
    ["0 B", "999 B", "1.5 KB", "312 GB", "1.0 TB", "–", "–"]);
});

test("rate in decimal bits per second", () => {
  assert.deepEqual([0, 999, 1_200, 42_100_000, 150_000_000, 2.5e9, -1, NaN, "1"].map(rate),
    ["0 bit/s", "999 bit/s", "1.2 kbit/s", "42.1 Mbit/s", "150 Mbit/s", "2.5 Gbit/s", "–", "–", "–"]);
});

test("ago rounds down and never goes negative", () => {
  assert.deepEqual([0, 59.9, 60, 3599, 3600, 86400, -5, NaN].map(ago),
    ["0s ago", "59s ago", "1m ago", "59m ago", "1h ago", "1d ago", "0s ago", "–"]);
});

test("level against warn and crit thresholds", () => {
  assert.deepEqual([79.9, 80, 89.9, 90, null].map((v) => level(v, 80, 90)), ["ok", "warn", "warn", "crit", "ok"]);
});

test("signal bars from dBm", () => {
  assert.deepEqual([-40, -55, -56, -65, -66, -75, -76, -95, null].map(signalBars), [4, 4, 3, 3, 2, 2, 1, 1, 0]);
});

test("quality", () => {
  assert.equal(quality(2.14, 18.6), "2.1% loss · 19 ms");
  assert.equal(quality(0, undefined), "0.0% loss");
  assert.equal(quality(undefined, 40), "40 ms");
  assert.equal(quality(-1, Number.NaN), null);
  assert.equal(quality("5", null), null);
});
