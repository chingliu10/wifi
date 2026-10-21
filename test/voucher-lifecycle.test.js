const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env')
});

process.env.PLATFORM_ENCRYPTION_KEY =
  process.env.PLATFORM_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const testDatabaseUrl = String(
  process.env.TEST_DATABASE_URL || ''
).trim();

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
}

const pool = require('../src/config/database');
const {
  createVoucherBatch,
  getVoucherBatch,
  redeemVoucher,
  cancelVoucher,
  cancelVoucherBatch,
  normalizeVoucherCode,
  hashVoucherCode
} = require('../src/services/vouchers/voucher-service');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const setup = async () => {
  const suffix = unique();

  const org = (
    await pool.query(
      `
        INSERT INTO organizations (
          name,
          slug,
          active,
          vouchers_enabled,
          voucher_portal_enabled
        )
        VALUES ($1, $2, TRUE, TRUE, TRUE)
        RETURNING *
      `,
      ['Voucher Test ' + suffix, 'voucher-test-' + suffix]
    )
  ).rows[0];

  const site = (
    await pool.query(
      `
        INSERT INTO sites (
          organization_id,
          name,
          slug,
          brand_name,
          active
        )
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING *
      `,
      [org.id, 'Test Site', 'test-site-' + suffix, 'Test WiFi']
    )
  ).rows[0];

  const otherSite = (
    await pool.query(
      `
        INSERT INTO sites (
          organization_id,
          name,
          slug,
          brand_name,
          active
        )
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING *
      `,
      [org.id, 'Other Site', 'other-site-' + suffix, 'Other WiFi']
    )
  ).rows[0];

  const pkg = (
    await pool.query(
      `
        INSERT INTO packages (
          site_id,
          name,
          price_tzs,
          duration_seconds,
          active,
          sort_order
        )
        VALUES ($1, '1 Hour', 1000, 3600, TRUE, 1)
        RETURNING *
      `,
      [site.id]
    )
  ).rows[0];

  const device = (
    await pool.query(
      `
        INSERT INTO devices (mac_address)
        VALUES ($1)
        RETURNING *
      `,
      ['02:00:00:' + suffix.slice(-2).padStart(2, '0') + ':10:01']
    )
  ).rows[0];

  const otherDevice = (
    await pool.query(
      `
        INSERT INTO devices (mac_address)
        VALUES ($1)
        RETURNING *
      `,
      ['02:00:00:' + suffix.slice(-2).padStart(2, '0') + ':10:02']
    )
  ).rows[0];

  return { org, site, otherSite, pkg, device, otherDevice };
};

test('voucher codes normalize and hash consistently', () => {
  const formatted = 'ABC-23CD-EFGH-JKLM';
  const compact = 'abc23cdefghjklm';

  assert.equal(normalizeVoucherCode(formatted), 'ABC23CDEFGHJKLM');
  assert.equal(hashVoucherCode(formatted), hashVoucherCode(compact));
});

