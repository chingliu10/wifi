const pool = require('../config/database');

const createPaymentTransaction = async ({
  reference,
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
        phone,
        package_id,
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
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14
      )
      RETURNING *
    `,
    [
      reference,
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
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
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
        p.duration_seconds AS package_duration_seconds
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
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
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
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
        p.duration_seconds AS package_duration_seconds
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
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
        pt.phone,
        pt.package_id,
        pt.client_mac,
        pt.device_id,
        pt.amount_tzs,
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
        p.site_id AS package_site_id
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      WHERE pt.reference = $1
      FOR UPDATE OF pt
      LIMIT 1
    `,
    [reference]
  );

  return result.rows[0] || null;
};

const updatePaymentProviderDetails = async ({
  reference,
  provider,
  providerReference
}) => {
  const result = await pool.query(
    `
      UPDATE payment_transactions
      SET
        provider = $2,
        provider_reference = $3,
        updated_at = NOW()
      WHERE reference = $1
        AND status = 'pending'
        AND provider_reference IS NULL
      RETURNING *
    `,
    [reference, provider, providerReference]
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
        AND $2 IN ('paid', 'failed', 'cancelled')
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
  updatePaymentProviderDetails,
  updatePaymentStatus,
  markPaymentProvisioningActive,
  markPaymentProvisioningFailed
};
