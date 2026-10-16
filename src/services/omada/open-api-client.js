const https = require('https');
const http = require('http');

let tokenCache = null;

const configured = () =>
  String(process.env.OMADA_API_ENABLED || '').toLowerCase() === 'true';

const getConfig = () => {
  const baseUrl = String(
    process.env.OMADA_BASE_URL || 'https://127.0.0.1:8043'
  ).replace(/\/$/, '');

  const clientId = String(process.env.OMADA_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.OMADA_CLIENT_SECRET || '').trim();
  const omadacId = String(process.env.OMADA_OMADAC_ID || '').trim();

  if (!configured()) {
    throw new Error('Omada Open API is disabled');
  }

  if (!clientId || !clientSecret) {
    throw new Error('OMADA_CLIENT_ID and OMADA_CLIENT_SECRET are required');
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    omadacId,
    rejectUnauthorized:
      String(process.env.OMADA_TLS_REJECT_UNAUTHORIZED || 'false')
        .toLowerCase() === 'true'
  };
};

const requestJson = async ({
  method = 'GET',
  path,
  query,
  body,
  accessToken,
  allowOmadaError = false,
  timeoutMs = 15000
}) => {
  const config = getConfig();
  const url = new URL(path, config.baseUrl + '/');

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const payload = body === undefined ? null : JSON.stringify(body);
  const transport = url.protocol === 'http:' ? http : https;

  const headers = {
    Accept: 'application/json'
  };

  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  if (accessToken) {
    headers.Authorization = `AccessToken=${accessToken}`;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method,
        headers,
        rejectUnauthorized: config.rejectUnauthorized,
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};

          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (error) {
              const detail = raw
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 500);

              return reject(
                new Error(
                  `Omada returned non-JSON HTTP ${res.statusCode}` +
                  (detail ? `: ${detail}` : '')
                )
              );
            }
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(
                `Omada HTTP ${res.statusCode}: ${data.msg || data.error || 'request failed'}`
              )
            );
          }

          if (
            !allowOmadaError &&
            data &&
            data.errorCode !== undefined &&
            Number(data.errorCode) !== 0
          ) {
            const error = new Error(
              `Omada API ${data.errorCode}: ${data.msg || 'request failed'}`
            );
            error.omadaErrorCode = Number(data.errorCode);
            error.omadaResponse = data;
            return reject(error);
          }

          resolve(data);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Omada API request timed out'));
    });
    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
};

const getControllerInfo = async () => {
  const config = getConfig();

  const data = await requestJson({
    method: 'GET',
    path: '/api/info',
    allowOmadaError: true
  });

  const result = data.result || data;

  return {
    omadacId: config.omadacId || result.omadacId || result.controllerId || null,
    controllerVersion:
      result.controllerVer || result.controllerVersion || result.version || null,
    configured: result.configured
  };
};

const getOmadacId = async () => {
  const config = getConfig();

  if (config.omadacId) {
    return config.omadacId;
  }

  const info = await getControllerInfo();

  if (!info.omadacId) {
    throw new Error(
      'Unable to discover Omada ID. Set OMADA_OMADAC_ID from Platform Integration > Open API.'
    );
  }

  return info.omadacId;
};

const getAccessToken = async ({ force = false } = {}) => {
  if (
    !force &&
    tokenCache &&
    tokenCache.expiresAt > Date.now() + 60000
  ) {
    return tokenCache.accessToken;
  }

  const config = getConfig();
  const omadacId = await getOmadacId();

  const data = await requestJson({
    method: 'POST',
    path: '/openapi/authorize/token',
    query: {
      grant_type: 'client_credentials'
    },
    body: {
      omadacId,
      client_id: config.clientId,
      client_secret: config.clientSecret
    }
  });

  const accessToken = data.result?.accessToken;
  const expiresIn = Number(data.result?.expiresIn || 3600);

  if (!accessToken) {
    throw new Error('Omada did not return an access token');
  }

  tokenCache = {
    accessToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
  };

  return accessToken;
};

