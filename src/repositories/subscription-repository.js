const pool = require('../config/database');

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
    createOrExtendSubscription
};