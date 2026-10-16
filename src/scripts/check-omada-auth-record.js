require('dotenv').config();

const pool = require('../config/database');
const { normalizeMacAddress } = require('../utils/mac-address');
const omada = require('../services/omada/open-api-client');

const formatLocal = (value) => {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);

  const ms = number < 100000000000 ? number * 1000 : number;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(ms));
};

const authTypeLabel = (value) => {
  const labels = {
    0: 'No Auth',
    1: 'Simple Password',
    2: 'External RADIUS',
    3: 'Voucher',
    4: 'External Portal Server',
    5: 'Local User',
    6: 'SMS',
    7: 'Facebook',
    8: 'Hotspot RADIUS',
    9: 'MAC Auth (with fail over)',
    10: 'Admin auth',
    12: 'Form auth'
  };

  return labels[Number(value)] || `Unknown (${value})`;
};

const run = async () => {
  const inputMac = String(process.argv[2] || '').trim();
  const mac = normalizeMacAddress(inputMac);

  if (!mac) {
    throw new Error(
      'Usage: npm run omada:auth-record-check -- "AA:BB:CC:DD:EE:FF"'
    );
  }

  const siteResult = await pool.query(
    `
      SELECT
        s.name,
        s.external_portal_site_id
      FROM payment_transactions pt
      JOIN sites s ON s.id = pt.site_id
      WHERE pt.client_mac = $1
        AND s.external_portal_site_id IS NOT NULL
      ORDER BY pt.created_at DESC
      LIMIT 1
    `,
    [mac]
  );

  const site = siteResult.rows[0];

  if (!site) {
    throw new Error('No Omada-linked site found for this MAC');
  }

  const records = await omada.listHotspotAuthedClients({
    siteId: site.external_portal_site_id,
    page: 1,
    pageSize: 100,
    searchKey: mac.replace(/:/g, '-')
  });

  const normalized = mac.replace(/:/g, '-').toUpperCase();
  const matches = records.filter((record) => {
    const candidate = String(record.mac || '')
      .replace(/:/g, '-')
      .toUpperCase();
    return candidate === normalized;
  });

  console.log('');
  console.log('=== Omada authenticated-record check ===');
  console.log('Site:', site.name);
  console.log('MAC:', mac);
  console.log('Records found:', matches.length);
  console.log('');

  if (!matches.length) {
    console.log('No Omada authenticated record exists for this MAC.');
    return;
  }

  for (const [index, record] of matches.entries()) {
    console.log(`Record #${index + 1}`);
    console.log('  ID:', record.id || '—');
    console.log('  Auth type:', authTypeLabel(record.authType));
    console.log('  SSID:', record.ssid || '—');
    console.log('  Valid:', record.valid);
    console.log('  Start:', formatLocal(record.start));
    console.log('  End:', formatLocal(record.end));
    console.log('  Duration:', record.duration, 'seconds');
    console.log('  Radius username:', record.radiusUsername || '—');
    console.log('');
  }
};

run()
  .catch((error) => {
    console.error('Omada auth-record check failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
