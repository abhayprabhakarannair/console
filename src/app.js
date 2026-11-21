import { ago } from "./format.js";
import { apply, createRegistry, ROOT } from "./model.js";
import { cards, countdown, elapsed, freshness, summary } from "./view.js";

const config = window.CONSOLE ?? {};
const registry = createRegistry();
const $devices = document.getElementById("devices");
const $summary = document.getElementById("summary");
const $hub = document.getElementById("hub");
const $empty = el("p", { class: "empty" }, "No devices on the bus yet.");
let client = null;
let shown = new Map();

// 24×24 stroke icons.
const ICONS = {
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  restart: "M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5",
  power: "M12 3v9M18.4 6.6a9 9 0 1 1-12.8 0",
  globe: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20",
  battery: "M3 8a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM21 10.5v3",
  devices: "M3 5h13v9H3zM7 18h5M9.5 14v4M18 9h3v10h-3z",
  wired: "M4 6h16v12H4zM8 14v-3M11 14v-3M14 14v-3M17 14v-3",
  down: "M12 5v14M6 13l6 6 6-6",
  up: "M12 19V5M6 11l6-6 6 6",
  thermo: "M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z",
  activity: "M22 12h-4l-3 8L9 4l-3 8H2",
  alert: "M12 3 2 20h20zM12 10v4M12 17v.5",
  chevron: "m9 6 6 6-6 6",
};

const SVG = "http://www.w3.org/2000/svg";

function icon(name, cls = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function signal(bars) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 14");
  svg.setAttribute("class", `signal s${bars}`);
  svg.setAttribute("aria-label", `signal ${bars} of 4`);
  for (let i = 0; i < 4; i++) {
    const r = document.createElementNS(SVG, "rect");
    const h = 4 + i * 3;
    for (const [k, v] of Object.entries({ x: i * 4, y: 14 - h, width: 3, height: h, rx: 1 })) r.setAttribute(k, v);
    if (i < bars) r.setAttribute("class", "on");
    svg.append(r);
  }
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "on") node.addEventListener("click", v);
    else if (k === "style") node.style.cssText = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function send({ topic, payload, confirm: question }) {
  if (question && !window.confirm(question)) return;
  client?.publish(topic, payload, { qos: 1 });
}

function button(action, extra = "") {
  return el("button", {
    class: ["btn", extra, action.style].filter(Boolean).join(" "),
    disabled: action.disabled,
    title: action.reason ?? null,
    on: () => send(action),
  }, action.icon ? icon(action.icon) : null, action.label);
}

function bar(pct, lvl) {
  return el("div", { class: `bar ${lvl}` }, el("span", { style: `width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%` }));
}

function section(title, iconName, ...children) {
  return el("div", { class: "section" }, el("h3", {}, icon(iconName), title), ...children);
}

function eventText(e) {
  const { event, at, ...rest } = e;
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  return [event, detail];
}

function upsSection(u) {
  return section("UPS", "battery",
    el("div", { class: "ups" },
      el("div", { class: "gauge" },
        el("strong", { class: `charge ${u.charge?.level ?? ""}` }, u.charge?.text ?? "–"),
        u.charge ? bar(u.charge.pct, u.charge.level) : null),
      el("span", { class: `badge ${u.tone}` }, el("i"), u.label)),
    u.facts.length ? el("div", { class: "kv" }, ...u.facts.map((f) => el("span", {}, el("span", { class: "muted" }, f.label), el("b", {}, f.value)))) : null,
    u.model || u.error ? el("p", { class: `note ${u.error ? "crit" : ""}` }, u.error ?? u.model) : null);
}

