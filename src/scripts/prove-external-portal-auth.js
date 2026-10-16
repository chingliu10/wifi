require('dotenv').config();

const https = require('https');
const http = require('http');
const omada = require('../services/omada/open-api-client');

const args = process.argv.slice(2);

const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const requiredArg = (name) => {
  const value = getArg(name);
  if (!value) {
    throw new Error('Missing required argument: ' + name);
  }
  return value;
};

const normalizeMac = (value) =>
  String(value || '').trim().replace(/:/g, '-').toUpperCase();

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
                  'Controller returned non-JSON HTTP ' +
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

const formatLocal = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));

const run = async () => {
  const operatorUsername = String(
    process.env.OMADA_HOTSPOT_OPERATOR_USERNAME || ''
  ).trim();
  const operatorPassword = String(
    process.env.OMADA_HOTSPOT_OPERATOR_PASSWORD || ''
  );

  if (!operatorUsername || !operatorPassword) {
    throw new Error(
      'Set OMADA_HOTSPOT_OPERATOR_USERNAME and OMADA_HOTSPOT_OPERATOR_PASSWORD in .env first'
    );
  }

  const baseUrl = String(
    process.env.OMADA_BASE_URL || 'https://127.0.0.1:8043'
  ).replace(/\/$/, '');

  const controllerId = String(
    process.env.OMADA_HOTSPOT_CONTROLLER_ID ||
    process.env.OMADA_OMADAC_ID ||
    ''
  ).trim();

  if (!controllerId) {
    throw new Error(
      'Set OMADA_HOTSPOT_CONTROLLER_ID or OMADA_OMADAC_ID in .env'
    );
  }

  const clientMac = normalizeMac(requiredArg('--client-mac'));
  const clientIp = requiredArg('--client-ip');
  const apMac = normalizeMac(requiredArg('--ap-mac'));
  const ssidName = requiredArg('--ssid');
  const radioId = Number(requiredArg('--radio-id'));
  const seconds = Number(getArg('--seconds') || 120);
  const originUrl = String(getArg('--origin-url') || '');

  if (![0, 1, 2].includes(radioId)) {
    throw new Error('--radio-id must be a valid Omada radio ID');
  }

  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    throw new Error('--seconds must be an integer between 30 and 3600');
  }

  const loginUrl =
    baseUrl +
    '/' +
    encodeURIComponent(controllerId) +
    '/api/v2/hotspot/login';

  console.log('');
  console.log('=== Omada External Portal proof ===');
  console.log('Controller:', baseUrl);
  console.log('SSID:', ssidName);
  console.log('Client MAC:', clientMac);
  console.log('Client IP:', clientIp);
  console.log('AP MAC:', apMac);
  console.log('Radio ID:', radioId);
  console.log('Requested access:', seconds, 'seconds');
  console.log('');

  console.log('1. Logging in with Hotspot Operator...');

  const login = await requestJson({
    url: loginUrl,
    body: {
      name: operatorUsername,
      password: operatorPassword
    }
  });

  if (Number(login.data?.errorCode) !== 0) {
    throw new Error(
      'Hotspot Operator login failed: ' +
        (login.data?.msg || login.data?.errorCode || login.statusCode)
    );
  }

  const csrfToken = login.data?.result?.token;
  const cookie = extractSessionCookie(login.headers['set-cookie']);

  if (!csrfToken) {
    throw new Error('Controller login succeeded but returned no CSRF token');
  }

  if (!cookie) {
    throw new Error(
      'Controller login succeeded but returned no TPOMADA_SESSIONID cookie'
    );
  }

  console.log('   Login: OK');
  console.log('   CSRF token: received');
  console.log('   Session cookie: received');

  const durationMs = seconds * 1000;
  const expectedExpiresAt = Date.now() + durationMs;
  const authUrl =
    baseUrl +
    '/' +
    encodeURIComponent(controllerId) +
    '/api/v2/hotspot/extPortal/auth';

  console.log('');
  console.log('2. Authorizing captive client for exact duration...');
  console.log('   Duration:', durationMs, 'ms');
  console.log(
    '   Expected expiry:',
    formatLocal(expectedExpiresAt),
    'Africa/Dar_es_Salaam'
  );

  const auth = await requestJson({
    url: authUrl,
    headers: {
      'Csrf-Token': csrfToken,
      Cookie: cookie
    },
    body: {
      clientMac,
      clientIp,
      apMac,
      ssidName,
      radioId,
      /*
       * Omada's current documentation labels this field "Authentication
       * Expiration time", but the controller treats it as a duration in
       * milliseconds. Passing an epoch timestamp causes multi-decade
       * sessions (start + epochMilliseconds).
       */
      time: durationMs,
      authType: 4,
      originUrl,
      totalTrafficLimitBytes: 0,
      downloadRateLimitKbps: 0,
      uploadRateLimitKbps: 0
    }
  });

  if (Number(auth.data?.errorCode) !== 0) {
    throw new Error(
      'External Portal authorization failed: ' +
        (auth.data?.msg || auth.data?.errorCode || auth.statusCode)
    );
  }

  console.log('   Authorization response: OK (errorCode 0)');

  console.log('');
  console.log('3. Checking Omada authenticated records...');

  let records = [];
  try {
    records = await omada.listHotspotAuthedClients({
      siteId: requiredArg('--site-id'),
      page: 1,
      pageSize: 100,
      searchKey: clientMac
    });
  } catch (error) {
    console.log('   Record lookup failed:', error.message);
  }

  const matches = records.filter((record) => {
    const candidate = normalizeMac(record.mac);
    return candidate === clientMac;
  });

  if (!matches.length) {
    console.log('   No matching authenticated record returned yet.');
  } else {
    const newest = matches[0];

    console.log('   Auth type:', newest.authType);
    console.log('   Valid:', newest.valid);
    console.log('   Record start:', newest.start || '—');
    console.log('   Record end:', newest.end || '—');
    console.log('   Duration:', newest.duration || '—');
  }

  console.log('');
  console.log('=== PROOF TEST ===');
  console.log(
    'With mobile data OFF, the phone should get Internet immediately without toggling Wi-Fi.'
  );
  console.log(
    'After ' + seconds + ' seconds, Internet should stop and the captive portal should return.'
  );
  console.log(
    'Do not make another payment and do not run omada:unauth-client during this proof.'
  );
};

run().catch((error) => {
  console.error('External Portal proof failed:', error.message);
  process.exitCode = 1;
});
