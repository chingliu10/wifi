require('dotenv').config();

const pool = require('../config/database');
const { normalizeMacAddress } = require('../utils/mac-address');

const formatDuration = (seconds) => {
  const value = Number(seconds);

  if (!Number.isFinite(value)) return 'unknown';

  if (value % 86400 === 0) return `${value / 86400} day(s)`;
  if (value % 3600 === 0) return `${value / 3600} hour(s)`;
  if (value % 60 === 0) return `${value / 60} minute(s)`;

  return `${value} second(s)`;
};

const formatLocal = (value) => {
  if (!value) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
};

const run = async () => {
  const inputMac = String(process.argv[2] || '').trim();
  const mac = normalizeMacAddress(inputMac);

  if (!mac) {
    throw new Error(
      'Usage: npm run radius:check -- "AA:BB:CC:DD:EE:FF"'
    );
  }

  const nowResult = await pool.query('SELECT NOW() AS now');
  const now = nowResult.rows[0].now;

  const subscriptions = (
    await pool.query(
      `
        SELECT
          sub.id,
          sub.status,
          sub.starts_at,
          sub.expires_at,
          EXTRACT(EPOCH FROM (sub.expires_at - sub.starts_at))::INTEGER
            AS actual_duration_seconds,
          p.name AS package_name,
          p.duration_seconds AS package_duration_seconds,
          s.name AS site_name,
          pt.reference,
          pt.status AS payment_status
        FROM subscriptions sub
        JOIN packages p ON p.id = sub.package_id
        JOIN sites s ON s.id = sub.site_id
        LEFT JOIN payment_transactions pt
          ON pt.id = sub.payment_transaction_id
        WHERE sub.client_mac = $1
        ORDER BY sub.created_at DESC
        LIMIT 5
      `,
      [mac]
    )
  ).rows;

  const radcheck = (
    await pool.query(
      `
        SELECT attribute, op, value
        FROM radcheck
        WHERE username = $1
        ORDER BY attribute
      `,
      [mac]
    )
  ).rows;

  const radreply = (
    await pool.query(
      `
        SELECT attribute, op, value
        FROM radreply
        WHERE username = $1
        ORDER BY attribute
      `,
      [mac]
    )
  ).rows;

  const authorization = (
    await pool.query(
      `
        SELECT
          subscription_id,
          starts_at,
          expires_at,
          status
        FROM radius_authorizations
        WHERE client_mac = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [mac]
    )
  ).rows[0] || null;

  console.log('');
  console.log('=== Solidus client access diagnostic ===');
  console.log('MAC:', mac);
  console.log('Server time (TZ):', formatLocal(now), 'Africa/Dar_es_Salaam');
  console.log('');

  if (!subscriptions.length) {
    console.log('No subscriptions found for this MAC.');
  } else {
    subscriptions.forEach((sub, index) => {
      const expiresAt = new Date(sub.expires_at);
      const remainingSeconds = Math.floor(
        (expiresAt.getTime() - new Date(now).getTime()) / 1000
      );

      console.log(`Subscription #${index + 1}`);
      console.log('  Site:', sub.site_name);
      console.log('  Package:', sub.package_name);
      console.log(
        '  Package duration:',
        sub.package_duration_seconds,
        'seconds =',
        formatDuration(sub.package_duration_seconds)
      );
      console.log(
        '  Actual subscription duration:',
        sub.actual_duration_seconds,
        'seconds =',
        formatDuration(sub.actual_duration_seconds)
      );
      console.log('  Starts:', formatLocal(sub.starts_at));
      console.log('  Expires:', formatLocal(sub.expires_at));
      console.log(
        '  Remaining:',
        remainingSeconds > 0
          ? `${remainingSeconds} seconds (${Math.ceil(remainingSeconds / 60)} min)`
          : `EXPIRED ${Math.abs(remainingSeconds)} seconds ago`
      );
      console.log('  Subscription status:', sub.status);
      console.log('  Payment:', sub.reference || '—', sub.payment_status || '');
      console.log('');
    });
  }

  console.log('RADIUS radcheck');
  if (!radcheck.length) {
    console.log('  NONE');
  } else {
    radcheck.forEach((row) => {
      console.log(`  ${row.attribute} ${row.op} ${row.value}`);
    });
  }

  console.log('');
  console.log('RADIUS radreply');
  if (!radreply.length) {
    console.log('  NONE');
  } else {
    radreply.forEach((row) => {
      console.log(`  ${row.attribute} ${row.op} ${row.value}`);
    });
  }

  console.log('');
  console.log('RADIUS authorization');
  if (!authorization) {
    console.log('  NONE');
  } else {
    console.log('  Subscription ID:', authorization.subscription_id);
    console.log('  Starts:', formatLocal(authorization.starts_at));
    console.log('  Expires:', formatLocal(authorization.expires_at));
    console.log('  Status:', authorization.status);
  }

  const latest = subscriptions[0];
  const sessionTimeout = radreply.find(
    (row) => row.attribute === 'Session-Timeout'
  );

  console.log('');
  console.log('=== Verdict ===');

  if (!latest) {
    console.log('NO SUBSCRIPTION');
    return;
  }

  if (Number(latest.package_duration_seconds) === 600) {
    console.log('Package is configured as EXACTLY 10 MINUTES (600 seconds).');
  } else {
    console.log(
      'Package is NOT 10 minutes. Stored duration is',
      formatDuration(latest.package_duration_seconds) + '.'
    );
  }

  if (new Date(latest.expires_at).getTime() <= new Date(now).getTime()) {
    console.log('Latest subscription is EXPIRED.');
  } else {
    console.log('Latest subscription is still ACTIVE by time.');
  }

  if (sessionTimeout) {
    console.log(
      'RADIUS Session-Timeout is present:',
      sessionTimeout.value,
      'seconds.'
    );
  } else {
    console.log(
      'WARNING: RADIUS Session-Timeout is NOT present for this MAC.'
    );
    console.log(
      'A subscription created before the Session-Timeout fix may need a NEW payment/test to receive it.'
    );
  }
};

run()
  .catch((error) => {
    console.error('Access diagnostic failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
