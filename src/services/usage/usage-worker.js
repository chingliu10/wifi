const pool = require('../../config/database');
const omada = require('../omada/open-api-client');
const { isInstalled, rememberClient, recordReading } = require('./usage-service');
const { normalizeMac, normalizeReading } = require('./usage-counters');

let timer = null;
let running = false;
const historyDays = () => Math.min(365, Math.max(1, Number(process.env.USAGE_HISTORY_DAYS) || 30));
const pageAll = async (readPage, maxPages = 200) => {
  const rows = [];
  const signatures = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const data = await readPage(page);
    if (!Array.isArray(data.rows) || !Number.isSafeInteger(data.total) || data.total < 0) throw Object.assign(new Error('Usage format'), { code: 'usage_format' });
    const signature = JSON.stringify(data.rows.map(row => [row.id || '', row.mac || '', row.associated || '']));
    if (data.rows.length && signatures.has(signature)) throw Object.assign(new Error('Usage pagination repeated'), { code: 'usage_pagination' });
    signatures.add(signature);
    rows.push(...data.rows);
    if (rows.length >= data.total) return rows;
    if (!data.rows.length) throw Object.assign(new Error('Usage pagination incomplete'), { code: 'usage_pagination' });
  }
  throw Object.assign(new Error('Usage page limit exceeded'), { code: 'usage_pagination' });
};

const collectSite = async (site, api, now) => {
  const siteId = site.site_id, org = site.organization_id;
  await pool.query('UPDATE usage_sites SET last_attempt_at = NOW() WHERE site_id = $1', [siteId]);
  let warning = null;
  const live = await pageAll(page => api.getUsagePage({ siteId: site.external_portal_site_id, page }));
  const readings = live.filter(row => row.active !== false).map(row => normalizeReading(row, { now })).filter(Boolean);
  if (live.some(row => row.active !== false && !normalizeReading(row, { now }))) warning = 'usage_format';
  const activeStarts = new Map(readings.map(row => [row.mac, row.startedAt]));

  if (!site.discovered_at || now - new Date(site.discovered_at).getTime() > 21600000) {
    try {
      const known = await pageAll(page => api.getUsagePage({ siteId: site.external_portal_site_id,
        known: true, page, start: now - historyDays() * 86400000, end: now }));
      for (const row of known) {
        const mac = normalizeMac(row.mac);
        if (mac) await rememberClient(pool, org, siteId, mac, String(row.name || '').slice(0, 120));
      }
      await pool.query('UPDATE usage_sites SET discovered_at = NOW() WHERE site_id = $1', [siteId]);
    } catch (error) { warning = error.code || 'usage_controller'; }
  }
  // Mark offline only after a complete successful client-list fetch.
  await pool.query('UPDATE usage_clients SET is_online = FALSE WHERE site_id = $1', [siteId]);
  for (const reading of readings) {
    await recordReading({ organizationId: org, siteId, reading });
    await pool.query(`UPDATE usage_clients SET is_online = TRUE, last_seen_at = $3
      WHERE site_id = $1 AND client_mac = $2`, [siteId, reading.mac, new Date(now)]);
  }
  let historyEnabled = site.history_supported !== false;
  if (site.history_supported === null && api.getUsageHistorySetting) {
    try {
      if (await api.getUsageHistorySetting() === false) {
        historyEnabled = false;
        await pool.query('UPDATE usage_sites SET history_supported = FALSE WHERE site_id = $1', [siteId]);
      }
    } catch (error) { /* Some older controllers omit this read-only settings endpoint. */ }
  }
  if (historyEnabled) {
    const batch = Math.min(20, Math.max(1, Number(process.env.USAGE_HISTORY_CLIENTS_PER_TICK) || 10));
    const clients = (await pool.query(`SELECT client_mac FROM usage_clients WHERE site_id = $1
      ORDER BY history_synced_at ASC NULLS FIRST, client_mac LIMIT $2`, [siteId, batch])).rows;
    for (const client of clients) {
      try {
        const history = await pageAll(page => api.getUsagePage({ siteId: site.external_portal_site_id,
          clientMac: client.client_mac, page }));
        const normalized = history.map(row => normalizeReading({ ...row, mac: row.mac || client.client_mac },
          { history: true, now, activeStart: activeStarts.get(client.client_mac) ?? null }));
        if (normalized.some(row => !row)) warning = 'usage_format';
        for (const reading of normalized.filter(Boolean).filter(row => row.observedAt >= now - historyDays() * 86400000)
          .sort((a, b) => a.startedAt - b.startedAt)) {
          await recordReading({ organizationId: org, siteId, reading });
        }
        await pool.query('UPDATE usage_clients SET history_synced_at = NOW() WHERE site_id = $1 AND client_mac = $2', [siteId, client.client_mac]);
        await pool.query('UPDATE usage_sites SET history_supported = TRUE WHERE site_id = $1', [siteId]);
      } catch (error) {
        warning = error.code || 'usage_history';
        if (/HTTP (403|404)|not supported|unsupported|permission|forbidden|not authorized/i.test(error.message)) {
          await pool.query('UPDATE usage_sites SET history_supported = FALSE WHERE site_id = $1', [siteId]);
          warning = 'usage_history';
          break;
        }
      }
    }
  } else { warning = 'usage_history'; }
  const safeWarning = ['usage_format', 'usage_pagination', 'usage_history'].includes(warning) ? warning : warning ? 'usage_controller' : null;
  await pool.query('UPDATE usage_sites SET last_success_at = NOW(), last_error_code = $2 WHERE site_id = $1', [siteId, safeWarning]);
};

