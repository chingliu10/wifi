const pool = require('../config/database');

const createPaymentTransaction = async ({
  reference,
  customerName,
  phone,
  packageId,
  clientMac,
  deviceId,
  amountTzs,
  status,
  provider = null,
  providerReference = null,
  site = null,
  apMac = null,
  ssidName = null,
  redirectUrl = null,
  radioId = null
}) => {
  const result = await pool.query(
    `
      INSERT INTO payment_transactions (
        reference,
        customer_name,
        phone,
        package_id,
        site_id,
        organization_id,
        client_mac,
        device_id,
        amount_tzs,
        status,
        provider,
        provider_reference,
        site,
        ap_mac,
        ssid_name,
        redirect_url,
        radio_id
      )
      VALUES (
        $1, $2, $3, $4,
        (SELECT site_id FROM packages WHERE id = $4),
        (
          SELECT s.organization_id
          FROM packages p
          JOIN sites s ON s.id = p.site_id
          WHERE p.id = $4
        ),
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15
      )
      RETURNING *
    `,
    [
      reference,
      customerName,
      phone,
      packageId,
      clientMac,
      deviceId,
      amountTzs,
      status,
      provider,
      providerReference,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    ]
  );

  return result.rows[0];
};

const findPaymentTransactionByReference = async (reference) => {
  const result = await pool.query(
    `
      SELECT
        pt.id,
        pt.reference,
        pt.customer_name,
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
        pt.gateway_fee_tzs,
        pt.net_amount_tzs,
        pt.organization_id,
        pt.status,
        pt.provider,
        pt.provider_reference,
        pt.site,
        pt.ap_mac,
        pt.ssid_name,
        pt.redirect_url,
        pt.radio_id,
        pt.created_at,
        pt.updated_at,
        pt.paid_at,
        pt.provisioning_status,
        pt.provisioning_error,
        pt.provisioned_at,
        p.name AS package_name,
        p.price_tzs AS package_price_tzs,
        p.duration_seconds AS package_duration_seconds,
        p.site_id AS package_site_id,
        COALESCE(s.brand_name, s.name || ' WiFi') AS site_brand_name,
        s.support_phone AS site_support_phone,
        s.primary_color AS site_primary_color,
        s.external_portal_site_id
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      JOIN sites s ON s.id = p.site_id
      WHERE pt.reference = $1
      LIMIT 1
    `,
    [reference]
  );

  return result.rows[0] || null;
};

const findPaymentTransactionByProviderReference = async (providerReference) => {
  const result = await pool.query(
    `
      SELECT
        pt.id,
        pt.reference,
        pt.customer_name,
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
        pt.gateway_fee_tzs,
        pt.net_amount_tzs,
        pt.organization_id,
        pt.status,
        pt.provider,
        pt.provider_reference,
        pt.site,
        pt.ap_mac,
        pt.ssid_name,
        pt.redirect_url,
        pt.radio_id,
        pt.created_at,
        pt.updated_at,
        pt.paid_at,
        pt.provisioning_status,
        pt.provisioning_error,
        pt.provisioned_at,
        p.name AS package_name,
        p.price_tzs AS package_price_tzs,
        p.duration_seconds AS package_duration_seconds,
        p.site_id AS package_site_id,
        COALESCE(s.brand_name, s.name || ' WiFi') AS site_brand_name,
        s.support_phone AS site_support_phone,
        s.primary_color AS site_primary_color,
        s.external_portal_site_id
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      JOIN sites s ON s.id = p.site_id
      WHERE pt.provider_reference = $1
      LIMIT 1
    `,
    [providerReference]
  );

  return result.rows[0] || null;
};

const findPaymentTransactionByReferenceForUpdate = async ({
  db,
  reference
}) => {
  const result = await db.query(
    `
      SELECT
        pt.id,
        pt.reference,
        pt.customer_name,
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
        pt.gateway_fee_tzs,
        pt.net_amount_tzs,
        pt.organization_id,
        pt.status,
        pt.provider,
        pt.provider_reference,
        pt.site,
        pt.ap_mac,
        pt.ssid_name,
        pt.redirect_url,
        pt.radio_id,
        pt.created_at,
        pt.updated_at,
        pt.paid_at,
        pt.provisioning_status,
        pt.provisioning_error,
        pt.provisioned_at,
        p.name AS package_name,
        p.price_tzs AS package_price_tzs,
        p.duration_seconds AS package_duration_seconds,
        p.site_id AS package_site_id,
        COALESCE(s.brand_name, s.name || ' WiFi') AS site_brand_name,
        s.support_phone AS site_support_phone,
        s.primary_color AS site_primary_color,
        s.external_portal_site_id
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      JOIN sites s ON s.id = p.site_id
      WHERE pt.reference = $1
      FOR UPDATE OF pt
      LIMIT 1
    `,
    [reference]
  );

  return result.rows[0] || null;
};

