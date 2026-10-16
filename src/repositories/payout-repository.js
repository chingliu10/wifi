const pool = require('../config/database');

const getSpendableBalance = async (organizationId, client = pool) => {
  const result = await client.query(
    `
      SELECT
        COALESCE((
          SELECT SUM(amount_tzs)
          FROM wallet_entries
          WHERE organization_id = $1
        ), 0)::NUMERIC(18,2)
        -
        COALESCE((
          SELECT SUM(total_amount_tzs)
          FROM payout_transactions
          WHERE organization_id = $1
            AND status IN ('pending', 'processing')
        ), 0)::NUMERIC(18,2)
        AS available_balance
    `,
    [organizationId]
  );

  return Number(result.rows[0]?.available_balance || 0);
};

const createPayoutReservation = async (data) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      Number(data.organizationId)
    ]);

    const availableBalance = await getSpendableBalance(
      data.organizationId,
      client
    );

    if (availableBalance < Number(data.totalAmountTzs)) {
      const error = new Error('Insufficient wallet balance');
      error.code = 'INSUFFICIENT_WALLET_BALANCE';
      error.availableBalance = availableBalance;
      throw error;
    }

    const result = await client.query(
      `
        INSERT INTO payout_transactions (
          organization_id,
          requested_by_user_id,
          provider,
          reference,
          recipient_phone,
          recipient_name,
          network,
          amount_tzs,
          fee_tzs,
          total_amount_tzs,
          status,
          remarks
        )
        VALUES ($1, $2, 'splashpay', $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
        RETURNING *
      `,
      [
        data.organizationId,
        data.requestedByUserId || null,
        data.reference,
        data.recipientPhone,
        data.recipientName,
        data.network,
        data.amountTzs,
        data.feeTzs,
        data.totalAmountTzs,
        data.remarks || null
      ]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const findPayoutByReference = async (reference) => {
  const result = await pool.query(
    'SELECT * FROM payout_transactions WHERE reference = $1 LIMIT 1',
    [reference]
  );

  return result.rows[0] || null;
};

const findPayoutByProviderReference = async (providerReference) => {
  if (!providerReference) return null;

  const result = await pool.query(
    `
      SELECT *
      FROM payout_transactions
      WHERE provider = 'splashpay'
        AND provider_reference = $1
      LIMIT 1
    `,
    [providerReference]
  );

  return result.rows[0] || null;
};

const updatePayoutProviderState = async (data) => {
  const result = await pool.query(
    `
      UPDATE payout_transactions
      SET
        provider_reference = COALESCE($2, provider_reference),
        fee_tzs = COALESCE($3, fee_tzs),
        total_amount_tzs = COALESCE($4, total_amount_tzs),
        status = COALESCE($5, status),
        processed_at = CASE
          WHEN $5 IN ('processing', 'paid') THEN COALESCE(processed_at, NOW())
          ELSE processed_at
        END,
        updated_at = NOW()
      WHERE reference = $1
      RETURNING *
    `,
    [
      data.reference,
      data.providerReference || null,
      data.feeTzs ?? null,
      data.totalAmountTzs ?? null,
      data.status || null
    ]
  );

  return result.rows[0] || null;
};

const failPayout = async ({ reference, status = 'failed', code, message }) => {
  const finalStatus = status === 'cancelled' ? 'cancelled' : 'failed';

  const result = await pool.query(
    `
      UPDATE payout_transactions
      SET
        status = $2,
        error_code = $3,
        error_message = $4,
        failed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE failed_at END,
        cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END,
        updated_at = NOW()
      WHERE reference = $1
        AND status <> 'paid'
      RETURNING *
    `,
    [reference, finalStatus, code || null, message || null]
  );

  return result.rows[0] || null;
};

module.exports = {
  getSpendableBalance,
  createPayoutReservation,
  findPayoutByReference,
  findPayoutByProviderReference,
  updatePayoutProviderState,
  failPayout
};
