const normalizeMac = (value) => {
  const mac = String(value || '').replace(/-/g, ':').toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
};
const bytes = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null;
  const result = BigInt(value);
  return result <= 9223372036854775807n ? result : null;
};
const timestamp = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const result = number < 100000000000 ? number * 1000 : number;
  return result >= Date.UTC(2000, 0, 1) && result < Date.UTC(2100, 0, 1) ? Math.floor(result / 1000) * 1000 : null;
};
const normalizeReading = (raw, { history = false, now = Date.now(), activeStart = null } = {}) => {
  if (!raw || typeof raw !== 'object') return null;
  const mac = normalizeMac(raw.mac);
  // These fields are bytes in the manufacturer's OpenAPI definitions. Rates are never counters.
  const down = bytes(history ? raw.download : raw.trafficDown);
  const up = bytes(history ? raw.upload : raw.trafficUp);
  const lastSeen = timestamp(raw.lastSeen);
  const uptime = Number(raw.uptime);
  const startedAt = history ? timestamp(raw.associated)
    : lastSeen && Number.isFinite(uptime) && uptime >= 0 ? Math.floor((lastSeen - uptime * 1000) / 1000) * 1000 : null;
  const observedAt = history ? lastSeen : lastSeen || Math.floor(now / 1000) * 1000;
  if (!mac || down === null || up === null || !startedAt || !observedAt || observedAt < startedAt ||
    observedAt - startedAt > 366 * 86400000 || observedAt > now + 60000) return null;
  const active = activeStart !== null && Math.abs(activeStart - startedAt) <= 5000;
  return { mac, name: String(raw.name || raw.hostName || '').slice(0, 120), down, up,
    startedAt, observedAt, history, final: history && !active,
    controllerId: history && raw.id ? String(raw.id).slice(0, 160) : null };
};
const localDay = (time) => new Date(time + 10800000).toISOString().slice(0, 10);

// Keep integer byte totals exact. Only a split across local midnight is estimated.
const allocateDays = (start, end, down, up) => {
  if (end <= start) { start = end; end += 1; }
  const duration = BigInt(end - start);
  const result = [];
  let cursor = start;
  while (cursor < end) {
    const day = localDay(cursor);
    const boundary = Date.parse(day + 'T00:00:00+03:00') + 86400000;
    const until = Math.min(end, boundary);
    const a = BigInt(cursor - start), b = BigInt(until - start);
    result.push({ day, down: down * b / duration - down * a / duration,
      up: up * b / duration - up * a / duration, estimated: localDay(start) !== localDay(end - 1) });
    cursor = until;
  }
  return result;
};
const formatBytes = (value) => {
  const number = Number(value || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = number > 0 ? Math.min(units.length - 1, Math.floor(Math.log(number) / Math.log(1000))) : 0;
  return (number / 1000 ** index).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' ' + units[index];
};
module.exports = { normalizeMac, bytes, timestamp, normalizeReading, allocateDays, localDay, formatBytes };
