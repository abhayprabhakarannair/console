import { apply, createRegistry, ROOT } from "./model.js";
import { cards, countdown, elapsed } from "./view.js";

const config = window.CONSOLE ?? {};
const registry = createRegistry();
const $devices = document.getElementById("devices");
const $hub = document.getElementById("hub");
const $empty = el("p", { class: "empty" }, "No devices on the bus yet.");
let client = null;
let shown = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "on") node.addEventListener("click", v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function send({ topic, payload, confirm: question }) {
  if (question && !window.confirm(question)) return;
  client?.publish(topic, payload, { qos: 1 });
}

function button(action, extra = "") {
  return el("button", {
    class: [extra, action.style].filter(Boolean).join(" "),
    disabled: action.disabled,
    title: action.reason ?? null,
    on: () => send(action),
  }, action.label);
}

function eventText(e) {
  const { event, at, ...rest } = e;
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  return `${event}${detail ? ` · ${detail}` : ""}`;
}

function card(c, previous) {
  const hot = c.hottest ? el("span", { class: "hot" }, `${c.hottest.chip} ${c.hottest.label} ${c.hottest.text}`) : null;
  const node = el("section", { class: "card" },
    el("header", {},
      el("span", { class: `dot ${c.power}` }),
      el("h2", {}, c.id),
      el("span", { class: "tag" }, c.kind),
      el("span", { class: `pill ${c.status}` }, c.status)),
    el("p", { class: "power" }, `power: ${c.power}`),
    c.pending ? el("div", { class: "pending" },
      el("span", {}, `${c.pending.action} in `, el("span", { "data-due": c.pending.due }), `s (from ${c.pending.source})`),
      c.pending.cancel ? button({ label: "Cancel", ...c.pending.cancel }, "cancel") : null) : null,
    c.actions.length ? el("div", { class: "actions" }, ...c.actions.map((a) => button(a))) : null,
    c.facts.length ? el("dl", {}, ...c.facts.flatMap((f) => [
      el("dt", {}, f.label), "since" in f ? el("dd", { "data-since": f.since }) : el("dd", {}, f.value)])) : null,
    c.links.length ? el("ul", { class: "links" },
      ...c.links.map((l) => el("li", {},
        el("span", { class: `pill ${l.status === "online" ? "online" : "offline"}` }, l.status),
        ` ${l.name}`, l.active ? el("span", { class: "tag" }, "active") : null,
        l.usage ? el("span", { class: "usage" }, l.usage) : null))) : null,
    c.clients.length ? el("details", {},
      el("summary", {}, `Devices online (${c.clients.length})`),
      el("ul", { class: "clients" }, ...c.clients.map((d) => el("li", {},
        el("div", { class: "who" }, el("strong", {}, d.name ?? "?"), ` ${d.ip}`),
        el("div", { class: "how" }, [d.link, d.via ? `via ${d.via}` : null].filter(Boolean).join(" · ")),
        d.isp.length ? el("div", { class: "isp" }, ...d.isp.map((a) =>
          el("button", {
            class: a.selected ? "selected" : "",
            disabled: a.disabled || a.selected,
            title: a.reason ?? null,
            on: () => send(a),
          }, a.label))) : null)))) : null,
    c.temps.length ? el("details", {},
      el("summary", {}, "Temperatures ", hot),
      el("dl", {}, ...c.temps.flatMap((t) => [el("dt", {}, `${t.chip} ${t.label}`), el("dd", {}, t.text)]))) : null,
    c.events.length ? el("ul", { class: "events" },
      ...c.events.map((e) => el("li", {}, el("time", {}, new Date(e.at).toLocaleTimeString()), eventText(e)))) : null);
  const wasOpen = [...(previous?.querySelectorAll("details") ?? [])].map((d) => d.open);
  node.querySelectorAll("details").forEach((d, i) => { d.open = wasOpen[i] ?? false; });
  return node;
}

function tick() {
  const now = Date.now();
  for (const n of $devices.querySelectorAll("[data-due]")) n.textContent = countdown(Number(n.dataset.due), now);
  for (const n of $devices.querySelectorAll("[data-since]")) n.textContent = elapsed(Number(n.dataset.since), now);
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
  tick();
}

function setHub(text, cls) {
  $hub.textContent = text;
  $hub.className = `pill ${cls}`;
}

function connect() {
  if (!config.username || !config.password) {
    setHub("not configured", "offline");
    return;
  }
  setHub("connecting", "unknown");
  client = window.mqtt.connect(config.url ?? `wss://${location.host}/mqtt`, {
    username: config.username,
    password: config.password,
    clientId: `console-${crypto.randomUUID().slice(0, 8)}`,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });
  client.on("connect", () => {
    setHub("connected", "online");
    client.subscribe(`${ROOT}/#`, { qos: 1 });
  });
  client.on("close", () => setHub("disconnected", "offline"));
  client.on("message", (topic, payload, packet) => {
    if (apply(registry, { topic, payload: payload.toString(), retained: packet.retain, now: Date.now() })) render();
  });
}

render();
connect();
setInterval(tick, 1000);
