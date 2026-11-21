import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, createRegistry } from "../src/model.js";
import { cards, countdown, elapsed, freshness, STALE_AFTER_MS, summary } from "../src/view.js";

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
  const list = cards(home());
  assert.deepEqual(list.map((c) => [c.id, c.kind]), [["devil", "warden"], ["waker", "warden"]]);
});

test("the wake button lives on the target and is sent through the waker", () => {
  const devil = byId(cards(home()), "devil");
  assert.deepEqual(action(devil, "Wake"), {
    label: "Wake", icon: "bolt", style: "quiet", topic: "home/waker/cmd", payload: "wake devil console", disabled: false, reason: null,
  });
});

test("wake is disabled while the waker is offline", () => {
  const wake = action(byId(cards(home({ wakerStatus: "offline" })), "devil"), "Wake");
  assert.equal(wake.disabled, true);
  assert.equal(wake.reason, "waker is offline");
});

test("a wake target without its own agent still gets a card", () => {
  const r = registry([
    ["home/waker/meta", { ...WAKER_META, wakes: ["nas"] }],
    ["home/waker/status", "online"],
    ["home/waker/state", { wake: { targets: { nas: { power: "offline" } } } }],
  ]);
  const nas = byId(cards(r), "nas");
  assert.deepEqual([nas.kind, nas.status, nas.power], ["machine", "unknown", "offline"]);
  assert.deepEqual(nas.actions.map((a) => a.label), ["Wake"]);
});

test("power state prefers the LAN view over the agent's status", () => {
  assert.equal(byId(cards(home({ devilStatus: "online", target: { power: "offline" } })), "devil").power, "offline");
  assert.equal(byId(cards(home({ devilStatus: "offline", target: { power: "waking" } })), "devil").power, "waking");
  const noWaker = registry([["home/devil/meta", WARDEN_META], ["home/devil/status", "suspended"]]);
  assert.equal(byId(cards(noWaker), "devil").power, "asleep");
});

test("power actions follow the advertised commands and need the agent online", () => {
  const devil = byId(cards(home()), "devil");
  assert.deepEqual(devil.actions.map((a) => [a.label, a.style, a.payload, a.confirm, a.disabled]), [
    ["Wake", "quiet", "wake devil console", undefined, false],
    ["Sleep", null, "suspend console", null, false],
    ["Reboot", null, "reboot console", "Reboot devil?", false],
    ["Shut down", "danger", "shutdown console", "Shut down devil?", false],
  ]);
  const off = byId(cards(home({ devilStatus: "offline" })), "devil");
  assert.ok(off.actions.filter((a) => a.label !== "Wake").every((a) => a.disabled && a.reason === "devil is offline"));
  const limited = registry([["home/x/meta", { kind: "warden", commands: ["reboot"] }], ["home/x/status", "online"]]);
  assert.deepEqual(byId(cards(limited), "x").actions.map((a) => a.label), ["Reboot"]);
});

test("a pending action is due counting from when the state arrived and offers cancel", () => {
  const r = home({ devilState: { power: { pending: { action: "reboot", source: "phone", in_s: 10 } } } });
  const devil = byId(cards(r), "devil");
  assert.deepEqual(devil.pending, {
    action: "reboot", source: "phone", due: NOW + 10_000,
    cancel: { topic: "home/devil/cmd", payload: "cancel console", disabled: false },
  });
  assert.ok(devil.actions.filter((a) => a.label !== "Wake").every((a) => a.disabled && a.reason === "reboot pending"));
});

test("countdown rounds up and stops at zero", () => {
  assert.equal(countdown(NOW + 10_000, NOW), 10);
  assert.equal(countdown(NOW + 10_000, NOW + 3500), 7);
  assert.equal(countdown(NOW + 10_000, NOW + 9999), 1);
  assert.equal(countdown(NOW + 10_000, NOW + 10_000), 0);
  assert.equal(countdown(NOW + 10_000, NOW + 60_000), 0);
});

test("elapsed formats the time since, and a future start as unknown", () => {
  assert.equal(elapsed(NOW - 3_600_000, NOW), "1h");
  assert.equal(elapsed(NOW - 59_500, NOW), "59s");
  assert.equal(elapsed(NOW + 5000, NOW), "–");
});