test(
  'voucher lifecycle is single-use, idempotent for the same device, scoped and cancellable',
  {
    skip: testDatabaseUrl
      ? false
      : 'TEST_DATABASE_URL is not configured; production DATABASE_URL is never used for voucher integration tests'
  },
  async () => {
  const { org, site, otherSite, pkg, device, otherDevice } = await setup();

  const generated = await createVoucherBatch({
    organizationId: org.id,
    siteId: site.id,
    packageId: pkg.id,
    quantity: 4,
    redeemableUntil: null,
    createdByUserId: null
  });

  assert.equal(generated.codes.length, 4);
  assert.equal(new Set(generated.codes).size, 4);

  const batchView = await getVoucherBatch({
    organizationId: org.id,
    batchId: generated.batch.id,
    includeCodes: true
  });

  assert.equal(batchView.vouchers.length, 4);
  assert.deepEqual(
    batchView.vouchers.map((voucher) => voucher.code),
    generated.codes
  );

  await assert.rejects(
    redeemVoucher({
      organizationId: org.id,
      siteId: otherSite.id,
      deviceId: device.id,
      clientMac: device.mac_address,
      code: generated.codes[0]
    }),
    (error) => error.code === 'VOUCHER_INVALID'
  );

  const first = await redeemVoucher({
    organizationId: org.id,
    siteId: site.id,
    deviceId: device.id,
    clientMac: device.mac_address,
    code: generated.codes[0]
  });

  assert.equal(first.reused, false);
  assert.equal(first.subscription.access_source, 'voucher');
  assert.equal(Number(first.subscription.package_id), Number(pkg.id));
  assert.equal(
    Number(first.subscription.device_id),
    Number(device.id)
  );

  const lifetimeSeconds =
    (
      new Date(first.subscription.expires_at).getTime() -
      new Date(first.subscription.starts_at).getTime()
    ) / 1000;

  assert.equal(lifetimeSeconds, 3600);

  const retry = await redeemVoucher({
    organizationId: org.id,
    siteId: site.id,
    deviceId: device.id,
    clientMac: device.mac_address,
    code: generated.codes[0]
  });

  assert.equal(retry.reused, true);
  assert.equal(
    Number(retry.subscription.id),
    Number(first.subscription.id)
  );

  await assert.rejects(
    redeemVoucher({
      organizationId: org.id,
      siteId: site.id,
      deviceId: otherDevice.id,
      clientMac: otherDevice.mac_address,
      code: generated.codes[0]
    }),
    (error) => error.code === 'VOUCHER_ALREADY_USED'
  );

  const secondVoucher = batchView.vouchers.find(
    (voucher) => voucher.code === generated.codes[1]
  );

  await cancelVoucher({
    organizationId: org.id,
    voucherId: secondVoucher.id
  });

  await assert.rejects(
    redeemVoucher({
      organizationId: org.id,
      siteId: site.id,
      deviceId: otherDevice.id,
      clientMac: otherDevice.mac_address,
      code: generated.codes[1]
    }),
    (error) => error.code === 'VOUCHER_CANCELLED'
  );

  await pool.query(
    `
      UPDATE voucher_batches
      SET redeemable_until = NOW() - INTERVAL '1 minute'
      WHERE id = $1
    `,
    [generated.batch.id]
  );

  await assert.rejects(
    redeemVoucher({
      organizationId: org.id,
      siteId: site.id,
      deviceId: otherDevice.id,
      clientMac: otherDevice.mac_address,
      code: generated.codes[2]
    }),
    (error) => error.code === 'VOUCHER_EXPIRED'
  );

  const redeemedRetryAfterDeadline = await redeemVoucher({
    organizationId: org.id,
    siteId: site.id,
    deviceId: device.id,
    clientMac: device.mac_address,
    code: generated.codes[0]
  });

  assert.equal(redeemedRetryAfterDeadline.reused, true);

  await pool.query(
    `
      UPDATE voucher_batches
      SET redeemable_until = NULL
      WHERE id = $1
    `,
    [generated.batch.id]
  );

  await cancelVoucherBatch({
    organizationId: org.id,
    batchId: generated.batch.id
  });

  const redeemedRetryAfterBatchCancel = await redeemVoucher({
    organizationId: org.id,
    siteId: site.id,
    deviceId: device.id,
    clientMac: device.mac_address,
    code: generated.codes[0]
  });

  assert.equal(redeemedRetryAfterBatchCancel.reused, true);

  const finalView = await getVoucherBatch({
    organizationId: org.id,
    batchId: generated.batch.id,
    includeCodes: false
  });

  const byCodeLast4 = new Map(
    finalView.vouchers.map((voucher) => [
      voucher.code_last4,
      voucher
    ])
  );

  assert.equal(
    byCodeLast4.get(normalizeVoucherCode(generated.codes[0]).slice(-4)).status,
    'redeemed'
  );
  assert.equal(
    byCodeLast4.get(normalizeVoucherCode(generated.codes[3]).slice(-4)).status,
    'cancelled'
  );
  }
);

test.after(async () => {
  await pool.end();
});