const findRecentReusablePayment = async ({
  deviceId,
  packageId,
  phone,
  clientMac,
  amountTzs,
  windowSeconds = 120
}) => {
  const safeWindowSeconds = Math.max(
    15,
    Math.min(Number(windowSeconds) || 120, 600)
  );

  const result = await pool.query(
    `
      SELECT reference
      FROM payment_transactions
      WHERE device_id = $1
        AND package_id = $2
        AND phone = $3
        AND client_mac = $4
        AND amount_tzs = $5
        AND status IN ('pending', 'paid')
        AND created_at >= NOW() - ($6 * INTERVAL '1 second')
      ORDER BY
        CASE WHEN status = 'paid' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `,
    [
      deviceId,
      packageId,
      phone,
      clientMac,
      amountTzs,
      safeWindowSeconds
    ]
  );

  if (!result.rows[0]) {
    return null;
  }

  return findPaymentTransactionByReference(result.rows[0].reference);
};

const findLatestCustomerByDeviceId = async (deviceId) => {
  const result = await pool.query(
    `
      SELECT
        customer_name,
        phone
      FROM payment_transactions
      WHERE device_id = $1
        AND customer_name IS NOT NULL
        AND BTRIM(customer_name) <> ''
      ORDER BY
        CASE WHEN status = 'paid' THEN 0 ELSE 1 END,
        paid_at DESC NULLS LAST,
        created_at DESC
      LIMIT 1
    `,
    [deviceId]
  );

  return result.rows[0] || null;
};

const updatePaymentProviderDetails = async ({
  reference,
  provider,
  providerReference,
  gatewayFeeTzs = null,
  netAmountTzs = null
}) => {
  const result = await pool.query(
    `
      UPDATE payment_transactions
      SET
        provider = $2,
        provider_reference = COALESCE(provider_reference, $3),
        gateway_fee_tzs = COALESCE(gateway_fee_tzs, $4),
        net_amount_tzs = COALESCE(net_amount_tzs, $5),
        updated_at = NOW()
      WHERE reference = $1
        AND status = 'pending'
        AND (
          provider_reference IS NULL
          OR gateway_fee_tzs IS NULL
          OR net_amount_tzs IS NULL
        )
      RETURNING *
    `,
    [reference, provider, providerReference, gatewayFeeTzs, netAmountTzs]
  );

  return result.rows[0] || null;
};

const updatePaymentStatus = async ({
  providerReference,
  status
}) => {
  const result = await pool.query(
    `
      UPDATE payment_transactions
      SET
        status = $2,
        updated_at = NOW(),
        paid_at = CASE
          WHEN $2 = 'paid' THEN NOW()
          ELSE paid_at
        END
      WHERE provider_reference = $1
        AND status = 'pending'
        AND $2 IN ('paid', 'failed', 'cancelled', 'expired')
      RETURNING *
    `,
    [providerReference, status]
  );

  return result.rows[0] || null;
};

const markPaymentProvisioningActive = async ({ db, reference }) => {
  const result = await db.query(
    `
      UPDATE payment_transactions
      SET
        provisioning_status = 'active',
        provisioning_error = NULL,
        provisioned_at = NOW(),
        updated_at = NOW()
      WHERE reference = $1
      RETURNING *
    `,
    [reference]
  );

  return result.rows[0] || null;
};

const markPaymentProvisioningFailed = async ({ reference, error }) => {
  const result = await pool.query(
    `
      UPDATE payment_transactions
      SET
        provisioning_status = 'failed',
        provisioning_error = $2,
        updated_at = NOW()
      WHERE reference = $1
      RETURNING *
    `,
    [reference, error]
  );

  return result.rows[0] || null;
};

module.exports = {
  createPaymentTransaction,
  findPaymentTransactionByReference,
  findPaymentTransactionByProviderReference,
  findPaymentTransactionByReferenceForUpdate,
  findRecentReusablePayment,
  findLatestCustomerByDeviceId,
  updatePaymentProviderDetails,
  updatePaymentStatus,
  markPaymentProvisioningActive,
  markPaymentProvisioningFailed
};
