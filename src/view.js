import { bytes, celsius, duration, percent } from "./format.js";
import { ROOT } from "./model.js";

const POWER_ACTIONS = [
  { command: "suspend", label: "Sleep" },
  { command: "reboot", label: "Reboot", confirm: "Reboot {id}?" },
  { command: "shutdown", label: "Shut down", confirm: "Shut down {id}?", style: "danger" },
];

const cmd = (id) => `${ROOT}/${id}/cmd`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

// Which device wakes which machine, and what it currently sees for it. Any device listing the machine in
// meta.wakes can (a warden with the wake module); an online one is preferred, then the first by id.
function wakers(registry) {
  const out = new Map();
  for (const d of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const targets = d.state?.wake?.targets;
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
      const used = Number.isFinite(l.used_bytes) ? bytes(l.used_bytes) : null;
      const usage = used && Number.isFinite(l.cap_bytes) ? `${used} of ${bytes(l.cap_bytes)}` : used;
      return { name: l.name, status: l.status, active: l.name === wan.active, usage };
    });
}

function linkText(c) {
  if (c.link === "wired") return "wired";
  if (c.link !== "wifi") return null;
  const band = typeof c.band === "string" ? ` ${c.band}` : "";
  return `Wi-Fi${band}${Number.isFinite(c.signal) ? ` · ${c.signal} dBm` : ""}`;
}

// Per-device ISP choice: Auto plus every link, sent to the device that reported the list.
function ispChoices(d, ip, override, names) {
  if (!asArray(d?.meta?.commands).includes("isp") || !names.length) return [];
  const online = d.status === "online";
  return ["auto", ...names].map((isp) => ({
    label: isp === "auto" ? "Auto" : isp,
    topic: cmd(d.id),
    payload: `isp ${ip} ${isp} console`,
    selected: (override ?? "auto") === isp,
    disabled: !online,
    reason: online ? null : `${d.id} is ${d.status ?? "unknown"}`,
  }));
}

function clients(d) {
  const names = links(d?.state).map((l) => l.name);
  return asArray(d?.state?.clients?.online)
    .filter((c) => isObject(c) && typeof c.ip === "string")
    .map((c) => {
      const override = typeof c.override === "string" ? c.override : null;
      return {
        name: typeof c.name === "string" ? c.name : null,
        ip: c.ip,
        link: linkText(c),
        via: typeof c.via === "string" ? c.via : null,
        override,
        isp: ispChoices(d, c.ip, override, names),
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

// `due` is counted from when the state arrived, since in_s was measured then.
function pendingOf(d) {
  const p = d.state?.power?.pending;
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

function temps(state) {
  const out = [];
  for (const [chip, readings] of Object.entries(isObject(state?.sensors?.temps) ? state.sensors.temps : {})) {
    if (!isObject(readings)) continue;
    for (const [label, value] of Object.entries(readings)) {
      if (Number.isFinite(value)) out.push({ chip, label, value, text: celsius(value) });
    }
  }
  return out;
}

function wardenFacts(state) {
  const s = isObject(state?.system) ? state.system : {};
  const facts = [];
  if (Number.isFinite(s.boot_time)) facts.push({ label: "Uptime", since: s.boot_time * 1000 });
  if (Array.isArray(s.load) && s.load.every(Number.isFinite)) facts.push({ label: "Load", value: s.load.join(" / ") });
  if (Number.isFinite(s.mem_used_pct)) facts.push({ label: "Memory", value: percent(s.mem_used_pct) });
  if (typeof s.kernel === "string") facts.push({ label: "Kernel", value: s.kernel });
  return facts;
}

function rawFacts(state) {
  return Object.entries(state ?? {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([label, v]) => ({ label, value: String(v) }));
}

// Cards hold no values derived from the current time, so they only change when the bus does; countdowns and
// uptimes carry their reference time (`due`, `since`) for the page to tick with countdown() and elapsed().
export function cards(registry) {
  const wake = wakers(registry);
  const ids = new Set([...registry.keys(), ...wake.keys()]);
  return [...ids].sort().map((id) => {
    const d = registry.get(id) ?? null;
    const kind = d?.meta?.kind ?? (wake.has(id) ? "machine" : "unknown");
    const waker = wake.get(id);
    const online = d?.status === "online";
    const pending = d ? pendingOf(d) : null;
    const commands = new Set(asArray(d?.meta?.commands));
    const actions = [];

    if (waker) {
      actions.push({
        label: "Wake",
        style: "primary",
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
        style: a.style ?? null,
        topic: cmd(id),
        payload: `${a.command} console`,
        confirm: a.confirm?.replace("{id}", id) ?? null,
        disabled: !online || pending !== null,
        reason: !online ? `${id} is ${d.status ?? "unknown"}` : pending ? `${pending.action} pending` : null,
      });
    }

    const t = temps(d?.state);
    return {
      id,
      kind,
      status: d?.status ?? "unknown",
      power: powerOf(d, waker),
      pending: pending && commands.has("cancel")
        ? { ...pending, cancel: { topic: cmd(id), payload: "cancel console", disabled: !online } }
        : pending,
      actions,
      facts: kind === "warden" ? wardenFacts(d.state) : rawFacts(d?.state),
      temps: t,
      links: links(d?.state),
      clients: clients(d),
      hottest: t.length ? t.reduce((a, b) => (b.value > a.value ? b : a)) : null,
      events: (d?.events ?? []).slice(-5).reverse(),
    };
  });
}
