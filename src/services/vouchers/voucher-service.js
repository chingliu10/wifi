const crypto = require('crypto');
const pool = require('../../config/database');
const { encryptSecret, decryptSecret } = require('../secret-crypto');

const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VOUCHER_DIGITS = '0123456789';
const VOUCHER_NUMERIC_LENGTH = 8;
const VOUCHER_MAX_FAILED_ATTEMPTS = 5;
const VOUCHER_FAILURE_WINDOW_MINUTES = 10;
const VOUCHER_BLOCK_MINUTES = 10;
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

const getVoucherHashKey = () => {
  const key = String(
    process.env.VOUCHER_HASH_KEY ||
    process.env.PLATFORM_ENCRYPTION_KEY ||
    ''
  ).trim();

  if (!key) {
    throw new Error(
      'VOUCHER_HASH_KEY or PLATFORM_ENCRYPTION_KEY is required for vouchers'
    );
  }

  return key;
};

const hashVoucherCode = (value) =>
  crypto
    .createHmac('sha256', getVoucherHashKey())
    .update(normalizeVoucherCode(value))
    .digest('hex');

const legacyHashVoucherCode = (value) =>
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

const generateVoucherCode = () => {
  let digits = '';

  for (let i = 0; i < VOUCHER_NUMERIC_LENGTH; i += 1) {
    digits += VOUCHER_DIGITS[crypto.randomInt(VOUCHER_DIGITS.length)];
  }

  return digits.slice(0, 4) + ' ' + digits.slice(4);
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
    const seen = new Set();

    while (generated.length < safeQuantity) {
      const code = generateVoucherCode();
      const hash = hashVoucherCode(code);

      if (seen.has(hash)) {
        continue;
      }

      const insertResult = await client.query(
        `
          INSERT INTO vouchers (
            organization_id,
            site_id,
            batch_id,
            code_hash,
            code_enc,
            code_last4
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (code_hash) DO NOTHING
          RETURNING id
        `,
        [
          organizationId,
          siteId,
          batch.id,
          hash,
          encryptSecret(code),
          normalizeVoucherCode(code).slice(-4)
        ]
      );

      if (!insertResult.rows[0]) {
        continue;
      }

      seen.add(hash);
      generated.push(code);
    }

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
        AND batch_type = 'admin'
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
          AND vb.batch_type = 'admin'
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

const getVoucherOverview = async ({
  organizationId,
  status = '',
  source = '',
  search = '',
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = 25
}) => {
  const safeStatus = ['unused', 'redeemed', 'expired', 'cancelled'].includes(
    String(status || '').toLowerCase()
  )
    ? String(status).toLowerCase()
    : '';

  const safeSource = ['admin', 'cashier'].includes(
    String(source || '').toLowerCase()
  )
    ? String(source).toLowerCase()
    : '';

  const safeSearch = String(search || '').trim().slice(0, 100);
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (safePage - 1) * safePageSize;

  const statsResult = await pool.query(
    `
      SELECT
        COUNT(v.id)::INTEGER AS total,
        COUNT(v.id) FILTER (
          WHERE v.status = 'unused'
            AND vb.active = TRUE
            AND (
              vb.redeemable_until IS NULL
              OR vb.redeemable_until >= NOW()
            )
        )::INTEGER AS unused,
        COUNT(v.id) FILTER (
          WHERE v.status = 'redeemed'
        )::INTEGER AS redeemed,
        COUNT(v.id) FILTER (
          WHERE v.status = 'cancelled'
        )::INTEGER AS cancelled,
        COUNT(v.id) FILTER (
          WHERE v.status = 'expired'
             OR (
               v.status = 'unused'
               AND vb.redeemable_until IS NOT NULL
               AND vb.redeemable_until < NOW()
             )
        )::INTEGER AS expired,
        COUNT(v.id) FILTER (
          WHERE v.redeemed_at::date = CURRENT_DATE
        )::INTEGER AS redeemed_today,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
        )::INTEGER AS cashier_sold,
        COALESCE(
          SUM(vs.sale_price_tzs) FILTER (
            WHERE vs.sale_status = 'issued'
          ),
          0
        )::BIGINT AS cashier_expected_cash
      FROM vouchers v
      JOIN voucher_batches vb ON vb.id = v.batch_id
      LEFT JOIN voucher_sales vs ON vs.voucher_id = v.id
      WHERE v.organization_id = $1
    `,
    [organizationId]
  );

  const rows = (
    await pool.query(
      `
        WITH voucher_activity AS (
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
            END AS effective_status,
            vb.batch_type AS source,
            vb.batch_reference,
            vb.package_name_snapshot,
            vb.package_price_tzs_snapshot,
            vb.package_duration_seconds_snapshot,
            v.created_at,
            v.redeemed_at,
            v.cancelled_at,
            s.name AS site_name,
            d.mac_address AS redeemed_mac,
            sub.status AS subscription_status,
            sub.starts_at AS access_starts_at,
            sub.expires_at AS access_expires_at,
            vs.id AS sale_id,
            vs.sale_status,
            vs.issued_at,
            vs.sale_price_tzs,
            cashier.full_name AS cashier_name,
            cashier.username AS cashier_username,
            known_customer.phone AS known_phone,
            known_customer.customer_name AS known_customer_name
          FROM vouchers v
          JOIN voucher_batches vb ON vb.id = v.batch_id
          JOIN sites s ON s.id = v.site_id
          LEFT JOIN devices d ON d.id = v.redeemed_device_id
          LEFT JOIN subscriptions sub ON sub.id = v.subscription_id
          LEFT JOIN voucher_sales vs ON vs.voucher_id = v.id
          LEFT JOIN platform_users cashier ON cashier.id = vs.cashier_user_id
          LEFT JOIN LATERAL (
            SELECT
              pt.phone,
              pt.customer_name
            FROM payment_transactions pt
            WHERE pt.organization_id = v.organization_id
              AND pt.device_id = v.redeemed_device_id
            ORDER BY
              COALESCE(pt.paid_at, pt.created_at) DESC,
              pt.id DESC
            LIMIT 1
          ) known_customer ON TRUE
          WHERE v.organization_id = $1
        )
        SELECT
          *,
          COUNT(*) OVER()::INTEGER AS filtered_total
        FROM voucher_activity
        WHERE ($2::text = '' OR effective_status = $2)
          AND ($3::text = '' OR source = $3)
          AND (
            $4::text = ''
            OR code_last4 ILIKE '%' || $4 || '%'
            OR batch_reference ILIKE '%' || $4 || '%'
            OR package_name_snapshot ILIKE '%' || $4 || '%'
            OR site_name ILIKE '%' || $4 || '%'
            OR COALESCE(redeemed_mac, '') ILIKE '%' || $4 || '%'
            OR COALESCE(known_phone, '') ILIKE '%' || $4 || '%'
            OR COALESCE(known_customer_name, '') ILIKE '%' || $4 || '%'
            OR COALESCE(cashier_name, '') ILIKE '%' || $4 || '%'
            OR COALESCE(cashier_username, '') ILIKE '%' || $4 || '%'
          )
          AND (
            $5::date IS NULL
            OR (
              COALESCE(issued_at, created_at)
                AT TIME ZONE 'Africa/Dar_es_Salaam'
            )::date >= $5::date
          )
          AND (
            $6::date IS NULL
            OR (
              COALESCE(issued_at, created_at)
                AT TIME ZONE 'Africa/Dar_es_Salaam'
            )::date <= $6::date
          )
        ORDER BY COALESCE(issued_at, created_at) DESC, id DESC
        LIMIT $7 OFFSET $8
      `,
      [
        organizationId,
        safeStatus,
        safeSource,
        safeSearch,
        startDate,
        endDate,
        safePageSize,
        offset
      ]
    )
  ).rows;

  const stats = statsResult.rows[0] || {
    total: 0,
    unused: 0,
    redeemed: 0,
    cancelled: 0,
    expired: 0,
    redeemed_today: 0,
    cashier_sold: 0,
    cashier_expected_cash: 0
  };

  const usableTotal =
    Number(stats.redeemed || 0) +
    Number(stats.unused || 0);

  return {
    stats: {
      ...stats,
      redemption_rate:
        usableTotal > 0
          ? Math.round((Number(stats.redeemed || 0) / usableTotal) * 100)
          : 0
    },
    vouchers: rows.map((voucher) => ({
      ...voucher,
      code: decryptSecret(voucher.code_enc)
    })),
    total: rows[0]?.filtered_total || 0,
    filters: {
      status: safeStatus,
      source: safeSource,
      search: safeSearch,
      startDate,
      endDate
    }
  };
};

const getCashierVoucherSalesSummary = async ({
  organizationId,
  startDate = null,
  endDate = null
}) => {
  const totalsResult = await pool.query(
    `
      SELECT
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND vs.issued_at::date = CURRENT_DATE
        )::INTEGER AS sold_today,
        COALESCE(
          SUM(vs.sale_price_tzs) FILTER (
            WHERE vs.sale_status = 'issued'
              AND vs.issued_at::date = CURRENT_DATE
          ),
          0
        )::BIGINT AS expected_cash_today,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND vs.issued_at::date = CURRENT_DATE
            AND v.status = 'redeemed'
        )::INTEGER AS redeemed_today,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND vs.issued_at::date = CURRENT_DATE
            AND v.status = 'unused'
        )::INTEGER AS waiting_today,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'voided'
            AND vs.voided_at::date = CURRENT_DATE
        )::INTEGER AS voided_today,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND (
              $2::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
            )
            AND (
              $3::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
            )
        )::INTEGER AS sold_period,
        COALESCE(
          SUM(vs.sale_price_tzs) FILTER (
            WHERE vs.sale_status = 'issued'
              AND (
                $2::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
              )
              AND (
                $3::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
              )
          ),
          0
        )::BIGINT AS collected_period,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND v.status = 'redeemed'
            AND (
              $2::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
            )
            AND (
              $3::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
            )
        )::INTEGER AS redeemed_period,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'issued'
            AND v.status = 'unused'
            AND (
              $2::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
            )
            AND (
              $3::date IS NULL
              OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
            )
        )::INTEGER AS waiting_period,
        COUNT(vs.id) FILTER (
          WHERE vs.sale_status = 'voided'
            AND (
              $2::date IS NULL
              OR (vs.voided_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
            )
            AND (
              $3::date IS NULL
              OR (vs.voided_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
            )
        )::INTEGER AS voided_period
      FROM voucher_sales vs
      JOIN vouchers v ON v.id = vs.voucher_id
      WHERE vs.organization_id = $1
    `,
    [organizationId, startDate, endDate]
  );

  const cashiers = (
    await pool.query(
      `
        SELECT
          u.id,
          u.full_name,
          u.username,
          s.name AS site_name,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND vs.issued_at::date = CURRENT_DATE
          )::INTEGER AS sold_today,
          COALESCE(
            SUM(vs.sale_price_tzs) FILTER (
              WHERE vs.sale_status = 'issued'
                AND vs.issued_at::date = CURRENT_DATE
            ),
            0
          )::BIGINT AS expected_cash_today,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND vs.issued_at::date = CURRENT_DATE
              AND v.status = 'redeemed'
          )::INTEGER AS redeemed_today,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND vs.issued_at::date = CURRENT_DATE
              AND v.status = 'unused'
          )::INTEGER AS waiting_today,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND (
                $2::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
              )
              AND (
                $3::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
              )
          )::INTEGER AS sold_period,
          COALESCE(
            SUM(vs.sale_price_tzs) FILTER (
              WHERE vs.sale_status = 'issued'
                AND (
                  $2::date IS NULL
                  OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
                )
                AND (
                  $3::date IS NULL
                  OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
                )
            ),
            0
          )::BIGINT AS collected_period,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND v.status = 'redeemed'
              AND (
                $2::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
              )
              AND (
                $3::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
              )
          )::INTEGER AS redeemed_period,
          COUNT(vs.id) FILTER (
            WHERE vs.sale_status = 'issued'
              AND v.status = 'unused'
              AND (
                $2::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
              )
              AND (
                $3::date IS NULL
                OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
              )
          )::INTEGER AS waiting_period
        FROM platform_users u
        JOIN sites s ON s.id = u.site_id
        LEFT JOIN voucher_sales vs
          ON vs.cashier_user_id = u.id
          AND vs.organization_id = $1
        LEFT JOIN vouchers v ON v.id = vs.voucher_id
        WHERE u.organization_id = $1
          AND u.role = 'cashier'
        GROUP BY u.id, s.name
        ORDER BY
          COALESCE(
            SUM(vs.sale_price_tzs) FILTER (
              WHERE vs.sale_status = 'issued'
                AND (
                  $2::date IS NULL
                  OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $2::date
                )
                AND (
                  $3::date IS NULL
                  OR (vs.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $3::date
                )
            ),
            0
          ) DESC,
          u.full_name,
          u.id
      `,
      [organizationId, startDate, endDate]
    )
  ).rows;

  return {
    totals: totalsResult.rows[0] || {
      sold_today: 0,
      expected_cash_today: 0,
      redeemed_today: 0,
      waiting_today: 0,
      voided_today: 0,
      sold_period: 0,
      collected_period: 0,
      redeemed_period: 0,
      waiting_period: 0,
      voided_period: 0
    },
    cashiers
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


const getVoucherAttemptState = async ({
  organizationId,
  siteId,
  deviceId
}) => {
  const result = await pool.query(
    `
      SELECT
        failure_count,
        window_started_at,
        blocked_until
      FROM voucher_redemption_attempts
      WHERE organization_id = $1
        AND site_id = $2
        AND device_id = $3
      LIMIT 1
    `,
    [organizationId, siteId, deviceId]
  );

  return result.rows[0] || null;
};

const assertVoucherAttemptAllowed = async ({
  organizationId,
  siteId,
  deviceId
}) => {
  const state = await getVoucherAttemptState({
    organizationId,
    siteId,
    deviceId
  });

  if (!state?.blocked_until) {
    return;
  }

  const blockedUntil = new Date(state.blocked_until).getTime();

  if (blockedUntil <= Date.now()) {
    return;
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((blockedUntil - Date.now()) / 1000)
  );

  const error = new Error(
    'Too many invalid voucher attempts. Please try again later.'
  );
  error.code = 'VOUCHER_RATE_LIMIT';
  error.statusCode = 429;
  error.retryAfterSeconds = retryAfterSeconds;
  throw error;
};

const recordInvalidVoucherAttempt = async ({
  organizationId,
  siteId,
  deviceId
}) => {
  const result = await pool.query(
    `
      INSERT INTO voucher_redemption_attempts (
        organization_id,
        site_id,
        device_id,
        failure_count,
        window_started_at,
        last_failed_at,
        updated_at
      )
      VALUES ($1, $2, $3, 1, NOW(), NOW(), NOW())
      ON CONFLICT (organization_id, site_id, device_id)
      DO UPDATE SET
        failure_count = CASE
          WHEN voucher_redemption_attempts.window_started_at
            <= NOW() - ($4 * INTERVAL '1 minute')
          THEN 1
          ELSE voucher_redemption_attempts.failure_count + 1
        END,
        window_started_at = CASE
          WHEN voucher_redemption_attempts.window_started_at
            <= NOW() - ($4 * INTERVAL '1 minute')
          THEN NOW()
          ELSE voucher_redemption_attempts.window_started_at
        END,
        last_failed_at = NOW(),
        updated_at = NOW(),
        blocked_until = CASE
          WHEN (
            CASE
              WHEN voucher_redemption_attempts.window_started_at
                <= NOW() - ($4 * INTERVAL '1 minute')
              THEN 1
              ELSE voucher_redemption_attempts.failure_count + 1
            END
          ) >= $5
          THEN NOW() + ($6 * INTERVAL '1 minute')
          ELSE NULL
        END
      RETURNING failure_count, blocked_until
    `,
    [
      organizationId,
      siteId,
      deviceId,
      VOUCHER_FAILURE_WINDOW_MINUTES,
      VOUCHER_MAX_FAILED_ATTEMPTS,
      VOUCHER_BLOCK_MINUTES
    ]
  );

  const state = result.rows[0];

  if (state?.blocked_until) {
    const blockedUntil = new Date(state.blocked_until).getTime();

    return {
      blocked: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((blockedUntil - Date.now()) / 1000)
      )
    };
  }

  return {
    blocked: false,
    attemptsRemaining: Math.max(
      0,
      VOUCHER_MAX_FAILED_ATTEMPTS - Number(state?.failure_count || 0)
    )
  };
};

const clearVoucherAttempts = async ({
  organizationId,
  siteId,
  deviceId
}) => {
  await pool.query(
    `
      DELETE FROM voucher_redemption_attempts
      WHERE organization_id = $1
        AND site_id = $2
        AND device_id = $3
    `,
    [organizationId, siteId, deviceId]
  );
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
  const legacyCodeHash = legacyHashVoucherCode(normalizedCode);
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
        WHERE (v.code_hash = $1 OR v.code_hash = $2)
          AND v.organization_id = $3
          AND v.site_id = $4
        LIMIT 1
        FOR UPDATE OF v, vb
      `,
      [codeHash, legacyCodeHash, organizationId, siteId]
    );

    const voucher = voucherResult.rows[0];

    if (!voucher) {
      throw voucherError(
        'VOUCHER_INVALID',
        'Voucher code is invalid'
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


const createCashierVoucherSale = async ({
  organizationId,
  siteId,
  packageId,
  cashierUserId,
  requestKey
}) => {
  const safeRequestKey = String(requestKey || '').trim();

  if (!safeRequestKey || safeRequestKey.length > 80) {
    throw voucherError(
      'CASHIER_INVALID_REQUEST',
      'Voucher sale request is invalid'
    );
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['cashier-voucher:' + safeRequestKey]
    );

    const existingSaleResult = await client.query(
      `
        SELECT
          vs.*,
          v.code_enc,
          v.code_last4,
          v.status AS voucher_status,
          s.name AS site_name
        FROM voucher_sales vs
        JOIN vouchers v ON v.id = vs.voucher_id
        JOIN sites s ON s.id = vs.site_id
        WHERE vs.request_key = $1
          AND vs.cashier_user_id = $2
        LIMIT 1
      `,
      [safeRequestKey, cashierUserId]
    );

    const existingSale = existingSaleResult.rows[0];

    if (existingSale) {
      await client.query('COMMIT');

      return {
        sale: existingSale,
        code: decryptSecret(existingSale.code_enc),
        reused: true
      };
    }

    const cashierResult = await client.query(
      `
        SELECT
          id,
          organization_id,
          site_id,
          role,
          active
        FROM platform_users
        WHERE id = $1
        LIMIT 1
        FOR SHARE
      `,
      [cashierUserId]
    );

    const cashier = cashierResult.rows[0];

    if (
      !cashier ||
      !cashier.active ||
      cashier.role !== 'cashier' ||
      Number(cashier.organization_id) !== Number(organizationId) ||
      Number(cashier.site_id) !== Number(siteId)
    ) {
      throw voucherError(
        'CASHIER_NOT_AUTHORIZED',
        'Cashier is not authorized for this site',
        403
      );
    }

    const packageResult = await client.query(
      `
        SELECT
          p.id,
          p.site_id,
          p.name,
          p.price_tzs,
          p.duration_seconds,
          s.organization_id
        FROM packages p
        JOIN sites s ON s.id = p.site_id
        JOIN organizations o ON o.id = s.organization_id
        WHERE p.id = $1
          AND p.site_id = $2
          AND s.organization_id = $3
          AND p.active = TRUE
          AND p.deleted_at IS NULL
          AND s.active = TRUE
          AND o.active = TRUE
          AND o.vouchers_enabled = TRUE
          AND o.voucher_portal_enabled = TRUE
        LIMIT 1
        FOR SHARE OF p, s
      `,
      [packageId, siteId, organizationId]
    );

    const packageData = packageResult.rows[0];

    if (!packageData) {
      throw voucherError(
        'CASHIER_PACKAGE_UNAVAILABLE',
        'This package is not available for cashier voucher sales'
      );
    }

    const batchReference =
      'VS-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      randomToken(6);

    const batchResult = await client.query(
      `
        INSERT INTO voucher_batches (
          organization_id,
          site_id,
          package_id,
          created_by_user_id,
          cashier_user_id,
          batch_type,
          batch_reference,
          quantity,
          package_name_snapshot,
          package_price_tzs_snapshot,
          package_duration_seconds_snapshot,
          redeemable_until
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $4,
          'cashier',
          $5,
          1,
          $6,
          $7,
          $8,
          NULL
        )
        RETURNING *
      `,
      [
        organizationId,
        siteId,
        packageId,
        cashierUserId,
        batchReference,
        packageData.name,
        packageData.price_tzs,
        packageData.duration_seconds
      ]
    );

    const batch = batchResult.rows[0];
    let voucher = null;
    let code = null;

    while (!voucher) {
      const candidate = generateVoucherCode();
      const hash = hashVoucherCode(candidate);

      const voucherResult = await client.query(
        `
          INSERT INTO vouchers (
            organization_id,
            site_id,
            batch_id,
            code_hash,
            code_enc,
            code_last4
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (code_hash) DO NOTHING
          RETURNING *
        `,
        [
          organizationId,
          siteId,
          batch.id,
          hash,
          encryptSecret(candidate),
          normalizeVoucherCode(candidate).slice(-4)
        ]
      );

      if (voucherResult.rows[0]) {
        voucher = voucherResult.rows[0];
        code = candidate;
      }
    }

    const saleResult = await client.query(
      `
        INSERT INTO voucher_sales (
          organization_id,
          site_id,
          package_id,
          voucher_id,
          cashier_user_id,
          request_key,
          package_name_snapshot,
          package_duration_seconds_snapshot,
          sale_price_tzs
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [
        organizationId,
        siteId,
        packageId,
        voucher.id,
        cashierUserId,
        safeRequestKey,
        packageData.name,
        packageData.duration_seconds,
        packageData.price_tzs
      ]
    );

    await client.query('COMMIT');

    return {
      sale: saleResult.rows[0],
      voucher,
      batch,
      code,
      package: packageData,
      reused: false
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const voidCashierVoucherSale = async ({
  cashierUserId,
  saleId
}) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const saleResult = await client.query(
      `
        SELECT
          vs.id,
          vs.organization_id,
          vs.site_id,
          vs.voucher_id,
          vs.cashier_user_id,
          vs.sale_status,
          v.status AS voucher_status,
          v.batch_id
        FROM voucher_sales vs
        JOIN vouchers v ON v.id = vs.voucher_id
        WHERE vs.id = $1
          AND vs.cashier_user_id = $2
        LIMIT 1
        FOR UPDATE OF vs, v
      `,
      [saleId, cashierUserId]
    );

    const sale = saleResult.rows[0];

    if (!sale) {
      throw voucherError(
        'CASHIER_SALE_NOT_FOUND',
        'Voucher sale was not found',
        404
      );
    }

    if (sale.sale_status === 'voided') {
      await client.query('COMMIT');
      return { voided: true, reused: true };
    }

    if (sale.voucher_status !== 'unused') {
      throw voucherError(
        'CASHIER_VOUCHER_NOT_VOIDABLE',
        'Only an unused voucher can be voided'
      );
    }

    await client.query(
      `
        UPDATE vouchers
        SET
          status = 'cancelled',
          cancelled_at = NOW()
        WHERE id = $1
          AND status = 'unused'
      `,
      [sale.voucher_id]
    );

    await client.query(
      `
        UPDATE voucher_sales
        SET
          sale_status = 'voided',
          voided_at = NOW(),
          voided_by_user_id = $2
        WHERE id = $1
      `,
      [sale.id, cashierUserId]
    );

    await client.query(
      `
        UPDATE voucher_batches
        SET active = FALSE
        WHERE id = $1
          AND batch_type = 'cashier'
      `,
      [sale.batch_id]
    );

    await client.query('COMMIT');

    return { voided: true, reused: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const getCashierVoucherSale = async ({
  cashierUserId,
  saleId
}) => {
  const result = await pool.query(
    `
      SELECT
        vs.id,
        vs.organization_id,
        vs.site_id,
        vs.package_id,
        vs.voucher_id,
        vs.cashier_user_id,
        vs.package_name_snapshot,
        vs.package_duration_seconds_snapshot,
        vs.sale_price_tzs,
        vs.sale_status,
        vs.issued_at,
        v.code_enc,
        v.code_last4,
        v.status AS voucher_status,
        v.redeemed_at,
        s.name AS site_name
      FROM voucher_sales vs
      JOIN vouchers v ON v.id = vs.voucher_id
      JOIN sites s ON s.id = vs.site_id
      WHERE vs.id = $1
        AND vs.cashier_user_id = $2
      LIMIT 1
    `,
    [saleId, cashierUserId]
  );

  const sale = result.rows[0];

  if (!sale) {
    return null;
  }

  return {
    ...sale,
    code: decryptSecret(sale.code_enc),
    voidable:
      sale.sale_status === 'issued' &&
      sale.voucher_status === 'unused'
  };
};

module.exports = {
  MAX_BATCH_QUANTITY,
  normalizeVoucherCode,
  hashVoucherCode,
  getVoucherAdminOptions,
  createVoucherBatch,
  listVoucherBatches,
  getVoucherOverview,
  getCashierVoucherSalesSummary,
  getVoucherBatch,
  redeemVoucher,
  cancelVoucherBatch,
  cancelVoucher,
  assertVoucherAttemptAllowed,
  recordInvalidVoucherAttempt,
  clearVoucherAttempts,
  createCashierVoucherSale,
  getCashierVoucherSale,
  voidCashierVoucherSale
};
