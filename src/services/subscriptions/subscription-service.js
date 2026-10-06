const pool = require('../../config/database');
const {
  findPaymentTransactionByReferenceForUpdate,
  markPaymentProvisioningActive,
  markPaymentProvisioningFailed
} = require('../../repositories/payment-transaction-repository');
const {
  findSubscriptionByPaymentTransactionId,
  createSubscriptionForPayment
} = require('../../repositories/subscription-repository');
const { authorizeSubscription } = require('../radius/radius-service');

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

    await markPaymentProvisioningActive({
      db: client,
      reference: lockedPayment.reference
    });

    await client.query('COMMIT');

    return {
      subscription,
      radiusRecords
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
