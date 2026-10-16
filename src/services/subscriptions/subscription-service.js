const pool = require('../../config/database');
const {
  findPaymentTransactionByReferenceForUpdate,
  markPaymentOmadaPortalAuthorized,
  markPaymentOmadaPortalAuthFailed,
  markPaymentProvisioningActive,
  markPaymentProvisioningFailed
} = require('../../repositories/payment-transaction-repository');
const {
  findSubscriptionByPaymentTransactionId,
  createSubscriptionForPayment
} = require('../../repositories/subscription-repository');
const { authorizeSubscription } = require('../radius/radius-service');
const omadaPortal = require('../omada/external-portal-client');

const recordPaymentWalletEntries = async ({ db, payment }) => {
  if (
    payment.organization_id === null ||
    payment.organization_id === undefined ||
    payment.gateway_fee_tzs === null ||
    payment.gateway_fee_tzs === undefined ||
    payment.net_amount_tzs === null ||
    payment.net_amount_tzs === undefined
  ) {
    return {
      reconciled: false,
      reason: 'Gateway fee/net amount is not available'
    };
  }

  const gatewayFeeTzs = Number(payment.gateway_fee_tzs);
  const netAmountTzs = Number(payment.net_amount_tzs);

  if (
    !Number.isFinite(gatewayFeeTzs) ||
    !Number.isFinite(netAmountTzs) ||
    gatewayFeeTzs < 0 ||
    netAmountTzs < 0
  ) {
    return {
      reconciled: false,
      reason: 'Gateway fee/net amount is invalid'
    };
  }

  /*
   * Provider settlement is authoritative. Credit net + fee, then post the
   * fee as a debit so SUM(wallet_entries.amount_tzs) equals provider net.
   */
  const settlementGrossTzs = netAmountTzs + gatewayFeeTzs;

  await db.query(
    `
      INSERT INTO wallet_entries (
        organization_id,
        payment_transaction_id,
        entry_type,
        amount_tzs,
        description
      )
      VALUES ($1, $2, 'payment_credit', $3, $4)
      ON CONFLICT DO NOTHING
    `,
    [
      payment.organization_id,
      payment.id,
      settlementGrossTzs,
      `Customer payment ${payment.reference}`
    ]
  );

  if (gatewayFeeTzs > 0) {
    await db.query(
      `
        INSERT INTO wallet_entries (
          organization_id,
          payment_transaction_id,
          entry_type,
          amount_tzs,
          description
        )
        VALUES ($1, $2, 'gateway_fee', $3, $4)
        ON CONFLICT DO NOTHING
      `,
      [
        payment.organization_id,
        payment.id,
        -gatewayFeeTzs,
        `Gateway fee for ${payment.reference}`
      ]
    );
  }

  return {
    reconciled: true,
    gatewayFeeTzs,
    netAmountTzs
  };
};

const activateSubscriptionForPayment = async (paymentTransaction) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const lockedPayment = await findPaymentTransactionByReferenceForUpdate({
      db: client,
      reference: paymentTransaction.reference
    });

    if (!lockedPayment) {
      throw new Error('Payment transaction not found');
    }

    if (lockedPayment.status !== 'paid') {
      throw new Error('Payment transaction is not paid');
    }

    const shouldRequestOmadaReauth =
      lockedPayment.provisioning_status !== 'active';

    let subscription = await findSubscriptionByPaymentTransactionId({
      db: client,
      paymentTransactionId: lockedPayment.id
    });

    if (!subscription) {
      subscription = await createSubscriptionForPayment({
        db: client,
        siteId: lockedPayment.package_site_id,
        deviceId: lockedPayment.device_id,
        packageId: lockedPayment.package_id,
        paymentTransactionId: lockedPayment.id,
        clientMac: lockedPayment.client_mac,
        durationSeconds: lockedPayment.package_duration_seconds
      });
    }

    const radiusRecords = await authorizeSubscription({
      db: client,
      subscription
    });

    const wallet = await recordPaymentWalletEntries({
      db: client,
      payment: lockedPayment
    });

    if (!wallet.reconciled) {
      console.warn('PAYMENT WALLET NOT RECONCILED:', {
        reference: lockedPayment.reference,
        reason: wallet.reason
      });
    }

    await markPaymentProvisioningActive({
      db: client,
      reference: lockedPayment.reference
    });

    await client.query('COMMIT');

    let omadaReauth = {
      attempted: false,
      requested: false
    };

    if (
      shouldRequestOmadaReauth &&
      omada.configured() &&
      lockedPayment.external_portal_site_id &&
      lockedPayment.client_mac
    ) {
      omadaReauth.attempted = true;

      try {
        await omada.cancelAuthClient({
          siteId: lockedPayment.external_portal_site_id,
          clientMac: lockedPayment.client_mac
        });

        omadaReauth.requested = true;

        console.log('OMADA CLIENT REAUTH REQUESTED AFTER PAYMENT:', {
          reference: lockedPayment.reference,
          siteId: lockedPayment.external_portal_site_id,
          clientMac: lockedPayment.client_mac
        });
      } catch (error) {
        omadaReauth.error = error.message;

        /*
         * The subscription and RADIUS authorization are already valid.
         * A failed Omada unauth must never roll back a successful payment.
         * The client can still reconnect manually and authenticate via RADIUS.
         */
        console.error('OMADA POST-PAYMENT REAUTH ERROR:', {
          reference: lockedPayment.reference,
          siteId: lockedPayment.external_portal_site_id,
          clientMac: lockedPayment.client_mac,
          error: error.message
        });
      }
    }

    return {
      subscription,
      radiusRecords,
      wallet,
      omadaReauth
    };
  } catch (error) {
    await client.query('ROLLBACK');

    if (paymentTransaction && paymentTransaction.reference) {
      await markPaymentProvisioningFailed({
        reference: paymentTransaction.reference,
        error: error.message
      });
    }

    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  activateSubscriptionForPayment
};
