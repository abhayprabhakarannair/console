import { apply, createRegistry, ROOT } from "./model.js";
import { cards } from "./view.js";

const config = window.CONSOLE ?? {};
const registry = createRegistry();
const $devices = document.getElementById("devices");
const $hub = document.getElementById("hub");
let client = null;

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
    class: `${extra} ${action.label === "Shut down" ? "danger" : ""}`.trim(),
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

function card(c) {
  const hot = c.hottest ? el("span", { class: "hot" }, `${c.hottest.chip} ${c.hottest.label} ${c.hottest.text}`) : null;
  return el("section", { class: "card" },
    el("header", {},
      el("span", { class: `dot ${c.power}` }),
      el("h2", {}, c.id),
      el("span", { class: "tag" }, c.kind),
      el("span", { class: `pill ${c.status}` }, c.status)),
    el("p", { class: "power" }, `power: ${c.power}`),
    c.pending ? el("div", { class: "pending" },
      el("span", {}, `${c.pending.action} in ${c.pending.remaining}s (from ${c.pending.source})`),
      c.pending.cancel ? button({ label: "Cancel", ...c.pending.cancel }, "cancel") : null) : null,
    c.actions.length ? el("div", { class: "actions" }, ...c.actions.map((a) => button(a, a.label === "Wake" ? "primary" : ""))) : null,
    c.facts.length ? el("dl", {}, ...c.facts.flatMap((f) => [el("dt", {}, f.label), el("dd", {}, f.value)])) : null,
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
}

function render() {
  const open = new Set([...$devices.querySelectorAll("details[open]")].map((d) => d.closest(".card")?.querySelector("h2")?.textContent));
  const list = cards(registry, Date.now());
  $devices.replaceChildren(...(list.length ? list.map(card) : [el("p", { class: "empty" }, "No devices on the bus yet.")]));
  for (const d of $devices.querySelectorAll("details")) {
    if (open.has(d.closest(".card").querySelector("h2").textContent)) d.open = true;
  }
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
setInterval(render, 1000);
