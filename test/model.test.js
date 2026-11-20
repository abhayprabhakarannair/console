import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_EVENTS, apply, createRegistry } from "../src/model.js";

const msg = (topic, payload, extra = {}) => ({ topic, payload, now: 1000, ...extra });

test("meta, status and state build a device", () => {
  const r = createRegistry();
  assert.equal(apply(r, msg("home/devil/meta", '{"kind":"warden","commands":["reboot"]}')), "devil");
  assert.equal(apply(r, msg("home/devil/status", "online", { now: 2000 })), "devil");
  assert.equal(apply(r, msg("home/devil/state", '{"system":{"load":[1,2,3]}}', { now: 3000 })), "devil");
  const d = r.get("devil");
  assert.deepEqual(d.meta, { kind: "warden", commands: ["reboot"] });
  assert.equal(d.status, "online");
  assert.equal(d.statusAt, 2000);
  assert.deepEqual(d.state, { system: { load: [1, 2, 3] } });
  assert.equal(d.stateAt, 3000);
});

test("topics outside home/<id>/<leaf> are ignored", () => {
  const r = createRegistry();
  for (const topic of ["home/devil", "home/devil/state/x", "other/devil/state", "home/DEVIL/state", "home//state",
    "home/" + "a".repeat(32) + "/state", "home/devil/cmd", "home/devil/unknown"]) {
    assert.equal(apply(r, msg(topic, "{}")), null, topic);
  }
  assert.equal(r.size, 0);
});

test("invalid payloads are ignored and keep the previous value", () => {
  const r = createRegistry();
  apply(r, msg("home/devil/meta", '{"kind":"warden"}'));
  apply(r, msg("home/devil/state", '{"a":1}'));
  apply(r, msg("home/devil/status", "online"));
  for (const [leaf, bad] of [["meta", "{"], ["meta", "[]"], ["meta", "null"], ["meta", '{"kind":""}'],
    ["meta", '{"kind":3}'], ["state", "42"], ["state", '"x"'], ["state", "[1]"], ["status", "ONLINE"],
    ["status", "rebooting"], ["event", "{}"], ["event", '{"event":1}'], ["event", "nope"]]) {
    assert.equal(apply(r, msg(`home/devil/${leaf}`, bad)), null, `${leaf}: ${bad}`);
  }
  const d = r.get("devil");
  assert.deepEqual([d.meta.kind, d.state, d.status, d.events.length], ["warden", { a: 1 }, "online", 0]);
});

test("an empty retained payload clears that leaf, and the device once everything is gone", () => {
  const r = createRegistry();
  apply(r, msg("home/old/meta", '{"kind":"imp"}'));
  apply(r, msg("home/old/status", "offline"));
  assert.equal(apply(r, msg("home/old/status", "", { retained: true })), "old");
  assert.equal(r.get("old").status, null);
  assert.equal(r.get("old").statusAt, null);
  assert.equal(apply(r, msg("home/old/meta", "", { retained: true })), "old");
  assert.equal(r.has("old"), false);
  assert.equal(apply(r, msg("home/old/state", "")), null);
});

test("events are capped and stamped; retained events are not replayed", () => {
  const r = createRegistry();
  for (let i = 0; i < MAX_EVENTS + 5; i++) apply(r, msg("home/imp/event", JSON.stringify({ event: "e", n: i }), { now: i }));
  const events = r.get("imp").events;
  assert.equal(events.length, MAX_EVENTS);
  assert.deepEqual(events[0], { event: "e", n: 5, at: 5 });
  assert.equal(apply(r, msg("home/imp/event", '{"event":"old"}', { retained: true })), null);
});

test("an event cannot overwrite the receipt time", () => {
  const r = createRegistry();
  apply(r, msg("home/imp/event", '{"event":"boot","at":1}', { now: 99 }));
  assert.equal(r.get("imp").events[0].at, 99);
});