const collectOnce = async ({ api = omada, now = Date.now() } = {}) => {
  if (!api.configured() || !await isInstalled()) return { sites: 0 };
  const lock = await pool.connect();
  let acquired = false;
  try {
    acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext('wifi-usage-collector')) AS locked")).rows[0].locked;
    if (!acquired) return { sites: 0 };
    const sites = (await pool.query(`SELECT u.*, s.external_portal_site_id FROM usage_sites u
      JOIN sites s ON s.id = u.site_id JOIN organizations o ON o.id = u.organization_id
      WHERE u.enabled AND s.active AND o.active AND s.external_portal_site_id IS NOT NULL ORDER BY u.site_id`)).rows;
    let requests = 0;
    const boundedApi = { ...api, getUsagePage: async args => {
      if (++requests > 200) throw Object.assign(new Error('Usage request budget exceeded'), { code: 'usage_pagination' });
      return api.getUsagePage(args);
    } };
    for (const site of sites) {
      try { await collectSite(site, boundedApi, now); }
      catch (error) {
        await pool.query("UPDATE usage_sites SET last_error_code = 'usage_controller' WHERE site_id = $1", [site.site_id]);
        console.error('USAGE COLLECTION FAILED:', { siteId: site.site_id, code: 'usage_controller' });
      }
    }
    return { sites: sites.length };
  } finally {
    try { if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext('wifi-usage-collector'))"); }
    finally { lock.release(); }
  }
};
const tick = async () => {
  if (running) return;
  running = true;
  try { await collectOnce(); }
  catch (error) { console.error('USAGE WORKER UNAVAILABLE'); }
  finally { running = false; }
};
const startUsageWorker = () => {
  if (timer || !omada.configured() || process.env.USAGE_HISTORY_ENABLED === 'false') return;
  const interval = Math.max(60000, Number(process.env.USAGE_HISTORY_POLL_MS) || 60000);
  timer = setInterval(tick, interval);
  timer.unref();
  // Do not hold up application startup or run controller requests until collection is opted in.
  const initial = setTimeout(tick, 10000);
  initial.unref();
};
module.exports = { pageAll, collectOnce, collectSite, startUsageWorker };
