const express = require('express');
const provider = require('../services/payments/providers/fastlipa-provider');
const {
  findPaymentTransactionByReference,
  updatePaymentStatus
} = require('../repositories/payment-transaction-repository');
const {activateSubscriptionForPayment} = require('../services/subscriptions/subscription-service');

const router = express.Router();

router.post('/api/payments/fastlipa/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  if (!provider.verifyWebhook(req.body, req.get('X-FastLipa-Signature'))) {
    return res.status(401).json({success: false, error: 'Invalid webhook signature'});
  }

  let event;
  try { event = provider.parseWebhook(JSON.parse(req.body.toString('utf8'))); }
  catch { return res.status(400).json({success: false, error: 'Invalid webhook JSON'}); }
  if (!event || !event.status) return res.status(200).json({success: true, ignored: true});

  try {
    if (!event.reference || !event.providerReference || !Number.isFinite(event.amountTzs)) {
      return res.status(400).json({success: false, error: 'Incomplete payment event'});
    }
    const transaction = await findPaymentTransactionByReference(event.reference);
    if (!transaction) return res.status(404).json({success: false, error: 'Payment not found'});
    if (transaction.provider !== 'fastlipa' ||
        transaction.provider_reference !== event.providerReference ||
        Number(transaction.amount_tzs) !== event.amountTzs) {
      return res.status(400).json({success: false, error: 'Payment identity mismatch'});
    }

    if (transaction.status !== 'pending') {
      if (transaction.status === 'paid') await activateSubscriptionForPayment(transaction);
      return res.status(200).json({success: true, ignored: true});
    }

    const updated = await updatePaymentStatus({
      providerReference: event.providerReference,
      status: event.status
    });
    if (!updated) return res.status(503).json({success: false, error: 'Payment update deferred'});
    if (updated.status === 'paid') await activateSubscriptionForPayment(updated);
    return res.json({success: true, status: updated.status});
  } catch (error) {
    console.error('FASTLIPA WEBHOOK ERROR', error);
    return res.status(500).json({success: false, error: 'Webhook processing failed'});
  }
});

module.exports = router;
