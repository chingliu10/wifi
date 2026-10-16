require('dotenv').config();

const pool = require('../config/database');
const { normalizeMacAddress } = require('../utils/mac-address');
const omada = require('../services/omada/open-api-client');

const run = async () => {
  const inputMac = String(process.argv[2] || '').trim();
  const mac = normalizeMacAddress(inputMac);

  if (!mac) {
    throw new Error(
      'Usage: npm run omada:unauth-client -- "AA:BB:CC:DD:EE:FF"'
    );
  }

  if (!omada.configured()) {
    throw new Error('Omada Open API is not enabled');
  }

  const result = await pool.query(
    `
      SELECT
        pt.client_mac,
        s.id AS site_id,
        s.name AS site_name,
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

  const row = result.rows[0];

  if (!row) {
    throw new Error(
      'No Omada-linked Solidus site was found for this client MAC'
    );
  }

  console.log('Client MAC:', mac);
  console.log('Solidus site:', row.site_name);
  console.log('Omada site ID:', row.external_portal_site_id);
  console.log('Cancelling Omada hotspot authentication...');

  await omada.cancelAuthClient({
    siteId: row.external_portal_site_id,
    clientMac: mac
  });

  console.log('Omada unauth request completed.');
  console.log(
    'If the subscription is expired, the next MAC authentication should be rejected by FreeRADIUS and the portal should return.'
  );
};

run()
  .catch((error) => {
    console.error('Omada unauth failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