const openApi = async ({
  method = 'GET',
  path,
  query,
  body,
  allowOmadaError = false
}) => {
  const accessToken = await getAccessToken();
  const omadacId = await getOmadacId();
  const resolvedPath = path.replaceAll('{omadacId}', encodeURIComponent(omadacId));

  return requestJson({
    method,
    path: resolvedPath,
    query,
    body,
    accessToken,
    allowOmadaError
  });
};

const getOpenApiDocument = async () => {
  return requestJson({
    method: 'GET',
    path: '/v3/api-docs',
    allowOmadaError: true,
    timeoutMs: 90000
  });
};

const listSites = async () => {
  const data = await openApi({
    path: '/openapi/v1/{omadacId}/sites',
    query: { page: 1, pageSize: 1000 }
  });

  return data.result?.data || [];
};

const listScenarios = async () => {
  const data = await openApi({
    path: '/openapi/v1/{omadacId}/scenarios'
  });

  const result = data.result;

  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return [];
};

const createSite = async ({
  name,
  region,
  timeZone,
  scenario,
  username,
  password
}) => {
  const data = await openApi({
    method: 'POST',
    path: '/openapi/v1/{omadacId}/sites',
    body: {
      name,
      region,
      timeZone,
      scenario,
      deviceAccountSetting: {
        username,
        password
      }
    }
  });

  return data.result;
};

const listPendingDevices = async ({ siteId, searchKey }) => {
  const data = await openApi({
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/grid/devices/pending`,
    query: {
      page: 1,
      pageSize: 100,
      searchKey
    }
  });

  return data.result?.data || [];
};

const listDevices = async ({ siteId }) => {
  const data = await openApi({
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/devices`,
    query: {
      page: 1,
      pageSize: 100
    }
  });

  return data.result?.data || [];
};

const startAdoptDevice = async ({
  siteId,
  deviceMac,
  username,
  password
}) => {
  return openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/devices/${encodeURIComponent(deviceMac)}/start-adopt`,
    body: {
      username,
      password
    },
    allowOmadaError: true
  });
};

const getDeviceAdoptResult = async ({ siteId, deviceMac }) => {
  return openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/devices/${encodeURIComponent(deviceMac)}/adopt-result`,
    allowOmadaError: true
  });
};


const getApChannelInfo = async ({ siteId, apMac }) => {
  const data = await openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/aps/channel-info',
    body: {
      macList: [apMac]
    }
  });

  const result = data.result || data;

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  if (Array.isArray(result)) {
    return result;
  }

  return [];
};

const listSiteSsids = async ({ siteId }) => {
  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/wireless-network/ssids',
    query: {
      type: 1
    }
  });

  return Array.isArray(data.result) ? data.result : [];
};

const listWlanGroups = async ({ siteId }) => {
  const data = await openApi({
    path:
      `/openapi/v2/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/wireless-network/wlans',
    query: {
      page: 1,
      pageSize: 1000
    }
  });

  return data.result?.gridWlanGroup?.data || [];
};

const createSsidV2 = async ({
  siteId,
  wlanId,
  ssidName,
  band
}) => {
  const data = await openApi({
    method: 'POST',
    path:
      `/openapi/v2/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids`,
    body: {
      name: ssidName,
      band,
      security: 0,
      deviceType: 1,
      guestNetEnable: false,
      broadcast: true,
      vlanEnable: false
    }
  });

  return data.result;
};

const quickCreateSsid = async ({ siteId, ssidName, band }) => {
  const data = await openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/wireless-network/quick-create-ssid',
    body: {
      ssidName,
      band,
      deviceType: 1,
      security: 0,
      guestNetEnable: false
    }
  });

  return data.result;
};

const getSsidDetail = async ({ siteId, wlanId, ssidId }) => {
  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/wireless-network/wlans/${encodeURIComponent(wlanId)}` +
      `/ssids/${encodeURIComponent(ssidId)}`
  });

  return data.result || null;
};