function linksSection(list) {
  return section("Internet", "globe", el("ul", { class: "links" }, ...list.map((l) => el("li", { class: l.active ? "active" : "" },
    el("div", { class: "link-head" },
      el("span", { class: `dot ${l.online ? "ok" : "crit"}`, title: l.status }),
      el("strong", {}, l.name),
      l.active ? el("span", { class: "badge ok small" }, "active") : null,
      !l.online ? el("span", { class: "muted" }, l.status) : null,
      l.rx || l.tx ? el("span", { class: "rates" },
        l.rx ? el("span", {}, icon("down", "icon tiny"), l.rx) : null,
        l.tx ? el("span", {}, icon("up", "icon tiny"), l.tx) : null) : null),
    l.usage ? el("div", { class: "usage" },
      el("span", {}, l.usage, " this cycle"),
      l.cap ? bar(l.cap.pct, l.cap.level) : null) : null))));
}

function clientsSection(list) {
  return el("details", { class: "section fold" },
    el("summary", {}, icon("devices"), "Devices", el("span", { class: "count" }, String(list.length)), icon("chevron", "icon chev")),
    el("ul", { class: "clients" }, ...list.map((d) => el("li", {},
      el("span", { class: "link-icon", title: d.link ?? "" }, d.wired ? icon("wired") : d.bars !== null ? signal(d.bars) : null),
      el("div", { class: "who" },
        el("strong", {}, d.name ?? "unknown"),
        el("span", { class: "muted" }, [d.ip, d.band].filter(Boolean).join(" · "))),
      d.isp.length
        ? el("div", { class: "segmented", role: "group", "aria-label": `ISP for ${d.name ?? d.ip}` }, ...d.isp.map((a) =>
          el("button", {
            class: a.selected ? "selected" : "",
            "aria-pressed": a.selected ? "true" : "false",
            disabled: a.disabled || a.selected,
            title: a.reason ?? (a.label === "Auto" && d.via ? `now via ${d.via}` : null),
            on: () => send(a),
          }, a.label)))
        : d.via ? el("span", { class: "via" }, d.via) : null))));
}

function tempsSection(c) {
  return el("details", { class: "section fold" },
    el("summary", {}, icon("thermo"), "Temperatures",
      el("span", { class: "temp-chips" }, ...c.tempGroups.slice(0, 2).map((g) =>
        el("span", { class: `chip ${g.level}` }, `${g.family} `, el("b", {}, g.text)))),
      icon("chevron", "icon chev")),
    el("dl", { class: "temps" }, ...c.temps.flatMap((t) => [
      el("dt", {}, `${t.chip} `, el("span", { class: "muted" }, t.label)),
      el("dd", { class: t.level }, t.text)])));
}

function eventsSection(events) {
  return el("details", { class: "section fold" },
    el("summary", {}, icon("activity"), "Activity", el("span", { class: "count" }, String(events.length)), icon("chevron", "icon chev")),
    el("ul", { class: "events" }, ...events.map((e) => {
      const [name, detail] = eventText(e);
      return el("li", {},
        el("time", { "data-at": e.at, title: new Date(e.at).toLocaleString() }),
        el("span", {}, el("b", {}, name), detail ? ` ${detail}` : ""));
    })));
}

