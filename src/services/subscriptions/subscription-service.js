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
  let portalAuthAttempted = false;

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

    let omadaPortalAuth = {
      attempted: false,
      authorized: Boolean(lockedPayment.omada_portal_authorized_at)
    };

    if (!lockedPayment.omada_portal_authorized_at) {
      portalAuthAttempted = true;
      omadaPortalAuth.attempted = true;

      if (!omadaPortal.configured()) {
        throw new Error('Omada Hotspot Operator is not configured');
      }

      const expiresAtMs = new Date(subscription.expires_at).getTime();
      const durationMs = Math.max(0, expiresAtMs - Date.now());

      if (durationMs <= 0) {
        throw new Error('Subscription expired before Omada authorization');
      }

      const result = await omadaPortal.authorizeExternalPortalClient({
        clientMac: lockedPayment.client_mac,
        clientIp: lockedPayment.client_ip,
        apMac: lockedPayment.ap_mac,
        ssidName: lockedPayment.ssid_name,
        radioId: lockedPayment.radio_id,
        durationMs,
        originUrl: lockedPayment.redirect_url || ''
      });

      await markPaymentOmadaPortalAuthorized({
        db: client,
        reference: lockedPayment.reference
      });

      omadaPortalAuth = {
        ...result,
        attempted: true
      };

      console.log('OMADA EXTERNAL PORTAL AUTHORIZED AFTER PAYMENT:', {
        reference: lockedPayment.reference,
        clientMac: lockedPayment.client_mac,
        clientIp: lockedPayment.client_ip,
        ssidName: lockedPayment.ssid_name,
        durationMs: result.durationMs
      });
    }

    await markPaymentProvisioningActive({
      db: client,
      reference: lockedPayment.reference
    });

    await client.query('COMMIT');

    return {
      subscription,
      radiusRecords,
      wallet,
      omadaPortalAuth
    };
  } catch (error) {
    await client.query('ROLLBACK');

    if (paymentTransaction && paymentTransaction.reference) {
      if (portalAuthAttempted) {
        await markPaymentOmadaPortalAuthFailed({
          reference: paymentTransaction.reference,
          error: error.message
        });
      }

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