test("cards do not depend on the time, so an idle bus causes no re-render", () => {
  const r = home({
    devilState: { system: { boot_time: NOW / 1000 - 30 }, power: { pending: { action: "reboot", in_s: 5 } } },
  });
  const before = JSON.stringify(cards(r));
  const realNow = Date.now;
  Date.now = () => NOW + 60_000;
  try {
    assert.equal(JSON.stringify(cards(r)), before);
  } finally {
    Date.now = realNow;
  }
});

test("malformed pending data is ignored", () => {
  for (const pending of [{ action: "reboot" }, { in_s: 5 }, "reboot", [1], { action: 1, in_s: 5 }]) {
    const devil = byId(cards(home({ devilState: { power: { pending } } })), "devil");
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
  const devil = byId(cards(r), "devil");
  assert.deepEqual(devil.facts, [
    { label: "Uptime", since: NOW - 3_600_000 },
    { label: "Load", value: "0.5 / 0.25 / 0.1" },
  ]);
  assert.equal(devil.subtitle, "7.3.5");
  assert.deepEqual(devil.meters, [{ label: "Memory", pct: 14.06, text: "14.1%", level: "ok" }]);
  assert.deepEqual(devil.temps.map((t) => `${t.chip}/${t.label}=${t.text}`), [
    "k10temp/Tctl=52.4 °C", "amdgpu/edge=47.0 °C", "amdgpu/junction=61.5 °C",
  ]);
  assert.equal(devil.hottest.label, "junction");
});

test("unknown kinds render their scalar state", () => {
  const r = registry([["home/plug/meta", { kind: "smartplug" }], ["home/plug/state", { on: true, watts: 12, nested: { x: 1 } }]]);
  const plug = byId(cards(r), "plug");
  assert.equal(plug.kind, "smartplug");
  assert.deepEqual(plug.facts, [{ label: "on", value: "true" }, { label: "watts", value: "12" }]);
  assert.deepEqual(plug.actions, []);
});

test("a device seen only through events or status has an unknown kind and no actions", () => {
  const r = registry([["home/ghost/status", "online"]]);
  const ghost = byId(cards(r), "ghost");
  assert.deepEqual([ghost.kind, ghost.status, ghost.power, ghost.actions], ["unknown", "online", "online", []]);
});

test("latest events first, at most five", () => {
  const msgs = [["home/waker/meta", WAKER_META]];
  for (let i = 0; i < 8; i++) msgs.push(["home/waker/event", { event: "e", n: i }, NOW + i]);
  assert.deepEqual(byId(cards(registry(msgs)), "waker").events.map((e) => e.n), [7, 6, 5, 4, 3]);
});

test("hostile meta does not break rendering", () => {
  const r = registry([
    ["home/waker/meta", { kind: "warden", wakes: "devil", commands: "reboot" }],
    ["home/devil/meta", { kind: "warden", commands: null }],
    ["home/devil/state", { power: "x", system: [1], sensors: { temps: [1, 2] } }],
  ]);
  const list = cards(r);
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
  const wake = action(byId(cards(withRouter()), "devil"), "Wake");
  assert.equal(wake.topic, "home/er605/cmd");
  assert.equal(wake.disabled, false);
});

test("wake falls back to another online waker", () => {
  const wake = action(byId(cards(withRouter({ routerStatus: "offline" })), "devil"), "Wake");
  assert.deepEqual([wake.topic, wake.disabled], ["home/waker/cmd", false]);
});

test("wake is disabled only when every waker is offline", () => {
  const wake = action(byId(cards(withRouter({ routerStatus: "offline", wakerStatus: "offline" })), "devil"), "Wake");
  assert.deepEqual([wake.topic, wake.disabled, wake.reason], ["home/er605/cmd", true, "er605 is offline"]);
});

test("power comes from the chosen waker, reading warden's wake module state", () => {
  assert.equal(byId(cards(withRouter()), "devil").power, "waking");
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
  })), "er605");
  assert.deepEqual(router.links, [
    {
      name: "bsnl", status: "offline", online: false, degraded: false, quality: null, active: false, usage: "5.2 GB",
      cap: null, rx: null, tx: null,
    },
    {
      name: "railwire", status: "online", online: true, degraded: false, quality: null, active: true, usage: null,
      cap: null, rx: null, tx: null,
    },
    {
      name: "jio", status: "online", online: true, degraded: false, quality: null, active: false,
      usage: "312 GB of 1.0 TB", cap: { pct: 31.24, level: "ok" }, rx: null, tx: null,
    },
  ]);
});