function card(c, previous) {
  const node = el("section", { class: `card${c.wide ? " wide" : ""}${c.alert ? ` alerting ${c.alert.tone}` : ""}` },
    el("header", {},
      el("div", { class: "title" },
        el("h2", {}, c.id),
        el("span", { class: "kind" }, c.kind),
        c.subtitle || c.updated !== null ? el("div", { class: "sub" },
          c.subtitle ? el("span", {}, c.subtitle) : null,
          c.updated !== null ? el("span", { class: "fresh", "data-updated": c.updated }) : null) : null),
      el("span", { class: `badge ${c.badge.tone}` }, el("i"), c.badge.label)),
    c.alert ? el("div", { class: `alert ${c.alert.tone}` }, icon("alert"), c.alert.text) : null,
    c.pending ? el("div", { class: "pending" },
      el("span", {}, el("b", {}, c.pending.action), " in ", el("span", { "data-due": c.pending.due }), "s",
        el("span", { class: "muted" }, ` · from ${c.pending.source}`)),
      c.pending.cancel ? button({ label: "Cancel", ...c.pending.cancel }, "cancel") : null) : null,
    c.actions.length ? el("div", { class: "actions" }, ...c.actions.map((a) => button(a))) : null,
    c.facts.length ? el("div", { class: "tiles" }, ...c.facts.map((f) => el("div", { class: "tile" },
      el("span", { class: "label" }, f.label),
      "since" in f ? el("span", { class: "value", "data-since": f.since }) : el("span", { class: "value", title: f.value }, f.value)))) : null,
    c.meters.length ? el("div", { class: "meters" }, ...c.meters.map((m) => el("div", { class: "meter" },
      el("div", { class: "meter-head" }, el("span", { class: "label" }, m.label), el("span", { class: `value ${m.level}` }, m.text)),
      bar(m.pct, m.level)))) : null,
    c.ups ? upsSection(c.ups) : null,
    c.links.length ? linksSection(c.links) : null,
    c.clients.length ? clientsSection(c.clients) : null,
    c.temps.length ? tempsSection(c) : null,
    c.events.length ? eventsSection(c.events) : null);
  const wasOpen = [...(previous?.querySelectorAll("details") ?? [])].map((d) => d.open);
  node.querySelectorAll("details").forEach((d, i) => { d.open = wasOpen[i] ?? false; });
  return node;
}

function chip(c) {
  return el("span", { class: `summary-chip ${c.tone}` }, icon(c.icon), el("span", { class: "muted" }, c.label), el("b", {}, c.value));
}

function tick() {
  const now = Date.now();
  for (const n of $devices.querySelectorAll("[data-due]")) n.textContent = countdown(Number(n.dataset.due), now);
  for (const n of $devices.querySelectorAll("[data-since]")) n.textContent = elapsed(Number(n.dataset.since), now);
  for (const n of $devices.querySelectorAll("[data-at]")) n.textContent = ago((now - Number(n.dataset.at)) / 1000);
  for (const n of $devices.querySelectorAll("[data-updated]")) {
    const f = freshness(Number(n.dataset.updated), now);
    n.textContent = f.text;
    n.classList.toggle("stale", f.stale);
  }
}

// Rebuilds only the cards whose content changed and leaves the others in place, so hover, focus and open
// sections survive updates to other devices.
function render() {
  const next = new Map();
  const nodes = cards(registry).map((c) => {
    const key = JSON.stringify(c);
    const old = shown.get(c.id);
    const node = old?.key === key ? old.node : card(c, old?.node);
    next.set(c.id, { key, node });
    return node;
  });
  if (!nodes.length) nodes.push($empty);
  nodes.forEach((node, i) => {
    if ($devices.children[i] !== node) $devices.insertBefore(node, $devices.children[i] ?? null);
  });
  while ($devices.children.length > nodes.length) $devices.lastElementChild.remove();
  shown = next;
  $summary.replaceChildren(...summary(registry).map(chip));
  tick();
}

function setHub(text, cls) {
  $hub.replaceChildren(el("i"), text);
  $hub.className = `badge ${cls}`;
}

function connect() {
  if (!config.username || !config.password) {
    setHub("not configured", "crit");
    return;
  }
  setHub("connecting", "dim");
  client = window.mqtt.connect(config.url ?? `wss://${location.host}/mqtt`, {
    username: config.username,
    password: config.password,
    clientId: `console-${crypto.randomUUID().slice(0, 8)}`,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });
  client.on("connect", () => {
    setHub("connected", "ok");
    client.subscribe(`${ROOT}/#`, { qos: 1 });
  });
  client.on("close", () => setHub("disconnected", "crit"));
  client.on("message", (topic, payload, packet) => {
    if (apply(registry, { topic, payload: payload.toString(), retained: packet.retain, now: Date.now() })) render();
  });
}

render();
connect();
setInterval(tick, 1000);
