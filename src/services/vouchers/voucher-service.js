const crypto = require('crypto');
const pool = require('../../config/database');
const { encryptSecret, decryptSecret } = require('../secret-crypto');

const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BATCH_QUANTITY = 500;

const randomToken = (length) => {
  let value = '';

  for (let i = 0; i < length; i += 1) {
    value += VOUCHER_ALPHABET[crypto.randomInt(VOUCHER_ALPHABET.length)];
  }

  return value;
};

const normalizeVoucherCode = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const hashVoucherCode = (value) =>
  crypto
    .createHash('sha256')
    .update(normalizeVoucherCode(value))
    .digest('hex');

const makeSitePrefix = (site) => {
  const raw = String(site?.slug || site?.name || 'WIFI')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  return (raw.slice(0, 3) || 'WIFI').padEnd(3, 'X');
};

const generateVoucherCode = (site) => {
  const token = randomToken(12);

  return [
    makeSitePrefix(site),
    token.slice(0, 4),
    token.slice(4, 8),
    token.slice(8, 12)
  ].join('-');
};

const generateBatchReference = () =>
  [
    'VB',
    Date.now().toString(36).toUpperCase(),
    randomToken(6)
  ].join('-');

const parseRedeemableUntil = (value) => {
  const raw = String(value || '').trim();

  if (!raw) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('Voucher expiry date is invalid');
  }

  const date = new Date(raw + 'T23:59:59+03:00');

  if (Number.isNaN(date.getTime())) {
    throw new Error('Voucher expiry date is invalid');
  }

  if (date.getTime() <= Date.now()) {
    throw new Error('Voucher expiry date must be in the future');
  }

  return date;
};

const getVoucherAdminOptions = async (organizationId) => {
  const sites = (
    await pool.query(
      `
        SELECT id, name, slug
        FROM sites
        WHERE organization_id = $1
          AND active = TRUE
        ORDER BY name
      `,
      [organizationId]
    )
  ).rows;

  const packages = (
    await pool.query(
      `
        SELECT
          p.id,
          p.site_id,
          p.name,
          p.price_tzs,
          p.duration_seconds,
          s.name AS site_name
        FROM packages p
        JOIN sites s ON s.id = p.site_id
        WHERE s.organization_id = $1
          AND s.active = TRUE
          AND p.active = TRUE
          AND p.deleted_at IS NULL
        ORDER BY s.name, p.sort_order, p.id
      `,
      [organizationId]
    )
  ).rows;

  return {
    sites,
    packages
  };
};

