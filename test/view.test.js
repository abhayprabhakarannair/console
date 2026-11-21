import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, createRegistry } from "../src/model.js";
import { cards } from "../src/view.js";

const NOW = 1_800_000_000_000;

function registry(messages) {
  const r = createRegistry();
  for (const [topic, payload, at = NOW] of messages) {
    apply(r, { topic, payload: typeof payload === "string" ? payload : JSON.stringify(payload), now: at });
  }
  return r;
}

const WARDEN_META = { kind: "warden", version: "0.1.0", commands: ["shutdown", "reboot", "suspend", "cancel", "refresh"] };
const WAKER_META = { kind: "warden", version: "0.1.0", commands: ["wake", "refresh"], wakes: ["devil"] };

function home({ devilStatus = "online", wakerStatus = "online", target = { power: "online" }, devilState = {} } = {}) {
  return registry([
    ["home/devil/meta", WARDEN_META],
    ["home/devil/status", devilStatus],
    ["home/devil/state", { power: { pending: null }, ...devilState }],
    ["home/waker/meta", WAKER_META],
    ["home/waker/status", wakerStatus],
    ["home/waker/state", { wake: { targets: { devil: target } } }],
  ]);
}

const byId = (list, id) => list.find((c) => c.id === id);
const action = (card, label) => card.actions.find((a) => a.label === label);

test("one card per device, sorted, with kinds", () => {
  const list = cards(home(), NOW);
  assert.deepEqual(list.map((c) => [c.id, c.kind]), [["devil", "warden"], ["waker", "warden"]]);
});

test("the wake button lives on the target and is sent through the waker", () => {
  const devil = byId(cards(home(), NOW), "devil");
  assert.deepEqual(action(devil, "Wake"), {
    label: "Wake", topic: "home/waker/cmd", payload: "wake devil console", disabled: false, reason: null,
  });
});

test("wake is disabled while the waker is offline", () => {
  const wake = action(byId(cards(home({ wakerStatus: "offline" }), NOW), "devil"), "Wake");
  assert.equal(wake.disabled, true);
  assert.equal(wake.reason, "waker is offline");
});

test("a wake target without its own agent still gets a card", () => {
  const r = registry([
    ["home/waker/meta", { ...WAKER_META, wakes: ["nas"] }],
    ["home/waker/status", "online"],
    ["home/waker/state", { wake: { targets: { nas: { power: "offline" } } } }],
  ]);
  const nas = byId(cards(r, NOW), "nas");
  assert.deepEqual([nas.kind, nas.status, nas.power], ["machine", "unknown", "offline"]);
  assert.deepEqual(nas.actions.map((a) => a.label), ["Wake"]);
});

test("power state prefers the LAN view over the agent's status", () => {
  assert.equal(byId(cards(home({ devilStatus: "online", target: { power: "offline" } }), NOW), "devil").power, "offline");
  assert.equal(byId(cards(home({ devilStatus: "offline", target: { power: "waking" } }), NOW), "devil").power, "waking");
  const noWaker = registry([["home/devil/meta", WARDEN_META], ["home/devil/status", "suspended"]]);
  assert.equal(byId(cards(noWaker, NOW), "devil").power, "asleep");
});

test("power actions follow the advertised commands and need the agent online", () => {
  const devil = byId(cards(home(), NOW), "devil");
  assert.deepEqual(devil.actions.map((a) => [a.label, a.payload, a.confirm, a.disabled]), [
    ["Wake", "wake devil console", undefined, false],
    ["Sleep", "suspend console", null, false],
    ["Reboot", "reboot console", "Reboot devil?", false],
    ["Shut down", "shutdown console", "Shut down devil?", false],
  ]);
  const off = byId(cards(home({ devilStatus: "offline" }), NOW), "devil");
  assert.ok(off.actions.filter((a) => a.label !== "Wake").every((a) => a.disabled && a.reason === "devil is offline"));
  const limited = registry([["home/x/meta", { kind: "warden", commands: ["reboot"] }], ["home/x/status", "online"]]);
  assert.deepEqual(byId(cards(limited, NOW), "x").actions.map((a) => a.label), ["Reboot"]);
});