const ROUTER_STATE = {
  wan: { active: "bsnl", links: [{ name: "bsnl", status: "online" }, { name: "jio", status: "online" }] },
  clients: {
    online: [
      { name: "satan", ip: "192.0.2.8", link: "wifi", band: "5 GHz", signal: -58, via: "jio", override: "jio", reserved: true },
      { name: null, ip: "192.0.2.204", link: "wired", via: "bsnl", override: null, reserved: true },
      { name: "guest", ip: "192.0.2.205", link: "wired", via: "bsnl", override: null, reserved: false },
      { name: "old", ip: "192.0.2.206", link: "wired", via: "bsnl", override: null },
      { name: "x" },
      7,
    ],
  },
};

test("devices show link, ISP and a choice of ISP sent to the router", () => {
  const meta = { ...ROUTER_META, commands: ["wake", "isp", "refresh"] };
  const r = withRouter({ routerState: ROUTER_STATE });
  apply(r, { topic: "home/er605/meta", payload: JSON.stringify(meta), now: NOW });
  const [satan, unnamed, guest, old] = byId(cards(r), "er605").clients;
  assert.deepEqual([satan.name, satan.link, satan.via, satan.override], ["satan", "Wi-Fi 5 GHz · -58 dBm", "jio", "jio"]);
  assert.deepEqual([satan.wired, satan.bars, satan.band, unnamed.wired, unnamed.bars, unnamed.band], [false, 3, "5 GHz", true, null, null]);
  assert.deepEqual(satan.isp.map((a) => [a.label, a.selected]), [["Auto", false], ["bsnl", false], ["jio", true]]);
  assert.deepEqual(satan.isp[1], {
    label: "bsnl", topic: "home/er605/cmd", payload: "isp 192.0.2.8 bsnl console", selected: false, degraded: false,
    disabled: false, reason: null,
  });
  assert.deepEqual([unnamed.name, unnamed.link, unnamed.isp.find((a) => a.selected).label], [null, "wired", "Auto"]);
  assert.deepEqual([guest.isp, old.isp], [[], []]);
});

test("ISP choices are disabled while the router is offline and absent without the isp command", () => {
  const offline = withRouter({ routerStatus: "offline", routerState: ROUTER_STATE });
  apply(offline, { topic: "home/er605/meta", payload: JSON.stringify({ ...ROUTER_META, commands: ["isp"] }), now: NOW });
  assert.ok(byId(cards(offline), "er605").clients[0].isp.every((a) => a.disabled));
  const without = byId(cards(withRouter({ routerState: ROUTER_STATE })), "er605");
  assert.deepEqual(without.clients[0].isp, []);
});

test("cards without wan or clients state have empty lists", () => {
  const devil = byId(cards(home()), "devil");
  assert.deepEqual([devil.links, devil.clients], [[], []]);
});

test("one badge merges power and agent status", () => {
  const badge = (opts) => byId(cards(home(opts)), "devil").badge;
  assert.deepEqual(badge(), { label: "Online", tone: "ok" });
  assert.deepEqual(badge({ devilStatus: "offline", target: { power: "online" } }), { label: "Agent down", tone: "warn" });
  assert.deepEqual(badge({ devilStatus: "offline", target: { power: "offline" } }), { label: "Off", tone: "dim" });
  assert.deepEqual(badge({ devilStatus: "offline", target: { power: "waking" } }), { label: "Waking", tone: "info" });
  assert.deepEqual(badge({ devilStatus: "suspended", target: { power: "unknown" } }), { label: "Asleep", tone: "warn" });
  const lone = registry([["home/x/meta", { kind: "warden" }], ["home/x/status", "offline"]]);
  assert.deepEqual(byId(cards(lone), "x").badge, { label: "Offline", tone: "crit" });
  assert.deepEqual(byId(cards(registry([["home/y/event", { event: "e" }]])), "y").badge, { label: "Unknown", tone: "dim" });
});

test("wake is the primary action only while the machine is not on", () => {
  const style = (power) => action(byId(cards(home({ target: { power } })), "devil"), "Wake").style;
  assert.deepEqual(["online", "waking", "offline"].map(style), ["quiet", "quiet", "primary"]);
  const asleep = registry([["home/devil/status", "suspended"], ["home/waker/meta", WAKER_META], ["home/waker/status", "online"]]);
  assert.equal(action(byId(cards(asleep), "devil"), "Wake").style, "primary");
});

