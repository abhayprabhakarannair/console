import assert from "node:assert/strict";
import { test } from "node:test";

import { celsius, duration, percent, signal } from "../src/format.js";

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

test("signal quality bands", () => {
  const cases = [[-40, "excellent"], [-55, "excellent"], [-56, "good"], [-67, "good"], [-68, "fair"], [-75, "fair"],
    [-76, "weak"]];
  for (const [dbm, quality] of cases) assert.equal(signal(dbm), `${dbm} dBm (${quality})`);
  assert.equal(signal(undefined), "–");
});
