require('dotenv').config();

const pool = require('../config/database');
const omada = require('../services/omada/open-api-client');
const { listSiteWifiNetworks } = require('../services/omada/wifi-service');

const normalize = (value) => String(value || '').trim().toLowerCase();

const resolveRef = (spec, ref) => {
  if (!ref || !ref.startsWith('#/')) return null;

  return ref
    .slice(2)
    .split('/')
    .reduce((value, key) => value?.[key], spec);
};

const run = async () => {
  const ssidName = String(process.argv.slice(2).join(' ') || '').trim();

  if (!ssidName) {
    throw new Error('Usage: npm run omada:mac-auth-check -- "SSID NAME"');
  }

  const sites = (
    await pool.query(`
      SELECT id, name, external_portal_site_id
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
      if (normalize(network.name) === normalize(ssidName)) {
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
  const remoteSiteId = site.external_portal_site_id;

  const [macAuth, ssidDetail, spec] = await Promise.all([
    omada.getMacAuthSetting({ siteId: remoteSiteId }),
    omada.getSsidDetail({
      siteId: remoteSiteId,
      wlanId: network.wlan_id,
      ssidId: network.ssid_id
    }),
    omada.getOpenApiDocument()
  ]);

  const path =
    `/openapi/v1/{omadacId}/sites/{siteId}/mac-auth`;
  const operation = spec?.paths?.[path]?.patch;
  const content = operation?.requestBody?.content || {};
  const media = Object.values(content)[0];
  const schema = media?.schema || {};
  const resolved = schema.$ref ? resolveRef(spec, schema.$ref) : schema;

  console.log('');
  console.log('=== Omada MAC-auth diagnostic ===');
  console.log('Site:', site.name);
  console.log('SSID:', network.name);
  console.log('SSID ID:', network.ssid_id);
  console.log('WLAN ID:', network.wlan_id);
  console.log('');

  console.log('SSID detail:');
  console.log(JSON.stringify({
    security: ssidDetail?.security,
    band: ssidDetail?.band,
    guestNetEnable: ssidDetail?.guestNetEnable,
    vlanEnable: ssidDetail?.vlanEnable,
    broadcast: ssidDetail?.broadcast
  }, null, 2));

  console.log('');
  console.log('Current MAC auth:');
  console.log(JSON.stringify(macAuth || {}, null, 2));

  console.log('');
  console.log('PATCH /mac-auth request schema:');
  if (!resolved) {
    console.log('Schema not found');
  } else {
    console.log(JSON.stringify({
      required: resolved.required || [],
      properties: Object.fromEntries(
        Object.entries(resolved.properties || {}).map(([key, value]) => [
          key,
          {
            type: value.type || null,
            ref: value.$ref || value.items?.$ref || null,
            enum: value.enum || null
          }
        ])
      )
    }, null, 2));
  }
};

run()
  .catch((error) => {
    console.error('MAC-auth diagnostic failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