test("a pending action counts down from when the state arrived and offers cancel", () => {
  const r = home({ devilState: { power: { pending: { action: "reboot", source: "phone", in_s: 10 } } } });
  const at = (ms) => byId(cards(r, NOW + ms), "devil");
  assert.deepEqual(at(0).pending, {
    action: "reboot", source: "phone", remaining: 10,
    cancel: { topic: "home/devil/cmd", payload: "cancel console", disabled: false },
  });
  assert.equal(at(3500).pending.remaining, 7);
  assert.equal(at(60_000).pending.remaining, 0);
  assert.ok(at(0).actions.filter((a) => a.label !== "Wake").every((a) => a.disabled && a.reason === "reboot pending"));
});

test("malformed pending data is ignored", () => {
  for (const pending of [{ action: "reboot" }, { in_s: 5 }, "reboot", [1], { action: 1, in_s: 5 }]) {
    const devil = byId(cards(home({ devilState: { power: { pending } } }), NOW), "devil");
    assert.equal(devil.pending, null, JSON.stringify(pending));
  }
});

test("warden facts and temperatures", () => {
  const r = home({
    devilState: {
      system: { boot_time: NOW / 1000 - 3600, load: [0.5, 0.25, 0.1], mem_used_pct: 14.06, kernel: "7.3.5" },
      sensors: { temps: { k10temp: { Tctl: 52.4 }, amdgpu: { edge: 47, junction: 61.5 }, broken: "x", nvme: { a: "hot" } } },
    },
  });
  const devil = byId(cards(r, NOW), "devil");
  assert.deepEqual(devil.facts, [
    { label: "Uptime", value: "1h 0m" },
    { label: "Load", value: "0.5 / 0.25 / 0.1" },
    { label: "Memory", value: "14.1%" },
    { label: "Kernel", value: "7.3.5" },
  ]);
  assert.deepEqual(devil.temps.map((t) => `${t.chip}/${t.label}=${t.text}`), [
    "k10temp/Tctl=52.4 °C", "amdgpu/edge=47.0 °C", "amdgpu/junction=61.5 °C",
  ]);
  assert.equal(devil.hottest.label, "junction");
});

test("unknown kinds render their scalar state", () => {
  const r = registry([["home/plug/meta", { kind: "smartplug" }], ["home/plug/state", { on: true, watts: 12, nested: { x: 1 } }]]);
  const plug = byId(cards(r, NOW), "plug");
  assert.equal(plug.kind, "smartplug");
  assert.deepEqual(plug.facts, [{ label: "on", value: "true" }, { label: "watts", value: "12" }]);
  assert.deepEqual(plug.actions, []);
});

test("a device seen only through events or status has an unknown kind and no actions", () => {
  const r = registry([["home/ghost/status", "online"]]);
  const ghost = byId(cards(r, NOW), "ghost");
  assert.deepEqual([ghost.kind, ghost.status, ghost.power, ghost.actions], ["unknown", "online", "online", []]);
});

test("latest events first, at most five", () => {
  const msgs = [["home/waker/meta", WAKER_META]];
  for (let i = 0; i < 8; i++) msgs.push(["home/waker/event", { event: "e", n: i }, NOW + i]);
  assert.deepEqual(byId(cards(registry(msgs), NOW), "waker").events.map((e) => e.n), [7, 6, 5, 4, 3]);
});

test("hostile meta does not break rendering", () => {
  const r = registry([
    ["home/waker/meta", { kind: "warden", wakes: "devil", commands: "reboot" }],
    ["home/devil/meta", { kind: "warden", commands: null }],
    ["home/devil/state", { power: "x", system: [1], sensors: { temps: [1, 2] } }],
  ]);
  const list = cards(r, NOW);
  assert.deepEqual(list.map((c) => [c.id, c.actions.length, c.facts.length, c.temps.length]), [["devil", 0, 0, 0], ["waker", 0, 0, 0]]);
});

const ROUTER_META = { kind: "warden", version: "0.2.0", modules: ["system", "wake", "wan", "clients"], commands: ["wake", "refresh"], wakes: ["devil"] };

function withRouter({ routerStatus = "online", wakerStatus = "online", routerState = {} } = {}) {
  const r = home({ wakerStatus });
  for (const [topic, payload] of [
    ["home/er605/meta", ROUTER_META],
    ["home/er605/status", routerStatus],
    ["home/er605/state", { wake: { targets: { devil: { power: "waking", waking_for_s: 3 } } }, ...routerState }],
  ]) {
    apply(r, { topic, payload: typeof payload === "string" ? payload : JSON.stringify(payload), now: NOW });
  }
  return r;
}

