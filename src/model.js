export const ROOT = "home";
export const STATUSES = new Set(["online", "offline", "suspended"]);
export const MAX_EVENTS = 20;

const ID = /^[a-z0-9_-]{1,31}$/;

export function createRegistry() {
  return new Map();
}

function device(registry, id) {
  let d = registry.get(id);
  if (!d) {
    d = { id, meta: null, status: null, state: null, stateAt: null, statusAt: null, events: [] };
    registry.set(id, d);
  }
  return d;
}

function parseObject(payload) {
  try {
    const value = JSON.parse(payload);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function forget(registry, d) {
  if (d.meta === null && d.status === null && d.state === null && d.events.length === 0) registry.delete(d.id);
}

// Applies one bus message. Returns the device id it changed, or null if the message was ignored.
export function apply(registry, { topic, payload, retained = false, now }) {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== ROOT || !ID.test(parts[1])) return null;
  const [, id, leaf] = parts;
  const existing = registry.get(id);

  if (payload === "" && ["meta", "status", "state"].includes(leaf)) {
    if (!existing || existing[leaf] === null) return null;
    existing[leaf] = null;
    if (leaf === "state") existing.stateAt = null;
    if (leaf === "status") existing.statusAt = null;
    forget(registry, existing);
    return id;
  }

  switch (leaf) {
    case "meta": {
      const meta = parseObject(payload);
      if (!meta || typeof meta.kind !== "string" || meta.kind === "") return null;
      device(registry, id).meta = meta;
      return id;
    }
    case "status": {
      if (!STATUSES.has(payload)) return null;
      const d = device(registry, id);
      d.status = payload;
      d.statusAt = now;
      return id;
    }
    case "state": {
      const state = parseObject(payload);
      if (!state) return null;
      const d = device(registry, id);
      d.state = state;
      // A retained state was published at some unknown earlier time, so it has no age until a live one arrives.
      d.stateAt = retained ? null : now;
      return id;
    }
    case "event": {
      if (retained) return null;
      const event = parseObject(payload);
      if (!event || typeof event.event !== "string") return null;
      const d = device(registry, id);
      d.events.push({ ...event, at: now });
      if (d.events.length > MAX_EVENTS) d.events.splice(0, d.events.length - MAX_EVENTS);
      return id;
    }
    default:
      return null;
  }
}
