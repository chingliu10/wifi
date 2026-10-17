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
          v.created_at
        FROM vouchers v
        JOIN voucher_batches vb ON vb.id = v.batch_id
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
      code: includeCodes ? decryptSecret(voucher.code_enc) : null
    }))
  };
};

module.exports = {
  MAX_BATCH_QUANTITY,
  normalizeVoucherCode,
  hashVoucherCode,
  getVoucherAdminOptions,
  createVoucherBatch,
  listVoucherBatches,
  getVoucherBatch
};
