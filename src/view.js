import { ago, bytes, celsius, duration, level, percent, quality, rate, signalBars } from "./format.js";
import { ROOT } from "./model.js";

// A device whose state is older than this is marked stale: three missed 30 s state intervals.
export const STALE_AFTER_MS = 90_000;

const POWER_ACTIONS = [
  { command: "suspend", label: "Sleep", icon: "moon" },
  { command: "reboot", label: "Reboot", icon: "restart", confirm: "Reboot {id}?" },
  { command: "shutdown", label: "Shut down", icon: "power", confirm: "Shut down {id}?", style: "danger" },
];

const UPS_STATUS = {
  online: { label: "On mains", tone: "ok" },
  on_battery: { label: "On battery", tone: "warn" },
  low_battery: { label: "Low battery", tone: "crit" },
};

const cmd = (id) => `${ROOT}/${id}/cmd`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(v) ? v : null);

// A device's state while its agent runs. Retained state outlives the agent, so an offline or suspended one's
// is a snapshot from before it stopped and is not shown as current.
const current = (d) => (d && d.status !== "offline" && d.status !== "suspended" ? d.state : null);

// Which device wakes which machine, and what it currently sees for it. Any device listing the machine in
// meta.wakes can (a warden with the wake module); an online one is preferred, then the first by id.
function wakers(registry) {
  const out = new Map();
  for (const d of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const targets = current(d)?.wake?.targets;
    for (const target of asArray(d.meta?.wakes)) {
      if (typeof target !== "string") continue;
      const online = d.status === "online";
      if (out.has(target) && (out.get(target).online || !online)) continue;
      const seen = isObject(targets) ? targets[target] : null;
      out.set(target, { via: d.id, online, power: isObject(seen) ? seen : null });
    }
  }
  return out;
}

function links(state) {
  const wan = isObject(state?.wan) ? state.wan : {};
  return asArray(wan.links)
    .filter((l) => isObject(l) && typeof l.name === "string" && typeof l.status === "string")
    .map((l) => {
      const used = num(l.used_bytes);
      const cap = num(l.cap_bytes);
      const capPct = used !== null && cap ? (100 * used) / cap : null;
      const online = l.status === "online";
      return {
        name: l.name,
        status: l.status,
        online,
        // Up but lossy or slow, as judged by the router; only meaningful while the link is online.
        degraded: online && l.degraded === true,
        quality: quality(l.loss_pct, l.latency_ms),
        active: l.name === wan.active,
        usage: used === null ? null : cap ? `${bytes(used)} of ${bytes(cap)}` : bytes(used),
        cap: capPct === null ? null : { pct: Math.min(100, capPct), level: level(capPct, 80, 90) },
        rx: num(l.rx_bps) === null ? null : rate(l.rx_bps),
        tx: num(l.tx_bps) === null ? null : rate(l.tx_bps),
      };
    });
}

function linkText(c) {
  if (c.link === "wired") return "wired";
  if (c.link !== "wifi") return null;
  const band = typeof c.band === "string" ? ` ${c.band}` : "";
  return `Wi-Fi${band}${Number.isFinite(c.signal) ? ` · ${c.signal} dBm` : ""}`;
}

// Per-device ISP choice: Auto plus every link, sent to the device that reported the list. Only for DHCP
// reservations: an override follows the address, which another device could lease next. A degraded link can
// still be chosen; the router routes the device by its automatic order until the link recovers.
function ispChoices(d, c, override, wans) {
  if (c.reserved !== true || !asArray(d?.meta?.commands).includes("isp") || !wans.length) return [];
  const online = d.status === "online";
  return ["auto", ...wans.map((l) => l.name)].map((isp) => {
    const degraded = wans.some((l) => l.name === isp && l.degraded);
    return {
      label: isp === "auto" ? "Auto" : isp,
      topic: cmd(d.id),
      payload: `isp ${c.ip} ${isp} console`,
      selected: (override ?? "auto") === isp,
      degraded,
      disabled: !online,
      reason: !online
        ? `${d.id} is ${d.status ?? "unknown"}`
        : degraded ? `${isp} is degraded: this device uses its automatic order until it recovers` : null,
    };
  });
}

// Why a device with an override is not using it: "railwire degraded → via bsnl".
function fallbackNote(override, via, wans) {
  if (!override || !via || override === via) return null;
  const link = wans.find((l) => l.name === override);
  const why = link?.degraded ? "degraded" : link && !link.online ? link.status : null;
  return `${override}${why ? ` ${why}` : ""} → via ${via}`;
}

function clients(d, state) {
  const wans = links(state);
  return asArray(state?.clients?.online)
    .filter((c) => isObject(c) && typeof c.ip === "string")
    .map((c) => {
      const override = typeof c.override === "string" ? c.override : null;
      return {
        name: typeof c.name === "string" ? c.name : null,
        ip: c.ip,
        link: linkText(c),
        band: c.link === "wifi" && typeof c.band === "string" ? c.band : null,
        wired: c.link === "wired",
        bars: c.link === "wifi" ? signalBars(c.signal) : null,
        via: typeof c.via === "string" ? c.via : null,
        override,
        fallback: fallbackNote(override, typeof c.via === "string" ? c.via : null, wans),
        isp: ispChoices(d, c, override, wans),
      };
    });
}

