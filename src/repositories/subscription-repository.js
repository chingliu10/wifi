const pool = require('../config/database');

const query = (db, sql, params) => {
  return (db || pool).query(sql, params);
};

const findActiveSubscriptionByDeviceId = async (deviceId) => {
  const result = await pool.query(
    `
      SELECT
        id,
        site_id,
        device_id,
        package_id,
        payment_id,
        starts_at,
        expires_at,
        status
      FROM subscriptions
      WHERE device_id = $1
        AND status = 'active'
        AND starts_at <= NOW()
        AND expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT 1
    `,
    [deviceId]
  );

  return result.rows[0] || null;
};

const findActiveSubscriptionByDeviceAndSite = async ({
  deviceId,
  siteId
}) => {
  const result = await pool.query(
    `
      SELECT
        sub.id,
        sub.site_id,
        sub.device_id,
        sub.package_id,
        sub.payment_id,
        sub.payment_transaction_id,
        sub.client_mac,
        sub.starts_at,
        sub.expires_at,
        sub.status,
        COALESCE(
          vb.package_name_snapshot,
          p.name,
          'Complimentary access'
        ) AS package_name,
        COALESCE(
          vb.package_duration_seconds_snapshot,
          p.duration_seconds
        ) AS package_duration_seconds,
        sub.access_source,
        sub.granted_by_user_id,
        sub.grant_note
      FROM subscriptions sub
      LEFT JOIN packages p ON p.id = sub.package_id
      LEFT JOIN vouchers v ON v.subscription_id = sub.id
      LEFT JOIN voucher_batches vb ON vb.id = v.batch_id
      WHERE sub.device_id = $1
        AND sub.site_id = $2
        AND sub.status = 'active'
        AND sub.starts_at <= NOW()
        AND sub.expires_at > NOW()
      ORDER BY sub.expires_at DESC
      LIMIT 1
    `,
    [deviceId, siteId]
  );

  return result.rows[0] || null;
};


const findSubscriptionByPaymentTransactionId = async ({
  db,
  paymentTransactionId
}) => {
  const result = await query(
    db,
    `
      SELECT
        id,
        site_id,
        device_id,
        package_id,
        payment_id,
        payment_transaction_id,
        client_mac,
        starts_at,
        expires_at,
        status,
        created_at,
        updated_at
      FROM subscriptions
      WHERE payment_transaction_id = $1
      LIMIT 1
    `,
    [paymentTransactionId]
  );

  return result.rows[0] || null;
};

const createSubscriptionForPayment = async ({
  db,
  siteId,
  deviceId,
  packageId,
  paymentTransactionId,
  clientMac,
  durationSeconds
}) => {
  const result = await query(
    db,
    `
      INSERT INTO subscriptions (
        site_id,
        device_id,
        package_id,
        payment_transaction_id,
        client_mac,
        starts_at,
        expires_at,
        status
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW(),
        NOW() + ($6 * INTERVAL '1 second'),
        'active'
      )
      RETURNING *
    `,
    [
      siteId,
      deviceId,
      packageId,
      paymentTransactionId,
      clientMac,
      durationSeconds
    ]
  );

  return result.rows[0];
};


const createComplimentarySubscription = async ({
  siteId,
  deviceId,
  clientMac,
  durationSeconds,
  grantedByUserId,
  grantNote = null
}) => {
  const result = await pool.query(
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
        NULL,
        NULL,
        NULL,
        $3,
        COALESCE((SELECT expires_at FROM current_access), NOW()),
        COALESCE((SELECT expires_at FROM current_access), NOW())
          + ($4 * INTERVAL '1 second'),
        'active',
        'complimentary',
        $5,
        $6
      )
      RETURNING *
    `,
    [
      deviceId,
      siteId,
      clientMac,
      durationSeconds,
      grantedByUserId,
      grantNote
    ]
  );

  return result.rows[0];
};


const createOrExtendSubscription = async ({
  siteId,
  deviceId,
  packageId,
  paymentId = null,
  durationSeconds
}) => {
  const result = await pool.query(
    `
      WITH current_subscription AS (
        SELECT expires_at
        FROM subscriptions
        WHERE device_id = $1
          AND status = 'active'
          AND expires_at > NOW()
        ORDER BY expires_at DESC
        LIMIT 1
      )
      INSERT INTO subscriptions (
        site_id,
        device_id,
        package_id,
        payment_id,
        starts_at,
        expires_at,
        status
      )
      VALUES (
        $2,
        $1,
        $3,
        $4,
        COALESCE(
          (SELECT expires_at FROM current_subscription),
          NOW()
        ),
        COALESCE(
          (SELECT expires_at FROM current_subscription),
          NOW()
        ) + ($5 * INTERVAL '1 second'),
        'active'
      )
      RETURNING *
    `,
    [
      deviceId,
      siteId,
      packageId,
      paymentId,
      durationSeconds
    ]
  );

  return result.rows[0];
};


module.exports = {
  findActiveSubscriptionByDeviceId,
  findActiveSubscriptionByDeviceAndSite,
  findSubscriptionByPaymentTransactionId,
  createSubscriptionForPayment,
  createComplimentarySubscription,
  createOrExtendSubscription
};