test("freshness counts from when the state arrived and goes stale", () => {
  assert.equal(byId(cards(home()), "devil").updated, NOW);
  assert.deepEqual(freshness(NOW, NOW + 12_000), { text: "updated 12s ago", stale: false });
  assert.deepEqual(freshness(NOW, NOW + STALE_AFTER_MS), { text: "updated 1m ago", stale: false });
  assert.deepEqual(freshness(NOW, NOW + STALE_AFTER_MS + 1), { text: "updated 1m ago", stale: true });
  assert.equal(byId(cards(registry([["home/x/status", "online"]])), "x").updated, null);
});

test("disks become meters next to memory; malformed ones are skipped", () => {
  const devil = byId(cards(home({
    devilState: {
      system: {
        mem_used_pct: 91,
        disks: [
          { mount: "/", used_pct: 41.25, size_bytes: 1e12 },
          { mount: "/home", used_pct: 85 },
          { mount: "/x" }, { used_pct: 5 }, "junk",
        ],
      },
    },
  })), "devil");
  assert.deepEqual(devil.meters.map((m) => [m.label, m.text, m.level]), [
    ["Memory", "91.0%", "crit"], ["Disk /", "41.3% of 1.0 TB", "ok"], ["Disk /home", "85.0%", "warn"],
  ]);
});

test("UPS view: status, charge, runtime, load and power", () => {
  const ups = (u) => byId(cards(home({ devilState: { ups: u } })), "devil");
  const full = ups({ status: "online", flags: ["OL"], charge_pct: 100, runtime_s: 2280, load_pct: 18.4, power_w: 162.2, input_v: 231.6, model: "Back-UPS" });
  assert.deepEqual(full.ups, {
    status: "online", label: "On mains", tone: "ok",
    charge: { pct: 100, text: "100%", level: "ok" },
    runtime: "38m",
    facts: [{ label: "Runtime", value: "38m" }, { label: "Load", value: "162 W · 18%" }, { label: "Input", value: "232 V" }],
    model: "Back-UPS", error: null,
  });
  assert.equal(full.alert, null);

  const onBattery = ups({ status: "on_battery", charge_pct: 54, runtime_s: 1260 });
  assert.deepEqual([onBattery.ups.label, onBattery.ups.charge.level], ["On battery", "warn"]);
  assert.deepEqual(onBattery.alert, { tone: "warn", text: "On battery · 21m left" });
  assert.deepEqual(ups({ status: "low_battery", charge_pct: 20 }).alert, { tone: "crit", text: "Battery low · shutting down" });
  assert.equal(ups({ status: "low_battery", charge_pct: 20 }).ups.charge.level, "crit");
});

test("UPS view tolerates missing and odd fields", () => {
  const u = byId(cards(home({ devilState: { ups: { status: "boost", load_pct: 10, error: "cannot read ups" } } })), "devil").ups;
  assert.deepEqual(u, {
    status: "boost", label: "Unknown", tone: "dim", charge: null, runtime: null,
    facts: [{ label: "Load", value: "10%" }], model: null, error: "cannot read ups",
  });
  assert.equal(byId(cards(home({ devilState: { ups: "x" } })), "devil").ups, null);
  assert.equal(byId(cards(home()), "devil").ups, null);
  assert.equal(byId(cards(home({ devilState: { ups: { charge_pct: 140 } } })), "devil").ups.charge.pct, 100);
});

test("links carry live rates and a cap bar", () => {
  const router = byId(cards(withRouter({
    routerState: {
      wan: {
        active: "bsnl",
        links: [
          { name: "bsnl", status: "online", rx_bps: 42_100_000, tx_bps: 3_200 },
          { name: "jio", status: "online", used_bytes: 950e9, cap_bytes: 1e12, rx_bps: "fast" },
        ],
      },
    },
  })), "er605");
  assert.deepEqual(router.links.map((l) => [l.rx, l.tx, l.cap]), [
    ["42.1 Mbit/s", "3.2 kbit/s", null],
    [null, null, { pct: 95, level: "crit" }],
  ]);
});

test("links show loss and latency, and degraded only while online", () => {
  const router = byId(cards(withRouter({
    routerState: {
      wan: {
        active: "bsnl",
        links: [
          { name: "bsnl", status: "online", loss_pct: 0, latency_ms: 18 },
          { name: "railwire", status: "online", loss_pct: 8.04, latency_ms: 16.4, degraded: true },
          { name: "jio", status: "offline", loss_pct: 100, degraded: true },
          { name: "spare", status: "online", degraded: "yes", loss_pct: "x" },
        ],
      },
    },
  })), "er605");
  assert.deepEqual(router.links.map((l) => [l.name, l.degraded, l.quality]), [
    ["bsnl", false, "0.0% loss · 18 ms"],
    ["railwire", true, "8.0% loss · 16 ms"],
    ["jio", false, "100.0% loss"],
    ["spare", false, null],
  ]);
});