// Seconds left until `due` (ms), never negative.
export function countdown(due, now) {
  return Math.max(0, Math.ceil((due - now) / 1000));
}

// Time since `since` (ms), formatted.
export function elapsed(since, now) {
  return duration((now - since) / 1000);
}

// How old a device's state is: "updated 12s ago", stale once older than STALE_AFTER_MS.
export function freshness(updated, now) {
  return { text: `updated ${ago((now - updated) / 1000)}`, stale: now - updated > STALE_AFTER_MS };
}

// `due` is counted from when the state arrived, since in_s was measured then.
function pendingOf(d) {
  const p = current(d)?.power?.pending;
  if (!isObject(p) || typeof p.action !== "string" || !Number.isFinite(p.in_s) || d.stateAt === null) return null;
  return { action: p.action, source: typeof p.source === "string" ? p.source : "?", due: d.stateAt + p.in_s * 1000 };
}

// Best available answer to "is this machine on": the LAN ping beats the agent's own status.
function powerOf(d, waker) {
  const seen = waker?.power?.power;
  if (["online", "offline", "waking"].includes(seen)) return seen;
  if (d?.status === "online") return "online";
  if (d?.status === "suspended") return "asleep";
  if (d?.status === "offline") return "offline";
  return "unknown";
}

// One badge for power and agent together. A machine someone can wake is "Off" when down (a normal state);
// anything else that goes down is "Offline". A machine that answers on the LAN while its agent does not
// is "Agent down".
function badgeOf(d, power, wakeable) {
  if (power === "waking") return { label: "Waking", tone: "info" };
  if (power === "asleep") return { label: "Asleep", tone: "warn" };
  if (power === "offline") return wakeable ? { label: "Off", tone: "dim" } : { label: "Offline", tone: "crit" };
  if (power === "online") {
    return d?.meta && d.status !== "online" ? { label: "Agent down", tone: "warn" } : { label: "Online", tone: "ok" };
  }
  return { label: "Unknown", tone: "dim" };
}

function temps(state) {
  const out = [];
  for (const [chip, readings] of Object.entries(isObject(state?.sensors?.temps) ? state.sensors.temps : {})) {
    if (!isObject(readings)) continue;
    for (const [label, value] of Object.entries(readings)) {
      if (Number.isFinite(value)) out.push({ chip, label, value, text: celsius(value), level: level(value, 70, 85) });
    }
  }
  return out;
}

