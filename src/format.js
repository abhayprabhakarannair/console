export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function celsius(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} °C` : "–";
}

export function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "–";
}

export function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = value;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// Bits per second in decimal units, as ISPs quote them.
export function rate(bps) {
  if (!Number.isFinite(bps) || bps < 0) return "–";
  const units = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"];
  let v = bps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// Short "time ago" for freshness and activity: seconds, then minutes, hours, days.
export function ago(seconds) {
  if (!Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// "ok", "warn" or "crit" for a value against two ascending thresholds.
export function level(value, warn, crit) {
  if (!Number.isFinite(value)) return "ok";
  if (value >= crit) return "crit";
  return value >= warn ? "warn" : "ok";
}

// Wi-Fi signal as 1–4 bars; 0 when unknown.
export function signalBars(dbm) {
  if (!Number.isFinite(dbm)) return 0;
  if (dbm >= -55) return 4;
  if (dbm >= -65) return 3;
  if (dbm >= -75) return 2;
  return 1;
}