test("a device switched to a degraded or offline link says where it goes instead", () => {
  const meta = { ...ROUTER_META, commands: ["wake", "isp", "refresh"] };
  const state = {
    wan: {
      active: "bsnl",
      links: [
        { name: "bsnl", status: "online" },
        { name: "railwire", status: "online", degraded: true },
        { name: "jio", status: "offline" },
      ],
    },
    clients: {
      online: [
        { name: "satan", ip: "192.0.2.8", via: "bsnl", override: "railwire", reserved: true },
        { name: "tv", ip: "192.0.2.7", via: "bsnl", override: "jio", reserved: true },
        { name: "pc", ip: "192.0.2.4", via: "bsnl", override: "bsnl", reserved: true },
        { name: "lost", ip: "192.0.2.9", via: null, override: "railwire", reserved: true },
      ],
    },
  };
  const r = withRouter({ routerState: state });
  apply(r, { topic: "home/er605/meta", payload: JSON.stringify(meta), now: NOW });
  const [satan, tv, pc, lost] = byId(cards(r), "er605").clients;
  assert.deepEqual([satan.fallback, tv.fallback, pc.fallback, lost.fallback],
    ["railwire degraded → via bsnl", "jio offline → via bsnl", null, null]);
  const railwire = satan.isp.find((a) => a.label === "railwire");
  assert.deepEqual([railwire.selected, railwire.degraded, railwire.disabled, railwire.reason],
    [true, true, false, "railwire is degraded: this device uses its automatic order until it recovers"]);
  assert.deepEqual(satan.isp.filter((a) => a.degraded).map((a) => a.label), ["railwire"]);
});

test("the internet chip warns when the active link is degraded", () => {
  const wan = (degraded) => ({ wan: { active: "bsnl", links: [{ name: "bsnl", status: "online", degraded }, { name: "jio", status: "online", degraded: true }] } });
  assert.deepEqual(summary(withRouter({ routerState: wan(true) }))[0], { icon: "globe", label: "Internet", value: "bsnl · degraded", tone: "warn" });
  assert.deepEqual(summary(withRouter({ routerState: wan(false) }))[0], { icon: "globe", label: "Internet", value: "bsnl", tone: "ok" });
});

test("temperatures group by chip family, hottest first, with levels", () => {
  const devil = byId(cards(home({
    devilState: { sensors: { temps: { nvme: { a: 40 }, "nvme-2": { a: 57 }, amdgpu: { mem: 72 }, prom21_xhci: { t: 49 }, k10temp: { Tctl: 90 } } } },
  })), "devil");
  assert.deepEqual(devil.tempGroups.map((g) => [g.family, g.text, g.level]), [
    ["k10temp", "90.0 °C", "crit"], ["amdgpu", "72.0 °C", "warn"], ["nvme", "57.0 °C", "ok"], ["prom21", "49.0 °C", "ok"],
  ]);
});

test("a router with many devices gets a wide card", () => {
  const many = { ...ROUTER_STATE, clients: { online: Array.from({ length: 5 }, (_, i) => ({ ip: `192.0.2.${i + 1}` })) } };
  assert.equal(byId(cards(withRouter({ routerState: many })), "er605").wide, true);
  assert.equal(byId(cards(withRouter({ routerState: ROUTER_STATE })), "er605").wide, false);
});

test("summary chips come from whatever the bus has", () => {
  assert.deepEqual(summary(home()), []);
  const r = withRouter({ routerState: ROUTER_STATE });
  apply(r, { topic: "home/devil/state", payload: JSON.stringify({ ups: { status: "on_battery", charge_pct: 54 } }), now: NOW });
  assert.deepEqual(summary(r), [
    { icon: "globe", label: "Internet", value: "bsnl", tone: "ok" },
    { icon: "battery", label: "UPS", value: "54% · On battery", tone: "warn" },
    { icon: "devices", label: "Devices", value: "4 online", tone: "dim" },
  ]);
  const down = withRouter({ routerState: { wan: { active: null, links: [{ name: "bsnl", status: "offline" }] } } });
  assert.deepEqual(summary(down), [{ icon: "globe", label: "Internet", value: "down", tone: "crit" }]);
});
