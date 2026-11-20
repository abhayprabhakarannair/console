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

export function signal(dbm) {
  if (!Number.isFinite(dbm)) return "–";
  const quality = dbm >= -55 ? "excellent" : dbm >= -67 ? "good" : dbm >= -75 ? "fair" : "weak";
  return `${dbm} dBm (${quality})`;
}

export function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "–";
}