test("any device announcing wakes can wake; the first online one by id is used", () => {
  const wake = action(byId(cards(withRouter(), NOW), "devil"), "Wake");
  assert.equal(wake.topic, "home/er605/cmd");
  assert.equal(wake.disabled, false);
});

test("wake falls back to another online waker", () => {
  const wake = action(byId(cards(withRouter({ routerStatus: "offline" }), NOW), "devil"), "Wake");
  assert.deepEqual([wake.topic, wake.disabled], ["home/waker/cmd", false]);
});

test("wake is disabled only when every waker is offline", () => {
  const wake = action(byId(cards(withRouter({ routerStatus: "offline", wakerStatus: "offline" }), NOW), "devil"), "Wake");
  assert.deepEqual([wake.topic, wake.disabled, wake.reason], ["home/er605/cmd", true, "er605 is offline"]);
});

test("power comes from the chosen waker, reading warden's wake module state", () => {
  assert.equal(byId(cards(withRouter(), NOW), "devil").power, "waking");
});

test("router card lists links in order with the active one and usage", () => {
  const router = byId(cards(withRouter({
    routerState: {
      wan: {
        active: "railwire",
        links: [
          { name: "bsnl", status: "offline", used_bytes: 5_200_000_000 },
          { name: "railwire", status: "online" },
          { name: "jio", status: "online", used_bytes: 312_400_000_000, cap_bytes: 1_000_000_000_000 },
          "junk",
          { name: 3 },
        ],
      },
    },
  }), NOW), "er605");
  assert.deepEqual(router.links, [
    { name: "bsnl", status: "offline", active: false, usage: "5.2 GB" },
    { name: "railwire", status: "online", active: true, usage: null },
    { name: "jio", status: "online", active: false, usage: "312 GB of 1.0 TB" },
  ]);
});

const ROUTER_STATE = {
  wan: { active: "bsnl", links: [{ name: "bsnl", status: "online" }, { name: "jio", status: "online" }] },
  clients: {
    online: [
      { name: "satan", ip: "192.0.2.8", link: "wifi", band: "5 GHz", signal: -58, via: "jio", override: "jio" },
      { name: null, ip: "192.0.2.204", link: "wired", via: "bsnl", override: null },
      { name: "x" },
      7,
    ],
  },
};

test("devices show link, ISP and a choice of ISP sent to the router", () => {
  const meta = { ...ROUTER_META, commands: ["wake", "isp", "refresh"] };
  const r = withRouter({ routerState: ROUTER_STATE });
  apply(r, { topic: "home/er605/meta", payload: JSON.stringify(meta), now: NOW });
  const [satan, unnamed] = byId(cards(r, NOW), "er605").clients;
  assert.deepEqual([satan.name, satan.link, satan.via, satan.override], ["satan", "Wi-Fi 5 GHz · -58 dBm", "jio", "jio"]);
  assert.deepEqual(satan.isp.map((a) => [a.label, a.selected]), [["Auto", false], ["bsnl", false], ["jio", true]]);
  assert.deepEqual(satan.isp[1], {
    label: "bsnl", topic: "home/er605/cmd", payload: "isp 192.0.2.8 bsnl console", selected: false, disabled: false, reason: null,
  });
  assert.deepEqual([unnamed.name, unnamed.link, unnamed.isp.find((a) => a.selected).label], [null, "wired", "Auto"]);
});

test("ISP choices are disabled while the router is offline and absent without the isp command", () => {
  const offline = withRouter({ routerStatus: "offline", routerState: ROUTER_STATE });
  apply(offline, { topic: "home/er605/meta", payload: JSON.stringify({ ...ROUTER_META, commands: ["isp"] }), now: NOW });
  assert.ok(byId(cards(offline, NOW), "er605").clients[0].isp.every((a) => a.disabled));
  const without = byId(cards(withRouter({ routerState: ROUTER_STATE }), NOW), "er605");
  assert.deepEqual(without.clients[0].isp, []);
});

test("cards without wan or clients state have empty lists", () => {
  const devil = byId(cards(home(), NOW), "devil");
  assert.deepEqual([devil.links, devil.clients], [[], []]);
});
