const { bytes, formatBytes, localDay, normalizeMac } = require('./usage-counters');

const label = value => value === null || value === undefined ? '—' : formatBytes(value);
const totalLabel = (down, up) => down === null || down === undefined || up === null || up === undefined
  ? '—' : formatBytes(BigInt(down) + BigInt(up));

// Omada documents these fields as cumulative bytes for the current connection.
const connectionUsage = raw => {
  const down = bytes(raw.trafficDown), up = bytes(raw.trafficUp);
  return { downloadLabel: label(down), uploadLabel: label(up), totalLabel: totalLabel(down, up) };
};

const savedUsage = row => ({
  downloadLabel: label(row?.download), uploadLabel: label(row?.upload),
  totalLabel: totalLabel(row?.download, row?.upload), visits: row?.visits || '0',
  periodLabel: row?.first_seen && row?.last_seen
    ? localDay(new Date(row.first_seen).getTime()) + ' — ' + localDay(new Date(row.last_seen).getTime()) : '',
  estimated: Boolean(row?.estimated), provisional: Boolean(row?.provisional)
});

const liveUsageView = ({ clients, summary, organizationId, siteId, t, now = Date.now() }) => {
  const base = new URLSearchParams({ org: String(organizationId), siteId: String(siteId), range: 'last30' });
  const savedByMac = new Map((summary.clients || []).map(row => [row.client_mac, row]));
  const site = summary.site;
  const statusKey = summary.unavailable ? 'usage.unavailable' : !summary.installed ? 'usage.notInstalled'
    : !site?.enabled ? 'usage.paused' : site.last_error_code || site.history_supported === false ? 'usage.needsAttention'
      : !site.last_success_at ? 'usage.waiting'
        : now - new Date(site.last_success_at).getTime() > 180000 ? 'usage.stale' : 'usage.collecting';
  return {
    clients: clients.map(client => {
      const mac = normalizeMac(client.mac);
      const row = savedByMac.get(mac);
      return { ...client, recordedUsage: savedUsage(row),
        todayUsageLabel: totalLabel(row?.today_download, row?.today_upload),
        historyUrl: mac ? '/admin/usage?' + base + '&mac=' + encodeURIComponent(mac) : null };
    }),
    usageSummary: { recorded: savedUsage(summary.totals), today: savedUsage(summary.today),
      devices: summary.totals?.devices || '0', day: summary.day || localDay(now),
      statusLabel: t(statusKey), historyUrl: '/admin/usage?' + base,
      hasRecords: Number(summary.totals?.visits || 0) > 0 }
  };
};
module.exports = { connectionUsage, savedUsage, liveUsageView };
