require('dotenv').config();

const pool = require('../config/database');
const { listSiteWifiNetworks } = require('../services/omada/wifi-service');
const { provisionHotspot } = require('../services/omada/hotspot-service');

const run = async () => {
  const ssidName = String(process.argv.slice(2).join(' ') || '').trim();

  if (!ssidName) {
    throw new Error('Usage: npm run omada:hotspot-provision -- "SSID NAME"');
  }

  const sites = (
    await pool.query(`
      SELECT id, name
      FROM sites
      WHERE active = TRUE
        AND external_portal_site_id IS NOT NULL
      ORDER BY id
    `)
  ).rows;

  const matches = [];

  for (const site of sites) {
    const networks = await listSiteWifiNetworks(site.id);

    for (const network of networks) {
      if (network.name.toLowerCase() === ssidName.toLowerCase()) {
        matches.push({ site, network });
      }
    }
  }

  if (!matches.length) {
    throw new Error('No active Solidus site contains that SSID');
  }

  if (matches.length > 1) {
    throw new Error('More than one site contains that SSID');
  }

  const { site, network } = matches[0];
  console.log('Provisioning hotspot:', network.name);
  console.log('Solidus site:', site.name);

  const result = await provisionHotspot({
    siteId: site.id,
    ssidId: network.ssid_id,
    ssidName: network.name
  });

  console.log('Hotspot provisioning complete');
  console.log('SSID ID:', result.ssidId);
  console.log('Portal ID:', result.portalId || 'created');
  console.log('RADIUS profile ID:', result.radiusProfileId);
  console.log('MAC auth enabled:', result.macAuthEnabled ? 'yes' : 'no');
  console.log(
    'MAC auth fallback enabled:',
    result.macAuthFallbackEnabled ? 'yes' : 'no'
  );
  console.log(
    'Solidus SSID MAC auth disabled:',
    result.solidusSsidMacAuthDisabled ? 'yes' : 'no'
  );
};

run()
  .catch((error) => {
    console.error('Hotspot provisioning failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
