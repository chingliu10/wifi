require('dotenv').config();

const https = require('https');
const http = require('http');

const baseUrl = String(
  process.env.OMADA_BASE_URL || 'https://127.0.0.1:8043'
).replace(/\/$/, '');

const controllerId = String(
  process.env.OMADA_HOTSPOT_CONTROLLER_ID ||
  process.env.OMADA_OMADAC_ID ||
  ''
).trim();

const username = String(
  process.env.OMADA_HOTSPOT_OPERATOR_USERNAME || ''
).trim();

const password = String(
  process.env.OMADA_HOTSPOT_OPERATOR_PASSWORD || ''
);

const requestJson = ({ url, body }) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
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

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data
          });
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
};

const run = async () => {
  if (!controllerId) {
    throw new Error('OMADA_OMADAC_ID is missing');
  }

  if (!username) {
    throw new Error('OMADA_HOTSPOT_OPERATOR_USERNAME is missing');
  }

  if (!password) {
    throw new Error('OMADA_HOTSPOT_OPERATOR_PASSWORD is missing');
  }

  const url =
    baseUrl +
    '/' +
    encodeURIComponent(controllerId) +
    '/api/v2/hotspot/login';

  console.log('=== Omada Hotspot Operator login test ===');
  console.log('Controller:', baseUrl);
  console.log('Username:', username);
  console.log('Password loaded:', 'YES');
  console.log('Password length:', password.length);

  const response = await requestJson({
    url,
    body: {
      name: username,
      password
    }
  });

  const cookies = response.headers['set-cookie'] || [];
  const hasSessionCookie = cookies.some((value) =>
    /TPOMADA_SESSIONID=/i.test(String(value))
  );

  if (Number(response.data?.errorCode) !== 0) {
    console.log('Login: FAILED');
    console.log('HTTP:', response.statusCode);
    console.log('Omada errorCode:', response.data?.errorCode);
    console.log('Message:', response.data?.msg || 'Unknown error');
    process.exitCode = 1;
    return;
  }

  console.log('Login: OK');
  console.log('CSRF token received:', Boolean(response.data?.result?.token));
  console.log('TPOMADA_SESSIONID received:', hasSessionCookie);
};

run().catch((error) => {
  console.error('Hotspot Operator login test failed:', error.message);
  process.exitCode = 1;
});
