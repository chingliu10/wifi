require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const omada = require('../services/omada/open-api-client');
const { isInstalled } = require('../services/usage/usage-service');
const { collectOnce } = require('../services/usage/usage-worker');
const { normalizeReading } = require('../services/usage/usage-counters');

const run = async () => {
  const mode = process.argv[2];
  if (mode === 'migrate') {
    await pool.query(fs.readFileSync(path.resolve(__dirname, '../db/migrations/024_usage_history.sql'), 'utf8'));
    console.log('Usage history reporting tables installed. Collection is paused until enabled per site.');
    return;
  }
  if (mode === 'sync') { console.log(await collectOnce()); return; }
  if (mode !== 'check') throw new Error('Choose migrate, check or sync');
  console.log('Usage history installed:', await isInstalled());
  if (!omada.configured()) throw new Error('Omada API is disabled');
  const info = await omada.getControllerInfo();
  console.log('Controller version:', info.controllerVersion || 'unknown');
  try { console.log('Controller client history enabled:', await omada.getUsageHistorySetting()); }
  catch (error) { console.log('History-retention setting is not exposed by this controller.'); }
  const site = (await pool.query(`SELECT external_portal_site_id FROM sites
    WHERE active AND external_portal_site_id IS NOT NULL ORDER BY id LIMIT 1`)).rows[0];
  if (!site) throw new Error('No connected Omada site');
  const live = await omada.getUsagePage({ siteId: site.external_portal_site_id });
  console.log('Client count:', live.total);
  console.log('Live reply fields:', Object.keys(live.rows[0] || {}).join(', '));
  console.log('Documented byte counters:', live.rows[0] ? Boolean(normalizeReading(live.rows[0])) : 'No connected clients to inspect');
  const known = await omada.getUsagePage({ siteId: site.external_portal_site_id, known: true,
    start: Date.now() - 30 * 86400000, end: Date.now() });
  console.log('Known client count:', known.total);
  const mac = live.rows[0]?.mac || known.rows[0]?.mac;
  if (mac) {
    const history = await omada.getUsagePage({ siteId: site.external_portal_site_id, clientMac: mac });
    console.log('History reply fields:', Object.keys(history.rows[0] || {}).join(', '));
    console.log('Usable session history:', history.rows[0] ? Boolean(normalizeReading(history.rows[0], { history: true })) : 'No retained visits for this device');
  }
  console.log('Read-only check completed. No controller settings, access or payment records were changed.');
};
run().catch(error => { console.error('Usage history command failed:', error.code || error.omadaErrorCode || 'Check database / controller configuration and read permissions.'); process.exitCode = 1; })
  .finally(() => pool.end());