// Hottest reading per chip family: the hwmon name up to its first "-" or "_" (nvme-2 → nvme,
// prom21_xhci → prom21), hottest first.
function tempGroups(list) {
  const groups = new Map();
  for (const t of list) {
    const family = t.chip.replace(/[-_].*$/, "") || t.chip;
    if (!groups.has(family) || t.value > groups.get(family).value) {
      groups.set(family, { family, value: t.value, text: t.text, level: t.level });
    }
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

function wardenFacts(state) {
  const s = isObject(state?.system) ? state.system : {};
  const facts = [];
  if (Number.isFinite(s.boot_time)) facts.push({ label: "Uptime", since: s.boot_time * 1000 });
  if (Array.isArray(s.load) && s.load.length && s.load.every(Number.isFinite)) {
    facts.push({ label: "Load", value: s.load.join(" / ") });
  }
  return facts;
}

function meters(state) {
  const s = isObject(state?.system) ? state.system : {};
  const out = [];
  if (Number.isFinite(s.mem_used_pct)) {
    out.push({ label: "Memory", pct: s.mem_used_pct, text: percent(s.mem_used_pct), level: level(s.mem_used_pct, 80, 90) });
  }
  for (const disk of asArray(s.disks)) {
    if (!isObject(disk) || typeof disk.mount !== "string" || !Number.isFinite(disk.used_pct)) continue;
    const size = Number.isFinite(disk.size_bytes) ? ` of ${bytes(disk.size_bytes)}` : "";
    out.push({
      label: `Disk ${disk.mount}`,
      pct: disk.used_pct,
      text: `${percent(disk.used_pct)}${size}`,
      level: level(disk.used_pct, 80, 90),
    });
  }
  return out;
}

function upsOf(state) {
  const u = state?.ups;
  if (!isObject(u)) return null;
  const status = UPS_STATUS[u.status] ?? { label: "Unknown", tone: "dim" };
  const charge = num(u.charge_pct);
  const runtime = num(u.runtime_s) === null ? null : duration(u.runtime_s);
  const facts = [];
  if (runtime) facts.push({ label: "Runtime", value: runtime });
  if (num(u.load_pct) !== null || num(u.power_w) !== null) {
    const parts = [num(u.power_w) !== null ? `${Math.round(u.power_w)} W` : null,
      num(u.load_pct) !== null ? `${Math.round(u.load_pct)}%` : null];
    facts.push({ label: "Load", value: parts.filter(Boolean).join(" · ") });
  }
  if (num(u.input_v) !== null) facts.push({ label: "Input", value: `${Math.round(u.input_v)} V` });
  return {
    status: typeof u.status === "string" ? u.status : "unknown",
    ...status,
    charge: charge === null ? null : {
      pct: Math.max(0, Math.min(100, charge)),
      text: `${Math.round(charge)}%`,
      level: charge < 30 ? "crit" : charge < 60 ? "warn" : "ok",
    },
    runtime,
    facts,
    model: typeof u.model === "string" ? u.model : null,
    error: typeof u.error === "string" ? u.error : null,
  };
}

function alertOf(ups) {
  if (ups?.status === "on_battery") return { tone: "warn", text: `On battery${ups.runtime ? ` · ${ups.runtime} left` : ""}` };
  if (ups?.status === "low_battery") return { tone: "crit", text: "Battery low · shutting down" };
  return null;
}

function rawFacts(state) {
  return Object.entries(state ?? {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([label, v]) => ({ label, value: String(v) }));
}

// Cards hold no values derived from the current time, so they only change when the bus does; countdowns, uptimes
// and freshness carry their reference time (`due`, `since`, `updated`) for the page to tick with countdown(),
// elapsed() and freshness().
export function cards(registry) {
  const wake = wakers(registry);
  const ids = new Set([...registry.keys(), ...wake.keys()]);
  return [...ids].sort().map((id) => {
    const d = registry.get(id) ?? null;
    const kind = d?.meta?.kind ?? (wake.has(id) ? "machine" : "unknown");
    const waker = wake.get(id);
    const online = d?.status === "online";
    const power = powerOf(d, waker);
    const pending = d ? pendingOf(d) : null;
    const commands = new Set(asArray(d?.meta?.commands));
    const actions = [];

    if (waker) {
      actions.push({
        label: "Wake",
        icon: "bolt",
        style: power === "online" || power === "waking" ? "quiet" : "primary",
        topic: cmd(waker.via),
        payload: `wake ${id} console`,
        disabled: !waker.online,
        reason: waker.online ? null : `${waker.via} is offline`,
      });
    }
    for (const a of POWER_ACTIONS) {
      if (!commands.has(a.command)) continue;
      actions.push({
        label: a.label,
        icon: a.icon,
        style: a.style ?? null,
        topic: cmd(id),
        payload: `${a.command} console`,
        confirm: a.confirm?.replace("{id}", id) ?? null,
        disabled: !online || pending !== null,
        reason: !online ? `${id} is ${d.status ?? "unknown"}` : pending ? `${pending.action} pending` : null,
      });
    }

    const state = current(d);
    const t = temps(state);
    const ups = upsOf(state);
    const clientList = clients(d, state);
    return {
      id,
      kind,
      status: d?.status ?? "unknown",
      power,
      badge: badgeOf(d, power, Boolean(waker)),
      updated: state ? d.stateAt : null,
      subtitle: typeof d?.state?.system?.kernel === "string" ? d.state.system.kernel : null,
      alert: alertOf(ups),
      pending: pending && commands.has("cancel")
        ? { ...pending, cancel: { topic: cmd(id), payload: "cancel console", disabled: !online } }
        : pending,
      actions,
      facts: kind === "warden" ? wardenFacts(state) : rawFacts(state),
      meters: kind === "warden" ? meters(state) : [],
      temps: t,
      tempGroups: tempGroups(t),
      hottest: t.length ? t.reduce((a, b) => (b.value > a.value ? b : a)) : null,
      ups,
      links: links(state),
      clients: clientList,
      wide: clientList.length > 4,
      events: (d?.events ?? []).slice(-5).reverse(),
    };
  });
}

// Chips for the top bar, from whatever the bus has: the internet link in use, the UPS and devices online.
export function summary(registry) {
  const devices = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({ id: d.id, state: current(d) }));
  const chips = [];
  const router = devices.find((d) => isObject(d.state?.wan) && asArray(d.state.wan.links).length);
  if (router) {
    const active = typeof router.state.wan.active === "string" ? router.state.wan.active : null;
    const degraded = active !== null && links(router.state).some((l) => l.name === active && l.degraded);
    chips.push({
      icon: "globe",
      label: "Internet",
      value: active === null ? "down" : degraded ? `${active} · degraded` : active,
      tone: active === null ? "crit" : degraded ? "warn" : "ok",
    });
  }
  const powered = devices.find((d) => isObject(d.state?.ups));
  if (powered) {
    const ups = upsOf(powered.state);
    chips.push({ icon: "battery", label: "UPS", value: [ups.charge?.text, ups.label].filter(Boolean).join(" · "), tone: ups.tone });
  }
  const online = devices.filter((d) => Array.isArray(d.state?.clients?.online));
  if (online.length) {
    const count = online.reduce((n, d) => n + d.state.clients.online.filter((c) => isObject(c) && typeof c.ip === "string").length, 0);
    chips.push({ icon: "devices", label: "Devices", value: `${count} online`, tone: "dim" });
  }
  return chips;
}
