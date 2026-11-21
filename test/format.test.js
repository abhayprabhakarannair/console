import assert from "node:assert/strict";
import { test } from "node:test";

import { bytes, celsius, duration, percent } from "../src/format.js";

test("duration", () => {
  const cases = [[0, "0s"], [59.9, "59s"], [60, "1m 0s"], [3599, "59m 59s"], [3600, "1h 0m"], [86399, "23h 59m"],
    [86400, "1d 0h"], [90061, "1d 1h"], [-1, "–"], [Number.NaN, "–"], [Infinity, "–"], [undefined, "–"]];
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
