const pool = require('../../config/database');
const omada = require('./open-api-client');

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};

const loadSite = async (siteId) => {
  const result = await pool.query(
    `
      SELECT id, name, external_portal_site_id
      FROM sites
      WHERE id = $1
        AND active = TRUE
      LIMIT 1
    `,
    [siteId]
  );

  return result.rows[0] || null;
};

const getRadiusSettings = () => {
  const serverIp = String(
    process.env.OMADA_RADIUS_SERVER_IP ||
    process.env.OMADA_INFORM_HOST ||
    ''
  ).trim();
  const sharedSecret = String(process.env.OMADA_RADIUS_SECRET || '');
  const authPort = Number(process.env.OMADA_RADIUS_AUTH_PORT || 1812);

  if (!serverIp) {
    throw new Error('OMADA_RADIUS_SERVER_IP is required');
  }

  if (!sharedSecret) {
    throw new Error(
      'OMADA_RADIUS_SECRET is required and must match the FreeRADIUS shared secret'
    );
  }

  if (!Number.isInteger(authPort) || authPort < 1 || authPort > 65535) {
    throw new Error('OMADA_RADIUS_AUTH_PORT must be a valid port');
  }

  return {
    serverIp,
    sharedSecret,
    authPort,
    profileName: String(
      process.env.OMADA_RADIUS_PROFILE_NAME || 'Solidus FreeRADIUS'
    ).trim()
  };
};

const getExternalPortalSettings = () => {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();

  if (!baseUrl) {
    throw new Error('PUBLIC_BASE_URL is required');
  }

  const url = new URL(baseUrl);
  const scheme = url.protocol.replace(':', '');

  if (!['http', 'https'].includes(scheme)) {
    throw new Error('PUBLIC_BASE_URL must use http or https');
  }

  const basePath = url.pathname.replace(/\/$/, '');
  const portalPath = `${basePath}/portal`.replace(/^\/+/, '/');

  return {
    hostType: 2,
    serverUrlScheme: scheme,
    serverUrl: `${url.host}${portalPath}`
  };
};

const ensureRadiusProfile = async (remoteSiteId) => {
  const settings = getRadiusSettings();
  const profiles = toArray(
    await omada.listRadiusProfiles({ siteId: remoteSiteId })
  );
  const existing = profiles.find(
    (profile) =>
      String(profile.name || '').toLowerCase() ===
      settings.profileName.toLowerCase()
  );

  if (existing?.radiusProfileId) {
    return existing;
  }

  await omada.createRadiusProfile({
    siteId: remoteSiteId,
    config: {
      name: settings.profileName,
      authServer: [
        {
          radiusServerIp: settings.serverIp,
          radiusPort: settings.authPort,
          radiusPwd: settings.sharedSecret,
          radSecEnable: false
        }
      ],
      radiusAccountingEnable: false,
      wirelessVlanAssignment: false,
      coaEnable: false,
      requireMessageAuthenticator: true
    }
  });

  const refreshed = toArray(
    await omada.listRadiusProfiles({ siteId: remoteSiteId })
  );
  const created = refreshed.find(
    (profile) =>
      String(profile.name || '').toLowerCase() ===
      settings.profileName.toLowerCase()
  );

  if (!created?.radiusProfileId) {
    throw new Error('Unable to verify the Solidus RADIUS profile in Omada');
  }

  return created;
};

const ensurePortal = async ({ remoteSiteId, ssidId, ssidName }) => {
  const name = `Solidus - ${ssidName}`.slice(0, 128);
  const portals = toArray(await omada.listPortals({ siteId: remoteSiteId }));
  const existing = portals.find((portal) => {
    const bound = Array.isArray(portal.ssidList) && portal.ssidList.includes(ssidId);
    return bound || String(portal.name || '').toLowerCase() === name.toLowerCase();
  });

  if (existing) {
    return existing;
  }

  const timeoutMinutes = Number(
    process.env.OMADA_PORTAL_AUTH_TIMEOUT_MINUTES || 1
  );

  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) {
    throw new Error('OMADA_PORTAL_AUTH_TIMEOUT_MINUTES must be at least 1');
  }

  await omada.createPortal({
    siteId: remoteSiteId,
    config: {
      name,
      enable: true,
      ssidList: [ssidId],
      networkList: [],
      authType: 4,
      authTimeout: {
        customTimeout: timeoutMinutes,
        customTimeoutUnit: 1
      },
      httpsRedirectEnable: true,
      landingPage: 1,
      externalPortal: getExternalPortalSettings()
    }
  });

  const refreshed = toArray(await omada.listPortals({ siteId: remoteSiteId }));
  const created = refreshed.find((portal) => {
    const bound = Array.isArray(portal.ssidList) && portal.ssidList.includes(ssidId);
    return bound || String(portal.name || '').toLowerCase() === name.toLowerCase();
  });

  if (!created) {
    throw new Error('Unable to verify the Solidus external portal in Omada');
  }

  return created;
};

const enableMacAuth = async ({ remoteSiteId, ssidId, radiusProfileId }) => {
  const current =
    (await omada.getMacAuthSetting({ siteId: remoteSiteId })) || {};

  const currentSsidIds = (current.ssids || [])
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }

      return item?.ssidId || item?.id || null;
    })
    .filter(Boolean);

  const ssids = Array.from(
    new Set([...currentSsidIds, String(ssidId)])
  );

  await omada.updateMacAuthSetting({
    siteId: remoteSiteId,
    config: {
      enable: true,
      ssids,
      radiusProfileId,
      mabEnable: true,
      macFormat: 2,
      emptyPwdEnable: false,
      nasId: String(current.nasId || '')
    }
  });

  return omada.getMacAuthSetting({ siteId: remoteSiteId });
};

const provisionHotspot = async ({ siteId, ssidId, ssidName }) => {
  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    throw new Error('This site is not linked to Omada yet');
  }

  if (!ssidId || !ssidName) {
    throw new Error('SSID ID and name are required for hotspot provisioning');
  }

  const radiusProfile = await ensureRadiusProfile(
    site.external_portal_site_id
  );
  const portal = await ensurePortal({
    remoteSiteId: site.external_portal_site_id,
    ssidId,
    ssidName
  });
  const macAuth = await enableMacAuth({
    remoteSiteId: site.external_portal_site_id,
    ssidId,
    radiusProfileId: radiusProfile.radiusProfileId
  });

  return {
    siteId: site.id,
    remoteSiteId: site.external_portal_site_id,
    ssidId,
    ssidName,
    radiusProfileId: radiusProfile.radiusProfileId,
    portalId: portal.portalId || portal.id || null,
    macAuthEnabled: Boolean(macAuth?.enable),
    macAuthFallbackEnabled: Boolean(macAuth?.mabEnable)
  };
};

module.exports = {
  provisionHotspot
};