const updateSsidBasicConfig = async ({
  siteId,
  wlanId,
  ssidId,
  config
}) => {
  return openApi({
    method: 'PATCH',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/wireless-network/wlans/${encodeURIComponent(wlanId)}` +
      `/ssids/${encodeURIComponent(ssidId)}/update-basic-config`,
    body: config
  });
};


const listPortals = async ({ siteId }) => {
  const data = await openApi({
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/portals`
  });

  const result = data.result;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return result || [];
};

const getPortalDetail = async ({ siteId, portalId }) => {
  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/portal/${encodeURIComponent(portalId)}`
  });

  return data.result || null;
};

const createRadiusProfile = async ({ siteId, config }) => {
  const data = await openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/profiles/radius',
    body: config
  });

  return data.result || null;
};

const updateMacAuthSetting = async ({ siteId, config }) => {
  const data = await openApi({
    method: 'PATCH',
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/mac-auth`,
    body: config
  });

  return data.result || data;
};

const createPortal = async ({ siteId, config }) => {
  const data = await openApi({
    method: 'POST',
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/portal`,
    body: config
  });

  return data.result || null;
};

const listRadiusProfiles = async ({ siteId }) => {
  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/profiles/radius'
  });

  const result = data.result;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return result || [];
};

const getMacAuthSetting = async ({ siteId }) => {
  const data = await openApi({
    path: `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/mac-auth`
  });

  return data.result || null;
};

const listClients = async ({
  siteId,
  page = 1,
  pageSize = 25
}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 25));

  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}/clients`,
    query: {
      page: safePage,
      pageSize: safePageSize
    }
  });

  const result = data.result || {};
  const rows = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result)
      ? result
      : [];

  const total = Number(
    result.totalRows ??
    result.total ??
    result.totalNum ??
    result.count ??
    rows.length
  );

  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length,
    page: safePage,
    pageSize: safePageSize
  };
};

const listHotspotAuthedClients = async ({
  siteId,
  page = 1,
  pageSize = 100,
  searchKey = null
}) => {
  const data = await openApi({
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/hotspot/authed-records',
    query: {
      page,
      pageSize,
      searchKey
    }
  });

  return data.result?.data || [];
};

const authClient = async ({ siteId, clientMac }) => {
  const normalizedMac = String(clientMac || '')
    .trim()
    .replace(/:/g, '-')
    .toUpperCase();

  if (!normalizedMac) {
    throw new Error('clientMac is required');
  }

  return openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/hotspot/clients/${encodeURIComponent(normalizedMac)}/auth`
  });
};

const cancelAuthClient = async ({ siteId, clientMac }) => {
  const normalizedMac = String(clientMac || '')
    .trim()
    .replace(/:/g, '-')
    .toUpperCase();

  if (!normalizedMac) {
    throw new Error('clientMac is required');
  }

  return openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      `/hotspot/clients/${encodeURIComponent(normalizedMac)}/unauth`
  });
};

const getPortalCandidates = async ({ siteId, body = {} }) => {
  const data = await openApi({
    method: 'POST',
    path:
      `/openapi/v1/{omadacId}/sites/${encodeURIComponent(siteId)}` +
      '/hotspot/portal/candidates',
    body
  });

  return data.result || null;
};

module.exports = {
  configured,
  getControllerInfo,
  getAccessToken,
  getOpenApiDocument,
  listSites,
  listScenarios,
  createSite,
  listPendingDevices,
  listDevices,
  startAdoptDevice,
  getDeviceAdoptResult,
  getApChannelInfo,
  listSiteSsids,
  listWlanGroups,
  createSsidV2,
  quickCreateSsid,
  getSsidDetail,
  updateSsidBasicConfig,
  listPortals,
  getPortalDetail,
  createRadiusProfile,
  listRadiusProfiles,
  getMacAuthSetting,
  updateMacAuthSetting,
  listClients,
  listHotspotAuthedClients,
  authClient,
  cancelAuthClient,
  getPortalCandidates,
  createPortal
};
