const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { engine } = require('express-handlebars');
const pool = require('./config/database');
const { getOrCreateDevice } = require('./services/device-service');
const { getDeviceAccessStatus } = require('./services/subscription-service');
const { activatePackageForDevice } = require('./services/subscription-service');
const { normalizeMacAddress } = require('./utils/mac-address');
const { generatePaymentReference } = require('./utils/payment-reference');
const {
  createPaymentTransaction,
  findPaymentTransactionByReference,
  findPaymentTransactionByProviderReference,
  updatePaymentProviderDetails,
  updatePaymentStatus
} = require('./repositories/payment-transaction-repository');
const {
  findSubscriptionByPaymentTransactionId
} = require('./repositories/subscription-repository');
const { initiatePayment } = require('./services/payments/payment-service');
const {
  activateSubscriptionForPayment
} = require('./services/subscriptions/subscription-service');

const app = express();

const callbackStatuses = new Set(['paid', 'failed', 'cancelled']);

const getHeaderValue = (req, name) => {
  const value = req.headers[String(name || '').toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const secureHexEqual = (left, right) => {
  if (!left || !right) {
    return false;
  }

  const cleanLeft = String(left).replace(/^sha256=/i, '').trim().toLowerCase();
  const cleanRight = String(right).replace(/^sha256=/i, '').trim().toLowerCase();

  if (!/^[a-f0-9]+$/i.test(cleanLeft) || !/^[a-f0-9]+$/i.test(cleanRight)) {
    return false;
  }

  const leftBuffer = Buffer.from(cleanLeft, 'hex');
  const rightBuffer = Buffer.from(cleanRight, 'hex');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifySplashPayWebhook = (req) => {
  const secret = process.env.SPLASHPAY_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('SPLASHPAY_WEBHOOK_SECRET is not configured');
  }

  if (!req.rawBody) {
    return false;
  }

  const signatureHeader =
    process.env.SPLASHPAY_WEBHOOK_SIGNATURE_HEADER || 'x-splashpay-signature';
  const timestampHeader =
    process.env.SPLASHPAY_WEBHOOK_TIMESTAMP_HEADER || 'x-splashpay-timestamp';

  const signature = getHeaderValue(req, signatureHeader);
  const timestamp = getHeaderValue(req, timestampHeader);

  if (!signature) {
    return false;
  }

  const rawBody = req.rawBody.toString('utf8');
  const candidates = [
    crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')
  ];

  if (timestamp) {
    candidates.push(
      crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex')
    );
  }

  return candidates.some((expected) => secureHexEqual(signature, expected));
};

const mapSplashPayStatus = (payload) => {
  const event = String(payload.event || '').toLowerCase();
  const data = payload.data || payload;
  const rawStatus = String(data.status || payload.status || '').toLowerCase();

  if (
    rawStatus === 'success' ||
    rawStatus === 'paid' ||
    rawStatus === 'completed' ||
    event.endsWith('.success') ||
    event.endsWith('.paid') ||
    event.endsWith('.completed')
  ) {
    return 'paid';
  }

  if (rawStatus === 'failed' || event.endsWith('.failed')) {
    return 'failed';
  }

  if (
    rawStatus === 'cancelled' ||
    rawStatus === 'canceled' ||
    event.endsWith('.cancelled') ||
    event.endsWith('.canceled')
  ) {
    return 'cancelled';
  }

  return null;
};


const buildPackageView = (transaction) => ({
  id: transaction.package_id,
  name: transaction.package_name,
  price_tzs: transaction.package_price_tzs,
  duration_seconds: transaction.package_duration_seconds
});

const buildPaymentMessage = (transaction, subscription) => {
  if (transaction.status === 'paid' && subscription && subscription.status === 'active') {
    return 'Payment successful. Internet access activated.';
  }

  if (transaction.status === 'paid') {
    return 'Payment received. Preparing your internet access.';
  }

  if (transaction.status === 'pending' && transaction.provider_reference) {
    return 'Payment request sent. Please complete payment on your phone.';
  }

  if (transaction.status === 'pending') {
    return 'Payment request ready';
  }

  if (transaction.status === 'failed') {
    return 'Payment failed. Please try again.';
  }

  if (transaction.status === 'cancelled') {
    return 'Payment was cancelled.';
  }

  if (transaction.status === 'expired') {
    return 'Payment request expired.';
  }

  return 'Payment status unavailable.';
};

const loadSubscriptionForTransaction = async (transaction) => {
  return findSubscriptionByPaymentTransactionId({
    paymentTransactionId: transaction.id
  });
};

const renderPaymentStatus = async (res, transaction, title = 'Payment status') => {
  const subscription = await loadSubscriptionForTransaction(transaction);

  return res.render('portal/confirm', {
    title,
    transaction,
    package: buildPackageView(transaction),
    subscription,
    message: buildPaymentMessage(transaction, subscription),
    showPayNow: transaction.status === 'pending' && !transaction.provider_reference,
    paymentInitiated: transaction.status === 'pending' && Boolean(transaction.provider_reference)
  });
};

app.engine('hbs', engine({
  extname: '.hbs',
  defaultLayout: 'main',
  helpers: {
    formatTzs: (amount) => Number(amount).toLocaleString('en-US')
  }
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Hotspot backend is running'
  });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      success: true,
      database: 'connected',
      time: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/packages', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        price_tzs,
        duration_seconds
      FROM packages
      WHERE active = true
      ORDER BY sort_order
    `);

    res.json({
      success: true,
      packages: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/portal', async (req, res) => {
  console.log('PORTAL QUERY:', req.query);

  try {
    const {
      clientMac,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.query;

    const result = await pool.query(`
      SELECT
        id,
        name,
        price_tzs,
        duration_seconds
      FROM packages
      WHERE active = true
      ORDER BY sort_order
    `);

    const portalContext = {
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    };

    if (!clientMac) {
      return res.status(400).render('portal/index', {
        title: 'Small Garden WiFi',
        packages: result.rows,
        portal: portalContext,
        error: 'Missing client MAC address from portal request.'
      });
    }

    const device = await getOrCreateDevice(clientMac);

    res.render('portal/index', {
      title: 'Small Garden WiFi',
      packages: result.rows,
      device,
      portal: {
        ...portalContext,
        clientMac
      }
    });
  } catch (error) {
    console.error('PORTAL ERROR:', error);

    res.status(500).render('portal/index', {
      title: 'Small Garden WiFi',
      packages: [],
      error: 'Unable to load packages. Please try again later.'
    });
  }
});

app.post('/portal/pay', async (req, res) => {
  try {
    const {
      phone,
      packageId,
      deviceId,
      clientMac,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.body;

    if (!phone || !packageId || !clientMac || !deviceId) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Phone number, package, client MAC, and device ID are required.'
      });
    }

    const normalizedClientMac = normalizeMacAddress(clientMac);

    if (!normalizedClientMac) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Client MAC address is invalid.'
      });
    }

    const result = await pool.query(
      `
        SELECT
          id,
          name,
          price_tzs,
          duration_seconds
        FROM packages
        WHERE id = $1
          AND active = true
        LIMIT 1
      `,
      [packageId]
    );

    const packageData = result.rows[0];

    if (!packageData) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Selected package is not available.'
      });
    }

    const reference = generatePaymentReference();
    const transaction = await createPaymentTransaction({
      reference,
      phone,
      packageId: packageData.id,
      clientMac: normalizedClientMac,
      deviceId,
      amountTzs: packageData.price_tzs,
      status: 'pending',
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    });

    res.render('portal/confirm', {
      title: 'Payment request ready',
      transaction,
      package: packageData,
      message: 'Payment request ready',
      showPayNow: true,
      paymentInitiated: false
    });
  } catch (error) {
    console.error('PORTAL PAY ERROR:', error);

    res.status(500).render('portal/confirm', {
      title: 'Payment request',
      error: 'Unable to prepare payment request. Please try again later.'
    });
  }
});

app.get('/portal/payment/:reference', async (req, res) => {
  try {
    const transaction = await findPaymentTransactionByReference(
      req.params.reference
    );

    if (!transaction) {
      return res.status(404).render('portal/confirm', {
        title: 'Payment not found',
        error: 'Payment transaction was not found.'
      });
    }

    return await renderPaymentStatus(res, transaction);
  } catch (error) {
    console.error('PORTAL PAYMENT LOOKUP ERROR:', error);

    res.status(500).render('portal/confirm', {
      title: 'Payment status',
      error: 'Unable to load payment status. Please try again later.'
    });
  }
});

app.post('/portal/payment/:reference/initiate', async (req, res) => {
  try {
    const transaction = await findPaymentTransactionByReference(
      req.params.reference
    );

    if (!transaction) {
      return res.status(404).render('portal/confirm', {
        title: 'Payment not found',
        error: 'Payment transaction was not found.'
      });
    }

    if (transaction.status !== 'pending') {
      return await renderPaymentStatus(res, transaction);
    }

    if (transaction.provider_reference) {
      return await renderPaymentStatus(res, transaction);
    }

    const providerResult = await initiatePayment({
      transaction,
      packageData: buildPackageView(transaction)
    });

    const updatedTransaction = await updatePaymentProviderDetails({
      reference: transaction.reference,
      provider: providerResult.provider,
      providerReference: providerResult.providerReference
    });

    const currentTransaction = updatedTransaction
      ? await findPaymentTransactionByReference(transaction.reference)
      : await findPaymentTransactionByReference(transaction.reference);

    return await renderPaymentStatus(res, currentTransaction);
  } catch (error) {
    console.error('PORTAL PAYMENT INITIATE ERROR:', error);

    res.status(500).render('portal/confirm', {
      title: 'Payment status',
      error: 'Unable to initiate payment. Please try again later.'
    });
  }
});


app.post('/api/payments/splashpay/webhook', async (req, res) => {
  try {
    if (!verifySplashPayWebhook(req)) {
      console.warn('SPLASHPAY WEBHOOK REJECTED: invalid signature');
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature'
      });
    }

    const payload = req.body || {};
    const data = payload.data || payload;

    const reference = data.reference || payload.reference;
    const providerReference =
      data.provider_reference ||
      data.providerReference ||
      payload.provider_reference ||
      payload.providerReference;

    const mappedStatus = mapSplashPayStatus(payload);

    if (!reference && !providerReference) {
      return res.status(400).json({
        success: false,
        error: 'Webhook does not contain a payment reference'
      });
    }

    let transaction = null;

    if (providerReference) {
      transaction = await findPaymentTransactionByProviderReference(providerReference);
    }

    if (!transaction && reference) {
      transaction = await findPaymentTransactionByReference(reference);
    }

    if (!transaction) {
      console.warn('SPLASHPAY WEBHOOK: transaction not found', {
        reference,
        providerReference
      });

      return res.status(404).json({
        success: false,
        error: 'Payment transaction was not found'
      });
    }

    if (transaction.provider && transaction.provider !== 'splashpay') {
      return res.status(400).json({
        success: false,
        error: 'Payment provider mismatch'
      });
    }

    if (
      providerReference &&
      transaction.provider_reference &&
      providerReference !== transaction.provider_reference
    ) {
      return res.status(400).json({
        success: false,
        error: 'Provider reference mismatch'
      });
    }

    if (reference && reference !== transaction.reference) {
      return res.status(400).json({
        success: false,
        error: 'Merchant reference mismatch'
      });
    }

    if (data.currency && String(data.currency).toUpperCase() !== 'TZS') {
      return res.status(400).json({
        success: false,
        error: 'Currency mismatch'
      });
    }

    if (
      data.amount !== undefined &&
      Number(data.amount) !== Number(transaction.amount_tzs)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Payment amount mismatch'
      });
    }

    if (!mappedStatus) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Payment is still pending or processing'
      });
    }

    if (transaction.status !== 'pending') {
      if (transaction.status === 'paid') {
        try {
          await activateSubscriptionForPayment(transaction);
        } catch (error) {
          console.error('SPLASHPAY PROVISIONING RETRY ERROR:', error);
        }
      }

      return res.status(200).json({
        success: true,
        ignored: true,
        status: transaction.status
      });
    }

    const updatedTransaction = await updatePaymentStatus({
      providerReference: transaction.provider_reference,
      status: mappedStatus
    });

    if (!updatedTransaction) {
      throw new Error('Unable to update payment status');
    }

    if (updatedTransaction.status === 'paid') {
      await activateSubscriptionForPayment(updatedTransaction);
    }

    console.log('SPLASHPAY WEBHOOK PROCESSED:', {
      reference: transaction.reference,
      providerReference: transaction.provider_reference,
      status: updatedTransaction.status
    });

    return res.status(200).json({
      success: true,
      status: updatedTransaction.status
    });
  } catch (error) {
    console.error('SPLASHPAY WEBHOOK ERROR:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to process SplashPay webhook'
    });
  }
});

app.post('/api/payments/mock/callback', async (req, res) => {
  try {
    const { providerReference, status } = req.body;

    if (!providerReference || !status) {
      return res.status(400).json({
        success: false,
        error: 'providerReference and status are required'
      });
    }

    if (!callbackStatuses.has(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid callback status'
      });
    }

    const transaction = await findPaymentTransactionByProviderReference(
      providerReference
    );

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Payment transaction was not found'
      });
    }

    if (transaction.status !== 'pending') {
      if (transaction.status === 'paid') {
        try {
          await activateSubscriptionForPayment(transaction);
        } catch (error) {
          console.error('PAYMENT PROVISIONING RETRY ERROR:', error);
        }
      }

      return res.json({
        success: true,
        transaction: {
          reference: transaction.reference,
          status: transaction.status,
          paidAt: transaction.paid_at
        },
        ignored: true
      });
    }

    const updatedTransaction = await updatePaymentStatus({
      providerReference,
      status
    });

    if (updatedTransaction.status === 'paid') {
      try {
        await activateSubscriptionForPayment(updatedTransaction);
      } catch (error) {
        console.error('PAYMENT PROVISIONING ERROR:', error);
      }
    }

    res.json({
      success: true,
      transaction: {
        reference: updatedTransaction.reference,
        status: updatedTransaction.status,
        paidAt: updatedTransaction.paid_at
      }
    });
  } catch (error) {
    console.error('MOCK PAYMENT CALLBACK ERROR:', error);

    res.status(500).json({
      success: false,
      error: 'Unable to process payment callback'
    });
  }
});

app.post('/api/internal/payments/:reference/provision', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({
      success: false,
      error: 'Not found'
    });
  }

  try {
    const transaction = await findPaymentTransactionByReference(
      req.params.reference
    );

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Payment transaction was not found'
      });
    }

    if (transaction.status !== 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Payment transaction is not paid'
      });
    }

    const result = await activateSubscriptionForPayment(transaction);

    res.json({
      success: true,
      subscription: {
        id: result.subscription.id,
        status: result.subscription.status,
        startsAt: result.subscription.starts_at,
        expiresAt: result.subscription.expires_at
      }
    });
  } catch (error) {
    console.error('INTERNAL PROVISIONING ERROR:', error);

    res.status(500).json({
      success: false,
      error: 'Unable to provision payment'
    });
  }
});

app.post('/devices', async (req, res) => {
  try {
    const { macAddress } = req.body;

    const device = await getOrCreateDevice(macAddress);

    res.json({
      success: true,
      device
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});


app.get('/devices/:mac/access', async (req, res) => {
  try {
    const device = await getOrCreateDevice(req.params.mac);

    const access = await getDeviceAccessStatus(device.id);

    res.json({
      success: true,
      device: {
        id: device.id,
        macAddress: device.mac_address
      },
      access
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/test/activate', async (req, res) => {
  try {
    const { macAddress, packageId } = req.body;

    const device = await getOrCreateDevice(macAddress);

    const subscription = await activatePackageForDevice({
      deviceId: device.id,
      packageId
    });

    res.json({
      success: true,
      device: {
        id: device.id,
        macAddress: device.mac_address
      },
      subscription
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});


module.exports = app;
