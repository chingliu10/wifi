const https = require('https');
const http = require('http');

const normalizeMac = (value) =>
  String(value || '').trim().replace(/:/g, '-').toUpperCase();

const getConfig = () => ({
  baseUrl: String(
    process.env.OMADA_BASE_URL || 'https://127.0.0.1:8043'
  ).replace(/\/$/, ''),
  controllerId: String(
    process.env.OMADA_HOTSPOT_CONTROLLER_ID ||
    process.env.OMADA_OMADAC_ID ||
    ''
  ).trim(),
  username: String(
    process.env.OMADA_HOTSPOT_OPERATOR_USERNAME || ''
  ).trim(),
  password: String(
    process.env.OMADA_HOTSPOT_OPERATOR_PASSWORD || ''
  )
});

const configured = () => {
  const config = getConfig();

  return Boolean(
    config.baseUrl &&
    config.controllerId &&
    config.username &&
    config.password
  );
};

const requestJson = ({
  method = 'POST',
  url,
  body,
  headers = {},
  rejectUnauthorized = false
}) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method,
        rejectUnauthorized,
        headers: {
          Accept: 'application/json',
          ...(payload !== null
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
              }
            : {}),
          ...headers
        }
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
              return reject(
                new Error(
                  'Omada hotspot API returned non-JSON HTTP ' +
                    res.statusCode +
                    ': ' +
                    raw.replace(/\s+/g, ' ').trim().slice(0, 300)
                )
              );
            }
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data
          });
        });
      }
    );

    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
};

const extractSessionCookie = (setCookie) => {
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];

  for (const value of values) {
    const match = String(value).match(/TPOMADA_SESSIONID=([^;]+)/i);

    if (match) {
      return 'TPOMADA_SESSIONID=' + match[1];
    }
  }

  return null;
};

const login = async () => {
  const config = getConfig();

  if (!configured()) {
    throw new Error(
      'Omada Hotspot Operator credentials are not configured'
    );
  }

  const response = await requestJson({
    url:
      config.baseUrl +
      '/' +
      encodeURIComponent(config.controllerId) +
      '/api/v2/hotspot/login',
    body: {
      name: config.username,
      password: config.password
    }
  });

  if (Number(response.data?.errorCode) !== 0) {
    throw new Error(
      'Omada Hotspot Operator login failed: ' +
        (response.data?.msg ||
          response.data?.errorCode ||
          response.statusCode)
    );
  }

  const csrfToken = response.data?.result?.token;
  const cookie = extractSessionCookie(response.headers['set-cookie']);

  if (!csrfToken) {
    throw new Error('Omada Hotspot Operator login returned no CSRF token');
  }

  if (!cookie) {
    throw new Error(
      'Omada Hotspot Operator login returned no TPOMADA_SESSIONID'
    );
  }

  return {
    csrfToken,
    cookie
  };
};

const authorizeExternalPortalClient = async ({
  clientMac,
  clientIp,
  apMac,
  ssidName,
  radioId,
  durationMs,
  originUrl = ''
}) => {
  const config = getConfig();
  const normalizedClientMac = normalizeMac(clientMac);
  const normalizedApMac = normalizeMac(apMac);
  const safeClientIp = String(clientIp || '').trim();
  const safeSsidName = String(ssidName || '').trim();
  const safeRadioId = Number(radioId);
  const safeDurationMs = Math.floor(Number(durationMs));

  if (!normalizedClientMac) {
    throw new Error('Omada external portal clientMac is required');
  }

  if (!safeClientIp) {
    throw new Error('Omada external portal clientIp is required');
  }

  if (!normalizedApMac) {
    throw new Error('Omada external portal apMac is required');
  }

  if (!safeSsidName) {
    throw new Error('Omada external portal ssidName is required');
  }

  if (![0, 1, 2].includes(safeRadioId)) {
    throw new Error('Omada external portal radioId is invalid');
  }

  if (!Number.isFinite(safeDurationMs) || safeDurationMs <= 0) {
    throw new Error('Omada external portal duration has already expired');
  }

  const session = await login();

  const response = await requestJson({
    url:
      config.baseUrl +
      '/' +
      encodeURIComponent(config.controllerId) +
      '/api/v2/hotspot/extPortal/auth',
    headers: {
      'Csrf-Token': session.csrfToken,
      Cookie: session.cookie
    },
    body: {
      clientMac: normalizedClientMac,
      clientIp: safeClientIp,
      apMac: normalizedApMac,
      ssidName: safeSsidName,
      radioId: safeRadioId,
      // Omada treats this field as a duration in milliseconds.
      time: safeDurationMs,
      authType: 4,
      originUrl: String(originUrl || ''),
      totalTrafficLimitBytes: 0,
      downloadRateLimitKbps: 0,
      uploadRateLimitKbps: 0
    }
  });

  if (Number(response.data?.errorCode) !== 0) {
    throw new Error(
      'Omada external portal authorization failed: ' +
        (response.data?.msg ||
          response.data?.errorCode ||
          response.statusCode)
    );
  }

  return {
    authorized: true,
    durationMs: safeDurationMs
  };
};

module.exports = {
  configured,
  authorizeExternalPortalClient
};
