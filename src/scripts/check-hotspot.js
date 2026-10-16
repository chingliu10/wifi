require('dotenv').config();

const pool = require('../config/database');
const omada = require('../services/omada/open-api-client');
const { listSiteWifiNetworks } = require('../services/omada/wifi-service');

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};

const normalize = (value) => String(value || '').trim().toLowerCase();

const expectedPortalUrl = () => {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  return baseUrl ? `${baseUrl}/portal` : null;
};

const extractPortalUrl = (portal) => {
  const external = portal?.externalPortal || portal?.externalServerPortal || {};
  const scheme = String(
    external.serverUrlScheme ||
    external.scheme ||
    ''
  ).replace(/:$/, '');
  const host = String(
    external.serverUrl ||
    external.url ||
    external.portalUrl ||
    ''
  ).trim();

  if (!host) return null;

  if (/^https?:\/\//i.test(host)) {
    return host.replace(/\/$/, '');
  }

  return scheme ? `${scheme}://${host}`.replace(/\/$/, '') : host;
};

const run = async () => {
  const ssidName = String(process.argv.slice(2).join(' ') || '').trim();

  if (!ssidName) {
    throw new Error('Usage: npm run omada:hotspot-check -- "SSID NAME"');
  }

  if (!omada.configured()) {
    throw new Error('Omada Open API is not enabled');
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
  const portals = toArray(await omada.listPortals({ siteId: remoteSiteId }));
  const macAuth = (await omada.getMacAuthSetting({ siteId: remoteSiteId })) || {};
  const radiusProfiles = toArray(
    await omada.listRadiusProfiles({ siteId: remoteSiteId })
  );

  const boundPortalSummary = portals.find((portal) =>
    Array.isArray(portal.ssidList) &&
    portal.ssidList.map(String).includes(String(network.ssid_id))
  );

  let portal = boundPortalSummary || null;

  if (portal) {
    const portalId = portal.portalId || portal.id;
    if (portalId) {
      try {
        portal = {
          ...portal,
          ...(await omada.getPortalDetail({
            siteId: remoteSiteId,
            portalId
          }))
        };
      } catch (error) {
        console.warn('Could not load portal detail:', error.message);
      }
    }
  }

  const portalUrl = extractPortalUrl(portal);
  const expectedUrl = expectedPortalUrl();
  const macSsids = Array.isArray(macAuth.ssids)
    ? macAuth.ssids
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }

          return item?.ssidId || item?.id || null;
        })
        .filter(Boolean)
        .map(String)
    : [];
  const macBound = macSsids.includes(String(network.ssid_id));
  const radiusProfile = radiusProfiles.find((profile) =>
    String(profile.radiusProfileId || profile.id) ===
    String(macAuth.radiusProfileId || '')
  );

  console.log('');
  console.log('=== Solidus hotspot check ===');
  console.log('Site:', site.name);
  console.log('SSID:', network.name);
  console.log('SSID ID:', network.ssid_id);
  console.log('Omada site ID:', remoteSiteId);
  console.log('');

  console.log('Portal bound to SSID:', portal ? 'YES' : 'NO');
  if (portal) {
    console.log('Portal name:', portal.name || '—');
    console.log('Portal enabled:', portal.enable === false ? 'NO' : 'YES');
    console.log('Portal auth type:', portal.authType ?? '—');
    console.log('Portal URL:', portalUrl || 'not visible in API response');
    console.log('Expected Solidus URL:', expectedUrl || 'PUBLIC_BASE_URL not set');
  }

  console.log('');
  console.log('MAC auth enabled:', macAuth.enable ? 'YES' : 'NO');
  console.log('MAC auth bound to this SSID:', macBound ? 'YES' : 'NO');
  console.log('MAC auth fallback enabled:', macAuth.mabEnable ? 'YES' : 'NO');
  console.log(
    'RADIUS profile:',
    radiusProfile?.name ||
    (macAuth.radiusProfileId ? `ID ${macAuth.radiusProfileId}` : 'NONE')
  );

  const portalMatches = Boolean(
    portal &&
    expectedUrl &&
    portalUrl &&
    normalize(portalUrl) === normalize(expectedUrl)
  );

  console.log('');
  console.log('=== Verdict ===');

  if (!portal) {
    console.log('NOT PROVISIONED: this SSID has no Omada portal bound to it.');
  } else if (!macAuth.enable || !macBound) {
    console.log('PARTIAL: portal exists, but MAC authentication is not fully enabled for this SSID.');
  } else if (portalUrl && expectedUrl && !portalMatches) {
    console.log('WRONG PORTAL: the SSID is bound to a portal, but it is not pointing to the configured Solidus portal URL.');
  } else if (!portalUrl) {
    console.log('LIKELY PROVISIONED: portal + MAC auth are bound, but Omada did not expose the external portal URL in this response.');
  } else {
    console.log('SOLIDUS HOTSPOT READY: portal, MAC auth and RADIUS are configured for this SSID.');
  }
};

run()
  .catch((error) => {
    console.error('Hotspot check failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
