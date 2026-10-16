const pool = require('../../config/database');
const { normalizeMacAddress } = require('../../utils/mac-address');
const omada = require('./open-api-client');

const toOmadaMac = (value) => {
  const normalized = normalizeMacAddress(value);
  return normalized ? normalized.replace(/:/g, '-') : null;
};

const bandMaskFromName = (value) => {
  const band = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  if (band.startsWith('2.4')) return 1;
  if (band.startsWith('5')) return 2;
  if (band.startsWith('6')) return 4;

  return 0;
};

const describeBandMask = (mask) => {
  const labels = [];

  if (mask & 1) labels.push('2.4 GHz');
  if (mask & 2) labels.push('5 GHz');
  if (mask & 4) labels.push('6 GHz');

  return labels;
};

const loadSite = async (siteId) => {
  const result = await pool.query(
    `
      SELECT
        s.id,
        s.organization_id,
        s.name,
        s.external_portal_site_id
      FROM sites s
      WHERE s.id = $1
        AND s.active = TRUE
      LIMIT 1
    `,
    [siteId]
  );

  return result.rows[0] || null;
};

const loadSiteAps = async (siteId) => {
  const result = await pool.query(
    `
      SELECT
        id,
        name,
        model,
        ap_mac
      FROM network_devices
      WHERE site_id = $1
        AND active = TRUE
        AND device_type = 'omada'
        AND ap_mac IS NOT NULL
      ORDER BY id
    `,
    [siteId]
  );

  return result.rows;
};

const detectSiteRadioCapabilities = async (siteId) => {
  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    throw new Error('This site is not linked to Omada yet');
  }

  const aps = await loadSiteAps(site.id);

  if (!aps.length) {
    return {
      bandMask: 0,
      labels: [],
      supports24: false,
      supports5: false,
      supports6: false,
      supports24And5: false,
      supports24And6: false,
      supports5And6: false,
      supportsAll: false,
      devices: []
    };
  }

  let siteBandMask = 0;
  const devices = [];
  const errors = [];

  for (const ap of aps) {
    try {
      const radios = await omada.getApChannelInfo({
        siteId: site.external_portal_site_id,
        apMac: toOmadaMac(ap.ap_mac)
      });

      let apBandMask = 0;

      for (const radio of radios) {
        apBandMask |= bandMaskFromName(radio?.band);
      }

      siteBandMask |= apBandMask;

      devices.push({
        ...ap,
        bandMask: apBandMask,
        bandLabels: describeBandMask(apBandMask)
      });
    } catch (error) {
      errors.push(error);
      devices.push({
        ...ap,
        bandMask: 0,
        bandLabels: [],
        error: error.message
      });
    }
  }

  if (!siteBandMask && errors.length === aps.length) {
    throw errors[0];
  }

  return {
    bandMask: siteBandMask,
    labels: describeBandMask(siteBandMask),
    supports24: Boolean(siteBandMask & 1),
    supports5: Boolean(siteBandMask & 2),
    supports6: Boolean(siteBandMask & 4),
    supports24And5: (siteBandMask & 3) === 3,
    supports24And6: (siteBandMask & 5) === 5,
    supports5And6: (siteBandMask & 6) === 6,
    supportsAll: (siteBandMask & 7) === 7,
    devices
  };
};

const listSiteWifiNetworks = async (siteId) => {
  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    return [];
  }

  const wlanGroups = await omada.listSiteSsids({
    siteId: site.external_portal_site_id
  });

  const networks = [];

  for (const wlan of wlanGroups) {
    for (const ssid of wlan.ssidList || []) {
      networks.push({
        site_id: site.id,
        wlan_id: wlan.wlanId,
        wlan_name: wlan.wlanName,
        ssid_id: ssid.ssidId,
        name: ssid.ssidName
      });
    }
  }

  return networks;
};

const normalizeSsidName = (value) => {
  const name = String(value || '').trim();

  if (!name) {
    throw new Error('WiFi network name is required');
  }

  if (Array.from(name).length > 32) {
    throw new Error('WiFi network name must be 32 characters or fewer');
  }

  return name;
};

const resolveBand = ({ requested, capabilities }) => {
  if (!capabilities.bandMask) {
    throw new Error('No WiFi radio capability was detected for this site');
  }

  const preference = String(requested || 'auto').trim().toLowerCase();

  if (preference === 'auto') {
    return capabilities.bandMask;
  }

  const band = Number(preference);

  if (![1, 2, 3, 4, 5, 6, 7].includes(band)) {
    throw new Error('Invalid WiFi band selection');
  }

  if ((band & capabilities.bandMask) !== band) {
    throw new Error(
      'The selected WiFi band is not supported by the adopted access point'
    );
  }

  return band;
};

const createSiteWifiNetwork = async ({
  siteId,
  ssidName,
  bandPreference = 'auto'
}) => {
  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    throw new Error('This site is not linked to Omada yet');
  }

  const name = normalizeSsidName(ssidName);
  const existing = await listSiteWifiNetworks(site.id);

  if (
    existing.some(
      (network) => network.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    throw new Error('A WiFi network with this name already exists');
  }

  const capabilities = await detectSiteRadioCapabilities(site.id);
  const band = resolveBand({
    requested: bandPreference,
    capabilities
  });

  const wlanGroups = await omada.listWlanGroups({
    siteId: site.external_portal_site_id
  });

  const wlan =
    wlanGroups.find((group) => group.primary === true) ||
    wlanGroups[0];

  if (!wlan?.wlanId) {
    throw new Error(
      'Omada did not return a WLAN group for this site'
    );
  }

  await omada.createSsidV2({
    siteId: site.external_portal_site_id,
    wlanId: wlan.wlanId,
    ssidName: name,
    band
  });

  return {
    name,
    band,
    bandLabels: describeBandMask(band),
    wlanId: wlan.wlanId
  };
};

const renameSiteWifiNetwork = async ({
  siteId,
  wlanId,
  ssidId,
  ssidName
}) => {
  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    throw new Error('This site is not linked to Omada yet');
  }

  const name = normalizeSsidName(ssidName);
  const networks = await listSiteWifiNetworks(site.id);

  const target = networks.find(
    (network) =>
      String(network.wlan_id) === String(wlanId) &&
      String(network.ssid_id) === String(ssidId)
  );

  if (!target) {
    throw new Error('WiFi network was not found in this site');
  }

  if (
    networks.some(
      (network) =>
        String(network.ssid_id) !== String(ssidId) &&
        network.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    throw new Error('A WiFi network with this name already exists');
  }

  const detail = await omada.getSsidDetail({
    siteId: site.external_portal_site_id,
    wlanId,
    ssidId
  });

  if (Number(detail?.security) !== 0) {
    throw new Error(
      'Renaming password-protected WiFi networks is not enabled yet'
    );
  }

  await omada.updateSsidBasicConfig({
    siteId: site.external_portal_site_id,
    wlanId,
    ssidId,
    config: {
      name,
      band: Number(detail.band),
      guestNetEnable: Boolean(detail.guestNetEnable),
      security: Number(detail.security),
      broadcast: detail.broadcast !== false,
      vlanEnable: Boolean(detail.vlanEnable),
      mloEnable: Boolean(detail.mloEnable),
      pmfMode: Number(detail.pmfMode || 3),
      enable11r: Boolean(detail.enable11r)
    }
  });

  return {
    ...target,
    name
  };
};

module.exports = {
  detectSiteRadioCapabilities,
  listSiteWifiNetworks,
  createSiteWifiNetwork,
  renameSiteWifiNetwork
};