const createVoucherBatch = async ({
  organizationId,
  siteId,
  packageId,
  quantity,
  redeemableUntil,
  createdByUserId
}) => {
  const safeQuantity = Number.parseInt(String(quantity || ''), 10);

  if (
    !Number.isInteger(safeQuantity) ||
    safeQuantity < 1 ||
    safeQuantity > MAX_BATCH_QUANTITY
  ) {
    throw new Error(
      `Voucher quantity must be between 1 and ${MAX_BATCH_QUANTITY}`
    );
  }

  const expiresAt = parseRedeemableUntil(redeemableUntil);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const packageResult = await client.query(
      `
        SELECT
          p.id,
          p.site_id,
          p.name,
          p.price_tzs,
          p.duration_seconds,
          s.name AS site_name,
          s.slug AS site_slug,
          s.organization_id
        FROM packages p
        JOIN sites s ON s.id = p.site_id
        JOIN organizations o ON o.id = s.organization_id
        WHERE p.id = $1
          AND s.id = $2
          AND s.organization_id = $3
          AND p.active = TRUE
          AND p.deleted_at IS NULL
          AND s.active = TRUE
          AND o.active = TRUE
          AND o.vouchers_enabled = TRUE
        LIMIT 1
        FOR SHARE OF p, s
      `,
      [packageId, siteId, organizationId]
    );

    const packageData = packageResult.rows[0];

    if (!packageData) {
      throw new Error(
        'The selected package is not available for voucher generation'
      );
    }

    const batchReference = generateBatchReference();

    const batchResult = await client.query(
      `
        INSERT INTO voucher_batches (
          organization_id,
          site_id,
          package_id,
          created_by_user_id,
          batch_reference,
          quantity,
          package_name_snapshot,
          package_price_tzs_snapshot,
          package_duration_seconds_snapshot,
          redeemable_until
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
      [
        organizationId,
        siteId,
        packageId,
        createdByUserId,
        batchReference,
        safeQuantity,
        packageData.name,
        packageData.price_tzs,
        packageData.duration_seconds,
        expiresAt
      ]
    );

    const batch = batchResult.rows[0];
    const generated = [];
    const hashes = [];
    const encrypted = [];
    const last4 = [];
    const seen = new Set();

    while (generated.length < safeQuantity) {
      const code = generateVoucherCode({
        name: packageData.site_name,
        slug: packageData.site_slug
      });
      const hash = hashVoucherCode(code);

      if (seen.has(hash)) {
        continue;
      }

      seen.add(hash);
      generated.push(code);
      hashes.push(hash);
      encrypted.push(encryptSecret(code));
      last4.push(normalizeVoucherCode(code).slice(-4));
    }

    await client.query(
      `
        INSERT INTO vouchers (
          organization_id,
          site_id,
          batch_id,
          code_hash,
          code_enc,
          code_last4
        )
        SELECT
          $1,
          $2,
          $3,
          generated.code_hash,
          generated.code_enc,
          generated.code_last4
        FROM UNNEST(
          $4::text[],
          $5::text[],
          $6::text[]
        ) AS generated(code_hash, code_enc, code_last4)
      `,
      [
        organizationId,
        siteId,
        batch.id,
        hashes,
        encrypted,
        last4
      ]
    );

    await client.query('COMMIT');

    return {
      batch,
      codes: generated
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const listVoucherBatches = async ({
  organizationId,
  page = 1,
  pageSize = 25
}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (safePage - 1) * safePageSize;

  const countResult = await pool.query(
    `
      SELECT COUNT(*)::INTEGER AS total
      FROM voucher_batches
      WHERE organization_id = $1
    `,
    [organizationId]
  );

  const batches = (
    await pool.query(
      `
        SELECT
          vb.id,
          vb.batch_reference,
          vb.quantity,
          vb.package_name_snapshot,
          vb.package_price_tzs_snapshot,
          vb.package_duration_seconds_snapshot,
          vb.redeemable_until,
          vb.active,
          vb.created_at,
          s.name AS site_name,
          COUNT(v.id)::INTEGER AS generated_count,
          COUNT(*) FILTER (
            WHERE v.status = 'unused'
              AND (
                vb.redeemable_until IS NULL
                OR vb.redeemable_until >= NOW()
              )
          )::INTEGER AS unused_count,
          COUNT(*) FILTER (
            WHERE v.status = 'redeemed'
          )::INTEGER AS redeemed_count,
          COUNT(*) FILTER (
            WHERE v.status = 'cancelled'
          )::INTEGER AS cancelled_count,
          COUNT(*) FILTER (
            WHERE v.status = 'expired'
               OR (
                 v.status = 'unused'
                 AND vb.redeemable_until IS NOT NULL
                 AND vb.redeemable_until < NOW()
               )
          )::INTEGER AS expired_count
        FROM voucher_batches vb
        JOIN sites s ON s.id = vb.site_id
        LEFT JOIN vouchers v ON v.batch_id = vb.id
        WHERE vb.organization_id = $1
        GROUP BY vb.id, s.name
        ORDER BY vb.created_at DESC, vb.id DESC
        LIMIT $2 OFFSET $3
      `,
      [organizationId, safePageSize, offset]
    )
  ).rows;

  return {
    batches,
    total: countResult.rows[0]?.total || 0
  };
};

const getVoucherBatch = async ({
  organizationId,
  batchId,
  includeCodes = false
}) => {
  const batchResult = await pool.query(
    `
      SELECT
        vb.*,
        s.name AS site_name
      FROM voucher_batches vb
      JOIN sites s ON s.id = vb.site_id
      WHERE vb.id = $1
        AND vb.organization_id = $2
      LIMIT 1
    `,
    [batchId, organizationId]
  );

  const batch = batchResult.rows[0];

  if (!batch) {
    return null;
  }

  const vouchers = (
    await pool.query(
      `
        SELECT
          v.id,
          ROW_NUMBER() OVER (ORDER BY v.id)::INTEGER AS row_number,
          v.code_enc,
          v.code_last4,
          CASE
            WHEN v.status = 'unused'
              AND vb.redeemable_until IS NOT NULL
              AND vb.redeemable_until < NOW()
            THEN 'expired'
            ELSE v.status
          END AS status,
          v.redeemed_at,
          v.redeemed_device_id,
          d.mac_address AS redeemed_mac,
          v.created_at
        FROM vouchers v
        JOIN voucher_batches vb ON vb.id = v.batch_id
        LEFT JOIN devices d ON d.id = v.redeemed_device_id
        WHERE v.batch_id = $1
          AND v.organization_id = $2
        ORDER BY v.id
      `,
      [batchId, organizationId]
    )
  ).rows;

  return {
    batch,
    vouchers: vouchers.map((voucher) => ({
      ...voucher,
      code: includeCodes ? decryptSecret(voucher.code_enc) : null,
      cancellable:
        Boolean(batch.active) &&
        voucher.status === 'unused' &&
        (
          !batch.redeemable_until ||
          new Date(batch.redeemable_until).getTime() > Date.now()
        )
    }))
  };
};


const voucherError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const redeemVoucher = async ({
  organizationId,
  siteId,
  deviceId,
  clientMac,
  code
}) => {
  const normalizedCode = normalizeVoucherCode(code);

  if (normalizedCode.length < 8 || normalizedCode.length > 40) {
    throw voucherError(
      'VOUCHER_INVALID',
      'Voucher code is invalid'
    );
  }

  const codeHash = hashVoucherCode(normalizedCode);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const voucherResult = await client.query(
      `
        SELECT
          v.id,
          v.organization_id,
          v.site_id,
          v.batch_id,
          v.status,
          v.redeemed_device_id,
          v.subscription_id,
          v.redeemed_at,
          vb.package_id,
          vb.package_name_snapshot,
          vb.package_duration_seconds_snapshot,
          vb.redeemable_until,
          vb.active AS batch_active,
          vb.batch_reference
        FROM vouchers v
        JOIN voucher_batches vb ON vb.id = v.batch_id
        WHERE v.code_hash = $1
          AND v.organization_id = $2
          AND v.site_id = $3
        LIMIT 1
        FOR UPDATE OF v, vb
      `,
      [codeHash, organizationId, siteId]
    );

    const voucher = voucherResult.rows[0];

    if (!voucher) {
      throw voucherError(
        'VOUCHER_INVALID',
        'Voucher code is invalid'
      );
    }

    if (!voucher.batch_active) {
      throw voucherError(
        'VOUCHER_CANCELLED',
        'This voucher batch has been cancelled'
      );
    }

    if (
      voucher.redeemable_until &&
      new Date(voucher.redeemable_until).getTime() <= Date.now()
    ) {
      throw voucherError(
        'VOUCHER_EXPIRED',
        'This voucher has expired'
      );
    }

    if (voucher.status === 'cancelled') {
      throw voucherError(
        'VOUCHER_CANCELLED',
        'This voucher has been cancelled'
      );
    }

    if (voucher.status === 'expired') {
      throw voucherError(
        'VOUCHER_EXPIRED',
        'This voucher has expired'
      );
    }

    if (voucher.status === 'redeemed') {
      if (Number(voucher.redeemed_device_id) !== Number(deviceId)) {
        throw voucherError(
          'VOUCHER_ALREADY_USED',
          'This voucher has already been used'
        );
      }

      const existingSubscription = await client.query(
        `
          SELECT *
          FROM subscriptions
          WHERE id = $1
            AND device_id = $2
            AND site_id = $3
          LIMIT 1
        `,
        [voucher.subscription_id, deviceId, siteId]
      );

      const subscription = existingSubscription.rows[0];

      if (
        !subscription ||
        subscription.status !== 'active' ||
        new Date(subscription.expires_at).getTime() <= Date.now()
      ) {
        throw voucherError(
          'VOUCHER_ALREADY_USED',
          'This voucher has already been used'
        );
      }

      await client.query('COMMIT');

      return {
        voucher,
        subscription,
        packageName: voucher.package_name_snapshot,
        reused: true
      };
    }

    if (voucher.status !== 'unused') {
      throw voucherError(
        'VOUCHER_UNAVAILABLE',
        'This voucher is not available'
      );
    }

    const subscriptionResult = await client.query(
      `
        WITH current_access AS (
          SELECT MAX(expires_at) AS expires_at
          FROM subscriptions
          WHERE device_id = $1
            AND site_id = $2
            AND status = 'active'
            AND expires_at > NOW()
        )
        INSERT INTO subscriptions (
          site_id,
          device_id,
          package_id,
          payment_id,
          payment_transaction_id,
          client_mac,
          starts_at,
          expires_at,
          status,
          access_source,
          granted_by_user_id,
          grant_note
        )
        VALUES (
          $2,
          $1,
          $3,
          NULL,
          NULL,
          $4,
          COALESCE((SELECT expires_at FROM current_access), NOW()),
          COALESCE((SELECT expires_at FROM current_access), NOW())
            + ($5 * INTERVAL '1 second'),
          'active',
          'voucher',
          NULL,
          $6
        )
        RETURNING *
      `,
      [
        deviceId,
        siteId,
        voucher.package_id,
        clientMac,
        voucher.package_duration_seconds_snapshot,
        'Voucher ' + voucher.batch_reference
      ]
    );

    const subscription = subscriptionResult.rows[0];

    await client.query(
      `
        UPDATE vouchers
        SET
          status = 'redeemed',
          redeemed_device_id = $2,
          subscription_id = $3,
          redeemed_at = NOW()
        WHERE id = $1
      `,
      [voucher.id, deviceId, subscription.id]
    );

    await client.query('COMMIT');

    return {
      voucher: {
        ...voucher,
        status: 'redeemed',
        redeemed_device_id: deviceId,
        subscription_id: subscription.id
      },
      subscription,
      packageName: voucher.package_name_snapshot,
      reused: false
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('VOUCHER REDEMPTION ROLLBACK ERROR:', rollbackError);
    }

    throw error;
  } finally {
    client.release();
  }
};

const cancelVoucherBatch = async ({
  organizationId,
  batchId
}) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      `
        SELECT id, active
        FROM voucher_batches
        WHERE id = $1
          AND organization_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [batchId, organizationId]
    );

    const batch = batchResult.rows[0];

    if (!batch) {
      throw voucherError(
        'VOUCHER_BATCH_NOT_FOUND',
        'Voucher batch was not found',
        404
      );
    }

    if (batch.active) {
      await client.query(
        `
          UPDATE voucher_batches
          SET active = FALSE
          WHERE id = $1
        `,
        [batchId]
      );

      await client.query(
        `
          UPDATE vouchers
          SET
            status = 'cancelled',
            cancelled_at = NOW()
          WHERE batch_id = $1
            AND organization_id = $2
            AND status = 'unused'
        `,
        [batchId, organizationId]
      );
    }

    await client.query('COMMIT');

    return { cancelled: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const cancelVoucher = async ({
  organizationId,
  voucherId
}) => {
  const result = await pool.query(
    `
      UPDATE vouchers
      SET
        status = 'cancelled',
        cancelled_at = NOW()
      WHERE id = $1
        AND organization_id = $2
        AND status = 'unused'
      RETURNING id
    `,
    [voucherId, organizationId]
  );

  if (!result.rows[0]) {
    throw voucherError(
      'VOUCHER_NOT_CANCELLABLE',
      'Only unused vouchers can be cancelled'
    );
  }

  return { cancelled: true };
};

module.exports = {
  MAX_BATCH_QUANTITY,
  normalizeVoucherCode,
  hashVoucherCode,
  getVoucherAdminOptions,
  createVoucherBatch,
  listVoucherBatches,
  getVoucherBatch,
  redeemVoucher,
  cancelVoucherBatch,
  cancelVoucher
};
