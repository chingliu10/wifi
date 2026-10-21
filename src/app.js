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
  findRecentReusablePayment,
  findLatestCustomerByDeviceId,
  updatePaymentPortalContext,
  updatePaymentProviderDetails,
  updatePaymentStatus
} = require('./repositories/payment-transaction-repository');
const {
  findSubscriptionByPaymentTransactionId,
  findActiveSubscriptionByDeviceAndSite
} = require('./repositories/subscription-repository');
const {
  findPayoutByReference,
  findPayoutByProviderReference,
  updatePayoutProviderState,
  completePayout,
  failPayout
} = require('./repositories/payout-repository');
const { initiatePayment, checkPaymentStatus } = require('./services/payments/payment-service');
const {
  activateSubscriptionForPayment
} = require('./services/subscriptions/subscription-service');
const omadaPortal = require('./services/omada/external-portal-client');
const adminRouter = require('./routes/admin');
const { translate } = require('./i18n/admin');
const {
  redeemVoucher
} = require('./services/vouchers/voucher-service');

const app = express();
const devRoutesEnabled = process.env.ALLOW_DEV_ROUTES === 'true';

const callbackStatuses = new Set(['paid', 'failed', 'cancelled']);

const normalizeCustomerName = (value) =>
  String(value || '').trim().replace(/\s+/g, ' ');

const isValidCustomerName = (value) => {
  const name = normalizeCustomerName(value);

  return (
    name.length >= 2 &&
    name.length <= 40 &&
    /^[A-Za-z][A-Za-z' -]*$/.test(name)
  );
};

const voucherPortalErrorMessage = (error) => {
  const messages = {
    VOUCHER_INVALID: 'Vocha hii si sahihi. Hakikisha umeandika code vizuri.',
    VOUCHER_EXPIRED: 'Vocha hii imeisha muda wa kutumika.',
    VOUCHER_CANCELLED: 'Vocha hii imefutwa na haiwezi kutumika.',
    VOUCHER_ALREADY_USED: 'Vocha hii tayari imetumika.',
    VOUCHER_UNAVAILABLE: 'Vocha hii haipatikani kwa matumizi.'
  };

  return (
    messages[error?.code] ||
    'Imeshindikana kutumia vocha hii. Tafadhali jaribu tena.'
  );
};


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

  if (rawStatus === 'expired' || event.endsWith('.expired')) {
    return 'expired';
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

const mapSplashPayPayoutStatus = (payload) => {
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

  if (
    rawStatus === 'processing' ||
    event.endsWith('.processing')
  ) {
    return 'processing';
  }

  if (
    rawStatus === 'pending' ||
    event.endsWith('.pending')
  ) {
    return 'pending';
  }

  if (
    rawStatus === 'failed' ||
    event.endsWith('.failed')
  ) {
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

const processSplashPayDisbursementWebhook = async (payload) => {
  const data = payload.data || payload;
  const reference =
    data.reference ||
    payload.reference ||
    null;
  const providerReference =
    data.provider_reference ||
    data.providerReference ||
    payload.provider_reference ||
    payload.providerReference ||
    null;

  if (!reference && !providerReference) {
    const error = new Error(
      'Webhook does not contain a disbursement reference'
    );
    error.statusCode = 400;
    throw error;
  }

  let payout = null;

  if (reference) {
    payout = await findPayoutByReference(reference);
  }

  if (!payout && providerReference) {
    payout = await findPayoutByProviderReference(providerReference);
  }

  if (!payout) {
    const error = new Error('Payout transaction was not found');
    error.statusCode = 404;
    throw error;
  }

  if (reference && reference !== payout.reference) {
    const error = new Error('Disbursement merchant reference mismatch');
    error.statusCode = 400;
    throw error;
  }

  if (
    data.currency &&
    String(data.currency).toUpperCase() !== 'TZS'
  ) {
    const error = new Error('Disbursement currency mismatch');
    error.statusCode = 400;
    throw error;
  }

  if (
    data.amount !== undefined &&
    Number(data.amount) !== Number(payout.amount_tzs)
  ) {
    const error = new Error('Disbursement amount mismatch');
    error.statusCode = 400;
    throw error;
  }

  const mappedStatus = mapSplashPayPayoutStatus(payload);

  if (
    payout.status === 'paid' &&
    mappedStatus &&
    mappedStatus !== 'paid'
  ) {
    return {
      ignored: true,
      reference: payout.reference,
      status: payout.status
    };
  }

  if (
    ['failed', 'cancelled'].includes(payout.status) &&
    ['pending', 'processing'].includes(mappedStatus)
  ) {
    return {
      ignored: true,
      reference: payout.reference,
      status: payout.status
    };
  }

  if (!mappedStatus) {
    return {
      ignored: true,
      reference: payout.reference,
      status: payout.status
    };
  }

  const feeTzs =
    data.fee !== undefined && data.fee !== null
      ? Number(data.fee)
      : null;
  const totalAmountTzs =
    data.total_amount !== undefined && data.total_amount !== null
      ? Number(data.total_amount)
      : data.totalAmount !== undefined && data.totalAmount !== null
        ? Number(data.totalAmount)
        : null;

  if (mappedStatus === 'paid') {
    const completed = await completePayout({
      reference: payout.reference,
      providerReference,
      amountTzs:
        data.amount !== undefined
          ? Number(data.amount)
          : Number(payout.amount_tzs),
      feeTzs,
      totalAmountTzs
    });

    return {
      ignored: false,
      reference: completed.reference,
      status: completed.status
    };
  }

  if (
    mappedStatus === 'failed' ||
    mappedStatus === 'cancelled'
  ) {
    const failed = await failPayout({
      reference: payout.reference,
      status: mappedStatus,
      code:
        data.code ||
        payload.code ||
        null,
      message:
        data.message ||
        payload.message ||
        null
    });

    return {
      ignored: false,
      reference: failed?.reference || payout.reference,
      status: failed?.status || mappedStatus
    };
  }

  const updated = await updatePayoutProviderState({
    reference: payout.reference,
    providerReference,
    feeTzs,
    totalAmountTzs,
    status: mappedStatus
  });

  return {
    ignored: false,
    reference: updated?.reference || payout.reference,
    status: updated?.status || mappedStatus
  };
};



const resolvePortalSite = async ({ externalSiteId, apMac }) => {
  const normalizedApMac = normalizeMacAddress(apMac);

  if (externalSiteId || normalizedApMac) {
    const result = await pool.query(
      `
        SELECT DISTINCT
          s.id,
          s.organization_id,
          s.name,
          s.slug,
          COALESCE(s.brand_name, s.name || ' WiFi') AS brand_name,
          s.support_phone,
          s.primary_color,
          s.external_portal_site_id,
          o.vouchers_enabled,
          o.voucher_portal_enabled
        FROM sites s
        JOIN organizations o ON o.id = s.organization_id
        LEFT JOIN network_devices nd ON nd.site_id = s.id
        WHERE s.active = true
          AND o.active = true
          AND ($1::text IS NULL OR s.external_portal_site_id = $1)
          AND ($2::text IS NULL OR nd.ap_mac = $2)
        LIMIT 1
      `,
      [externalSiteId || null, normalizedApMac || null]
    );

    if (result.rows[0]) {
      return result.rows[0];
    }
  }

  return null;
};

const bindOmadaSetup = async ({
  portalKey,
  externalSiteId,
  apMac,
  ssidName
}) => {
  const normalizedApMac = normalizeMacAddress(apMac);

  if (!portalKey || !externalSiteId || !normalizedApMac) {
    throw new Error('Omada setup redirect is missing site or AP identity');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const siteResult = await client.query(
      `
        SELECT
          s.id,
          s.organization_id,
          s.name,
          s.external_portal_site_id
        FROM sites s
        JOIN organizations o ON o.id = s.organization_id
        WHERE s.portal_key = $1
          AND s.active = TRUE
          AND o.active = TRUE
        LIMIT 1
        FOR UPDATE OF s
      `,
      [portalKey]
    );

    const siteConfig = siteResult.rows[0];

    if (!siteConfig) {
      throw new Error('This Solidus WiFi setup link is invalid');
    }

    if (
      siteConfig.external_portal_site_id &&
      siteConfig.external_portal_site_id !== externalSiteId
    ) {
      throw new Error('This setup link is already connected to another Omada site');
    }

    const duplicateSite = await client.query(
      `
        SELECT id
        FROM sites
        WHERE external_portal_site_id = $1
          AND id <> $2
        LIMIT 1
      `,
      [externalSiteId, siteConfig.id]
    );

    if (duplicateSite.rows[0]) {
      throw new Error('This Omada site is already assigned to another Solidus site');
    }

    await client.query(
      `
        UPDATE sites
        SET
          external_portal_site_id = COALESCE(external_portal_site_id, $2),
          portal_connected_at = COALESCE(portal_connected_at, NOW()),
          last_portal_seen_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [siteConfig.id, externalSiteId]
    );

    const existingDevice = await client.query(
      `
        SELECT id, site_id
        FROM network_devices
        WHERE ap_mac = $1
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedApMac]
    );

    const existing = existingDevice.rows[0];
    const safeSsid = String(ssidName || '').trim().slice(0, 150) || null;

    if (existing && Number(existing.site_id) !== Number(siteConfig.id)) {
      throw new Error('This access point is already assigned to another Solidus site');
    }

    if (existing) {
      await client.query(
        `
          UPDATE network_devices
          SET
            ssid_name = COALESCE($2, ssid_name),
            last_seen_at = NOW(),
            active = TRUE,
            updated_at = NOW()
          WHERE id = $1
        `,
        [existing.id, safeSsid]
      );
    } else {
      const suffix = normalizedApMac.replace(/:/g, '').slice(-6);

      await client.query(
        `
          INSERT INTO network_devices (
            site_id,
            name,
            nas_identifier,
            brand,
            model,
            ap_mac,
            device_type,
            ssid_name,
            last_seen_at,
            active
          )
          VALUES (
            $1,
            $2,
            $3,
            'TP-Link Omada',
            NULL,
            $4,
            'omada',
            $5,
            NOW(),
            TRUE
          )
        `,
        [
          siteConfig.id,
          safeSsid ? `${safeSsid} AP` : `Omada AP ${suffix}`,
          `omada-${normalizedApMac.replace(/:/g, '').toLowerCase()}`,
          normalizedApMac,
          safeSsid
        ]
      );
    }

    await client.query('COMMIT');

    return {
      ...siteConfig,
      external_portal_site_id: externalSiteId,
      ap_mac: normalizedApMac,
      ssid_name: safeSsid
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const buildPackageView = (transaction) => ({
  id: transaction.package_id,
  name: transaction.package_name,
  price_tzs: transaction.package_price_tzs,
  duration_seconds: transaction.package_duration_seconds
});

const buildPaymentMessage = (transaction, subscription) => {
  if (
    transaction.status === 'paid' &&
    subscription &&
    subscription.status === 'active' &&
    transaction.omada_portal_authorized_at
  ) {
    return 'Malipo yamefanikiwa. Internet imewashwa.';
  }

  if (transaction.status === 'paid') {
    return 'Malipo yamepokelewa. Tunaandaa internet yako.';
  }

  if (transaction.status === 'pending' && transaction.provider_reference) {
    return 'Ombi la malipo limetumwa. Tafadhali thibitisha kwenye simu yako.';
  }

  if (transaction.status === 'pending') {
    return 'Ombi la malipo liko tayari';
  }

  if (transaction.status === 'failed') {
    return 'Malipo hayajakamilika. Tafadhali jaribu tena.';
  }

  if (transaction.status === 'cancelled') {
    return 'Malipo yamekatishwa.';
  }

  if (transaction.status === 'expired') {
    return 'Ombi la malipo limeisha muda.';
  }

  return 'Hali ya malipo haipatikani kwa sasa.';
};

const reconcileSplashPayPayment = async (transaction) => {
  if (
    !transaction ||
    transaction.provider !== 'splashpay' ||
    !transaction.provider_reference
  ) {
    return transaction;
  }

  if (transaction.status === 'paid') {
    try {
      await activateSubscriptionForPayment(transaction);
    } catch (error) {
      console.error('SPLASHPAY STATUS PROVISIONING RETRY ERROR:', error);
    }

    return findPaymentTransactionByReference(transaction.reference);
  }

  if (transaction.status !== 'pending') {
    return transaction;
  }

  const providerStatus = await checkPaymentStatus({
    reference: transaction.reference
  });

  if (
    providerStatus.reference &&
    providerStatus.reference !== transaction.reference
  ) {
    throw new Error('SplashPay status merchant reference mismatch');
  }

  if (
    providerStatus.providerReference &&
    transaction.provider_reference &&
    providerStatus.providerReference !== transaction.provider_reference
  ) {
    console.log('SPLASHPAY PROVIDER REFERENCE CHANGED:', {
      reference: transaction.reference,
      initiatedProviderReference: transaction.provider_reference,
      currentProviderReference: providerStatus.providerReference
    });
  }

  if (
    providerStatus.currency &&
    String(providerStatus.currency).toUpperCase() !== 'TZS'
  ) {
    throw new Error('SplashPay status currency mismatch');
  }

  if (
    providerStatus.amountTzs !== null &&
    Number(providerStatus.amountTzs) !== Number(transaction.amount_tzs)
  ) {
    throw new Error('SplashPay status amount mismatch');
  }

  const mappedStatus = mapSplashPayStatus({
    status: providerStatus.status
  });

  if (!mappedStatus) {
    return transaction;
  }

  const updatedTransaction = await updatePaymentStatus({
    providerReference: transaction.provider_reference,
    status: mappedStatus
  });

  const currentTransaction =
    updatedTransaction ||
    await findPaymentTransactionByReference(transaction.reference);

  if (currentTransaction.status === 'paid') {
    await activateSubscriptionForPayment(currentTransaction);
  }

  return findPaymentTransactionByReference(transaction.reference);
};

const loadSubscriptionForTransaction = async (transaction) => {
  return findSubscriptionByPaymentTransactionId({
    paymentTransactionId: transaction.id
  });
};

const renderPaymentStatus = async (res, transaction, title = 'Payment status') => {
  const subscription = await loadSubscriptionForTransaction(transaction);
  const subscriptionActive = Boolean(
    subscription &&
    subscription.status === 'active' &&
    new Date(subscription.expires_at).getTime() > Date.now()
  );

  const paymentActive = Boolean(
    transaction.status === 'paid' &&
    subscriptionActive &&
    transaction.omada_portal_authorized_at
  );

  return res.render('portal/confirm', {
    title,
    transaction,
    package: buildPackageView(transaction),
    siteConfig: {
      brand_name: transaction.site_brand_name || 'WiFi',
      support_phone: transaction.site_support_phone || '',
      primary_color: transaction.site_primary_color || '#07633f'
    },
    subscription,
    message: buildPaymentMessage(transaction, subscription),
    paymentActive,
    paymentPaid: transaction.status === 'paid',
    paymentConnecting:
      transaction.status === 'paid' && subscriptionActive && !paymentActive,
    showPayNow: transaction.status === 'pending' && !transaction.provider_reference,
    paymentInitiated: transaction.status === 'pending' && Boolean(transaction.provider_reference)
  });
};

app.engine('hbs', engine({
  extname: '.hbs',
  defaultLayout: 'main',
  helpers: {
    formatTzs: (amount) => {
      const value = Number(amount);

      if (!Number.isFinite(value)) {
        return '0';
      }

      const hasDecimals = Math.abs(value % 1) > 0.000001;

      return value.toLocaleString('en-US', {
        minimumFractionDigits: hasDecimals ? 2 : 0,
        maximumFractionDigits: 2
      });
    },
    formatDuration: (seconds) => {
      const value = Number(seconds);

      if (!Number.isFinite(value) || value <= 0) {
        return '—';
      }

      if (value % 86400 === 0) {
        const days = value / 86400;
        return days === 1 ? '1 day' : `${days} days`;
      }

      if (value % 3600 === 0) {
        const hours = value / 3600;
        return hours === 1 ? '1 hour' : `${hours} hours`;
      }

      if (value % 60 === 0) {
        const minutes = value / 60;
        return minutes === 1 ? '1 minute' : `${minutes} minutes`;
      }

      return `${value} sec`;
    },
    formatPackageName: (name) => {
      const labels = {
        '7 Hours': 'Masaa 7',
        '24 Hours': 'Masaa 24',
        '30 Days': 'Siku 30'
      };

      return labels[name] || name;
    },
    formatDate: (value) => {
      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return '—';
      }

      return new Intl.DateTimeFormat('en-TZ', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Dar_es_Salaam'
      }).format(date);
    },
    json: (value) => JSON.stringify(value),
    t: (key, options) => {
      const language = options?.data?.root?.language || 'en';
      return translate(language, key);
    },
    statusLabel: (status, options) => {
      const language = options?.data?.root?.language || 'en';
      return translate(language, 'status.' + String(status || '').toLowerCase());
    },
    durationUnitLabel: (unit, options) => {
      const language = options?.data?.root?.language || 'en';
      const key = {
        minutes: 'common.minutes',
        hours: 'common.hours',
        days: 'common.days'
      }[String(unit || '').toLowerCase()];

      return key ? translate(language, key) : String(unit || '');
    }
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
app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  res.redirect(302, '/admin');
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
        AND deleted_at IS NULL
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

app.get('/portal/setup/:portalKey', async (req, res) => {
  console.log('OMADA SETUP QUERY:', req.query);

  try {
    const {
      clientMac,
      clientIp,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.query;

    await bindOmadaSetup({
      portalKey: req.params.portalKey,
      externalSiteId: String(site || '').trim(),
      apMac,
      ssidName
    });

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries({
      clientMac,
      clientIp,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    })) {
      if (value !== undefined && value !== null && String(value).length > 0) {
        params.set(key, String(value));
      }
    }

    return res.redirect(302, `/portal?${params.toString()}`);
  } catch (error) {
    console.error('OMADA AUTO ONBOARDING ERROR:', error);

    return res.status(400).send(
      'This WiFi site could not be connected to Solidus WiFi. Please contact the site administrator.'
    );
  }
});

app.get('/portal', async (req, res) => {
  console.log('PORTAL QUERY:', req.query);

  try {
    const {
      clientMac,
      clientIp,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.query;

    const siteConfig = await resolvePortalSite({
      externalSiteId: site,
      apMac
    });

    if (!siteConfig) {
      throw new Error('No active WiFi site is configured');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          name,
          price_tzs,
          duration_seconds
        FROM packages
        WHERE site_id = $1
          AND active = true
          AND deleted_at IS NULL
        ORDER BY sort_order
      `,
      [siteConfig.id]
    );

    const portalContext = {
      site,
      clientIp,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    };

    if (!clientMac) {
      return res.status(400).render('portal/index', {
        title: siteConfig.brand_name,
        packages: result.rows,
        siteConfig,
        portal: portalContext,
        error: 'Imeshindikana kutambua kifaa chako. Tafadhali unganisha tena kwenye WiFi kisha ujaribu tena.'
      });
    }

    const device = await getOrCreateDevice(clientMac);
    const activeSubscription = await findActiveSubscriptionByDeviceAndSite({
      deviceId: device.id,
      siteId: siteConfig.id
    });

    /*
     * Omada MAC-Based Authentication is intentionally not used for paid
     * session lifetime enforcement. On the tested controller/AP combination,
     * a successful MAC Auth Access-Accept creates an approximately 100-year
     * Omada authorization and ignores the RADIUS Session-Timeout.
     *
     * When a previously-paid client is redirected back to this portal, reuse
     * the still-active subscription and authorize the current captive session
     * through External Portal Server for only the remaining subscription time.
     */
    if (activeSubscription) {
      const remainingMs = Math.max(
        0,
        new Date(activeSubscription.expires_at).getTime() - Date.now()
      );
      const hasPortalContext =
        Boolean(String(clientIp || '').trim()) &&
        Boolean(String(apMac || '').trim()) &&
        Boolean(String(ssidName || '').trim()) &&
        radioId !== undefined &&
        radioId !== null &&
        String(radioId).trim() !== '';

      if (remainingMs > 0 && hasPortalContext) {
        try {
          await omadaPortal.authorizeExternalPortalClient({
            clientMac,
            clientIp,
            apMac,
            ssidName,
            radioId,
            durationMs: remainingMs,
            originUrl: redirectUrl || ''
          });

          console.log('OMADA ACTIVE SUBSCRIPTION REAUTHORIZED:', {
            siteId: siteConfig.id,
            clientMac: normalizeMacAddress(clientMac),
            subscriptionId: activeSubscription.id,
            remainingMs
          });

          return res.render('portal/confirm', {
            title: 'Umeunganishwa',
            siteConfig,
            package: {
              name: activeSubscription.package_name
            },
            subscription: activeSubscription,
            paymentActive: true,
            paymentPaid: true
          });
        } catch (error) {
          console.error('OMADA ACTIVE SUBSCRIPTION REAUTH ERROR:', {
            siteId: siteConfig.id,
            clientMac: normalizeMacAddress(clientMac),
            subscriptionId: activeSubscription.id,
            error: error.message
          });

          return res.status(503).render('portal/index', {
            title: siteConfig.brand_name,
            packages: [],
            device,
            siteConfig,
            portal: {
              ...portalContext,
              clientMac
            },
            error:
              'Kifurushi chako bado kina muda, lakini tumeshindwa kukuunganisha tena. Zima Wi-Fi, washa tena, kisha ujaribu.'
          });
        }
      }

      return res.status(400).render('portal/index', {
        title: siteConfig.brand_name,
        packages: [],
        device,
        siteConfig,
        portal: {
          ...portalContext,
          clientMac
        },
        error:
          'Kifurushi chako bado kina muda, lakini taarifa za kuunganisha WiFi hazijakamilika. Unganisha tena kwenye WiFi.'
      });
    }

    const savedCustomer = await findLatestCustomerByDeviceId(device.id);

    res.render('portal/index', {
      title: siteConfig.brand_name,
      packages: result.rows,
      device,
      savedCustomer,
      siteConfig,
      portal: {
        ...portalContext,
        clientMac
      }
    });
  } catch (error) {
    console.error('PORTAL ERROR:', error);

    res.status(500).render('portal/index', {
      title: 'WiFi',
      packages: [],
      siteConfig: {
        brand_name: 'WiFi',
        support_phone: '',
        primary_color: '#07633f'
      },
      error: 'Mtandao huu bado haujasanidiwa vizuri. Tafadhali wasiliana na msimamizi.'
    });
  }
});

app.post('/portal/voucher', async (req, res) => {
  try {
    const {
      voucherCode,
      clientMac,
      clientIp,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.body;

    const normalizedClientMac = normalizeMacAddress(clientMac);

    if (!normalizedClientMac) {
      return res.status(400).render('portal/confirm', {
        title: 'Vocha',
        error:
          'Imeshindikana kutambua kifaa chako. Tafadhali unganisha tena kwenye WiFi.'
      });
    }

    const siteConfig = await resolvePortalSite({
      externalSiteId: site,
      apMac
    });

    if (!siteConfig) {
      return res.status(400).render('portal/confirm', {
        title: 'Vocha',
        error: 'Mtandao huu haujasanidiwa bado.'
      });
    }

    if (
      !siteConfig.vouchers_enabled ||
      !siteConfig.voucher_portal_enabled
    ) {
      return res.status(404).render('portal/confirm', {
        title: 'Vocha',
        error: 'Matumizi ya vocha hayajawashwa kwenye mtandao huu.'
      });
    }

    const hasPortalContext =
      Boolean(String(clientIp || '').trim()) &&
      Boolean(String(apMac || '').trim()) &&
      Boolean(String(ssidName || '').trim()) &&
      radioId !== undefined &&
      radioId !== null &&
      String(radioId).trim() !== '';

    if (!hasPortalContext) {
      return res.status(400).render('portal/confirm', {
        title: 'Vocha',
        siteConfig,
        error:
          'Taarifa za kuunganisha WiFi hazijakamilika. Unganisha tena kwenye WiFi kisha ujaribu.'
      });
    }

    const device = await getOrCreateDevice(normalizedClientMac);

    let redeemed;

    try {
      redeemed = await redeemVoucher({
        organizationId: siteConfig.organization_id,
        siteId: siteConfig.id,
        deviceId: device.id,
        clientMac: normalizedClientMac,
        code: voucherCode
      });
    } catch (error) {
      const packagesResult = await pool.query(
        `
          SELECT
            id,
            name,
            price_tzs,
            duration_seconds
          FROM packages
          WHERE site_id = $1
            AND active = TRUE
            AND deleted_at IS NULL
          ORDER BY sort_order
        `,
        [siteConfig.id]
      );

      const savedCustomer = await findLatestCustomerByDeviceId(device.id);

      return res.status(error.statusCode || 400).render('portal/index', {
        title: siteConfig.brand_name,
        packages: packagesResult.rows,
        device,
        savedCustomer,
        siteConfig,
        portal: {
          site,
          clientIp,
          apMac,
          ssidName,
          redirectUrl,
          radioId,
          clientMac: normalizedClientMac
        },
        voucherError: voucherPortalErrorMessage(error),
        voucherCode: String(voucherCode || '').trim()
      });
    }

    const remainingMs = Math.max(
      0,
      new Date(redeemed.subscription.expires_at).getTime() - Date.now()
    );

    if (remainingMs <= 0) {
      return res.status(409).render('portal/confirm', {
        title: 'Vocha',
        siteConfig,
        error: 'Muda wa vocha hii umeisha.'
      });
    }

    try {
      await omadaPortal.authorizeExternalPortalClient({
        clientMac: normalizedClientMac,
        clientIp,
        apMac,
        ssidName,
        radioId,
        durationMs: remainingMs,
        originUrl: redirectUrl || ''
      });
    } catch (error) {
      console.error('OMADA VOUCHER AUTH ERROR:', {
        siteId: siteConfig.id,
        clientMac: normalizedClientMac,
        subscriptionId: redeemed.subscription.id,
        error: error.message
      });

      return res.status(503).render('portal/confirm', {
        title: 'Vocha imekubaliwa',
        siteConfig,
        package: {
          name: redeemed.packageName
        },
        subscription: redeemed.subscription,
        error:
          'Vocha imekubaliwa na muda wako umehifadhiwa, lakini hatukuweza kuwasha internet sasa. Zima WiFi, washa tena, kisha fungua portal.'
      });
    }

    console.log('OMADA VOUCHER AUTHORIZED:', {
      siteId: siteConfig.id,
      clientMac: normalizedClientMac,
      subscriptionId: redeemed.subscription.id,
      voucherId: redeemed.voucher.id,
      reused: redeemed.reused,
      remainingMs
    });

    return res.render('portal/confirm', {
      title: 'Umeunganishwa',
      siteConfig,
      package: {
        name: redeemed.packageName
      },
      subscription: redeemed.subscription,
      paymentActive: true,
      paymentPaid: true,
      voucherActive: true
    });
  } catch (error) {
    console.error('PORTAL VOUCHER ERROR:', error);

    return res.status(500).render('portal/confirm', {
      title: 'Vocha',
      error: 'Imeshindikana kutumia vocha. Tafadhali jaribu tena.'
    });
  }
});

app.post('/portal/pay', async (req, res) => {
  let paymentLockClient = null;
  let paymentLockKey = null;

  try {
    const {
      customerName,
      phone,
      packageId,
      deviceId,
      clientMac,
      clientIp,
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.body;

    if (
      !customerName ||
      !phone ||
      !packageId ||
      !clientMac ||
      !clientIp ||
      !deviceId
    ) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Tafadhali weka jina, namba ya simu na uchague kifurushi.'
      });
    }

    const normalizedCustomerName = normalizeCustomerName(customerName);

    if (!isValidCustomerName(normalizedCustomerName)) {
      return res.status(400).render('portal/confirm', {
        title: 'Malipo',
        error: 'Weka jina sahihi la kwanza.'
      });
    }

    const normalizedPhoneInput = String(phone).trim();

    if (!/^0[67][0-9]{8}$/.test(normalizedPhoneInput)) {
      return res.status(400).render('portal/confirm', {
        title: 'Malipo',
        error: 'Weka namba sahihi ya simu. Mfano: 0655100259'
      });
    }

    const normalizedClientMac = normalizeMacAddress(clientMac);

    if (!normalizedClientMac) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Imeshindikana kutambua kifaa chako. Tafadhali unganisha tena kwenye WiFi.'
      });
    }

    const siteConfig = await resolvePortalSite({
      externalSiteId: site,
      apMac
    });

    if (!siteConfig) {
      return res.status(400).render('portal/confirm', {
        title: 'Malipo',
        error: 'Mtandao huu haujasanidiwa bado.'
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
          AND site_id = $2
          AND active = true
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [packageId, siteConfig.id]
    );

    const packageData = result.rows[0];

    if (!packageData) {
      return res.status(400).render('portal/confirm', {
        title: 'Payment request',
        error: 'Kifurushi ulichochagua hakipatikani kwa sasa.'
      });
    }

    /*
     * Captive-portal browsers can submit the same form more than once.
     * Serialize identical attempts across all Node instances with a
     * PostgreSQL advisory lock, then reuse the same merchant reference.
     * SplashPay also receives that same reference as its Idempotency-Key.
     */
    paymentLockKey = [
      'portal-pay',
      deviceId,
      packageData.id,
      normalizedPhoneInput,
      normalizedClientMac,
      packageData.price_tzs
    ].join(':');

    paymentLockClient = await pool.connect();
    await paymentLockClient.query(
      'SELECT pg_advisory_lock(hashtext($1))',
      [paymentLockKey]
    );

    let transaction = await findRecentReusablePayment({
      deviceId,
      packageId: packageData.id,
      phone: normalizedPhoneInput,
      clientMac: normalizedClientMac,
      amountTzs: packageData.price_tzs,
      windowSeconds: Number(process.env.PAYMENT_DEDUP_WINDOW_SECONDS || 120)
    });

    if (transaction) {
      await updatePaymentPortalContext({
        reference: transaction.reference,
        clientIp: String(clientIp).trim(),
        site,
        apMac,
        ssidName,
        redirectUrl,
        radioId
      });

      transaction = await findPaymentTransactionByReference(
        transaction.reference
      );

      console.log('PORTAL PAYMENT REUSED:', {
        reference: transaction.reference,
        status: transaction.status,
        providerReference: transaction.provider_reference || null,
        deviceId,
        packageId: packageData.id
      });

      if (transaction.status === 'paid') {
        try {
          await activateSubscriptionForPayment(transaction);
        } catch (error) {
          console.error('PORTAL PAYMENT PROVISIONING RETRY ERROR:', error);
        }

        transaction = await findPaymentTransactionByReference(
          transaction.reference
        );

        return await renderPaymentStatus(
          res,
          transaction,
          'Malipo yamefanikiwa'
        );
      }

      if (transaction.provider_reference) {
        return await renderPaymentStatus(
          res,
          transaction,
          'Angalia simu yako'
        );
      }
    } else {
      const reference = generatePaymentReference();

      await createPaymentTransaction({
        reference,
        customerName: normalizedCustomerName,
        phone: normalizedPhoneInput,
        packageId: packageData.id,
        clientMac: normalizedClientMac,
        clientIp: String(clientIp).trim(),
        deviceId,
        amountTzs: packageData.price_tzs,
        status: 'pending',
        site,
        apMac,
        ssidName,
        redirectUrl,
        radioId
      });

      transaction = await findPaymentTransactionByReference(reference);
    }

    /*
     * A reused pending transaction with no provider reference is retried
     * with the SAME merchant reference. This prevents a second charge even
     * if the first HTTP response was lost after SplashPay accepted it.
     */
    const providerResult = await initiatePayment({
      transaction,
      packageData
    });

    await updatePaymentProviderDetails({
      reference: transaction.reference,
      provider: providerResult.provider,
      providerReference: providerResult.providerReference,
      gatewayFeeTzs: providerResult.gatewayFeeTzs,
      netAmountTzs: providerResult.netAmountTzs
    });

    const currentTransaction = await findPaymentTransactionByReference(
      transaction.reference
    );

    return await renderPaymentStatus(
      res,
      currentTransaction,
      'Angalia simu yako'
    );
  } catch (error) {
    console.error('PORTAL PAY ERROR:', error);

    return res.status(500).render('portal/confirm', {
      title: 'Payment request',
      error: 'Imeshindikana kuandaa malipo. Tafadhali jaribu tena.'
    });
  } finally {
    if (paymentLockClient) {
      if (paymentLockKey) {
        try {
          await paymentLockClient.query(
            'SELECT pg_advisory_unlock(hashtext($1))',
            [paymentLockKey]
          );
        } catch (error) {
          console.error('PORTAL PAYMENT LOCK RELEASE ERROR:', error);
        }
      }

      paymentLockClient.release();
    }
  }
});

app.get('/portal/payment/:reference', async (req, res) => {
  try {
    let transaction = await findPaymentTransactionByReference(
      req.params.reference
    );

    if (!transaction) {
      return res.status(404).render('portal/confirm', {
        title: 'Malipo hayajapatikana',
        error: 'Muamala wa malipo haujapatikana.'
      });
    }

    if (
      transaction.provider === 'splashpay' &&
      transaction.provider_reference
    ) {
      transaction = await reconcileSplashPayPayment(transaction);
    }

    return await renderPaymentStatus(res, transaction);
  } catch (error) {
    console.error('PORTAL PAYMENT LOOKUP ERROR:', error);

    res.status(500).render('portal/confirm', {
      title: 'Hali ya malipo',
      error: 'Imeshindikana kuangalia hali ya malipo. Tafadhali jaribu tena.'
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
        title: 'Malipo hayajapatikana',
        error: 'Muamala wa malipo haujapatikana.'
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
      providerReference: providerResult.providerReference,
      gatewayFeeTzs: providerResult.gatewayFeeTzs,
      netAmountTzs: providerResult.netAmountTzs
    });

    const currentTransaction = updatedTransaction
      ? await findPaymentTransactionByReference(transaction.reference)
      : await findPaymentTransactionByReference(transaction.reference);

    return await renderPaymentStatus(res, currentTransaction);
  } catch (error) {
    console.error('PORTAL PAYMENT INITIATE ERROR:', error);

    res.status(500).render('portal/confirm', {
      title: 'Hali ya malipo',
      error: 'Imeshindikana kutuma ombi la malipo. Tafadhali jaribu tena.'
    });
  }
});



app.get('/api/payments/:reference/status', async (req, res) => {
  try {
    let transaction = await findPaymentTransactionByReference(
      req.params.reference
    );

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Payment transaction was not found'
      });
    }

    if (
      transaction.provider === 'splashpay' &&
      transaction.provider_reference
    ) {
      transaction = await reconcileSplashPayPayment(transaction);
    }

    const subscription = await loadSubscriptionForTransaction(transaction);

    return res.json({
      success: true,
      reference: transaction.reference,
      status: transaction.status,
      provisioningStatus: transaction.provisioning_status,
      accessActive: Boolean(
        subscription &&
        subscription.status === 'active' &&
        new Date(subscription.expires_at).getTime() > Date.now() &&
        transaction.omada_portal_authorized_at
      )
    });
  } catch (error) {
    console.error('PAYMENT STATUS CHECK ERROR:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to check payment status'
    });
  }
});


app.post('/api/disbursements/splashpay/webhook', async (req, res) => {
  try {
    if (!verifySplashPayWebhook(req)) {
      console.warn('SPLASHPAY DISBURSEMENT WEBHOOK REJECTED: invalid signature');
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature'
      });
    }

    const result = await processSplashPayDisbursementWebhook(
      req.body || {}
    );

    console.log('SPLASHPAY DISBURSEMENT WEBHOOK PROCESSED:', result);

    return res.status(200).json({
      success: true,
      ignored: result.ignored,
      reference: result.reference,
      status: result.status
    });
  } catch (error) {
    console.error('SPLASHPAY DISBURSEMENT WEBHOOK ERROR:', error);

    return res.status(error.statusCode || 500).json({
      success: false,
      error:
        error.statusCode && error.statusCode < 500
          ? error.message
          : 'Unable to process SplashPay disbursement webhook'
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
    const eventName = String(payload.event || '').toLowerCase();

    if (eventName.startsWith('disbursement.')) {
      const result = await processSplashPayDisbursementWebhook(payload);

      console.log('SPLASHPAY DISBURSEMENT WEBHOOK PROCESSED ON SHARED ENDPOINT:', result);

      return res.status(200).json({
        success: true,
        ignored: result.ignored,
        reference: result.reference,
        status: result.status
      });
    }

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

    if (reference) {
      transaction = await findPaymentTransactionByReference(reference);
    }

    if (!transaction && providerReference) {
      transaction = await findPaymentTransactionByProviderReference(providerReference);
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
      console.log('SPLASHPAY WEBHOOK PROVIDER REFERENCE CHANGED:', {
        reference: transaction.reference,
        initiatedProviderReference: transaction.provider_reference,
        webhookProviderReference: providerReference
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
  if (!devRoutesEnabled) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

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
  if (!devRoutesEnabled) {
    return res.status(404).json({ success: false, error: 'Not found' });
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
  if (!devRoutesEnabled) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

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
  if (!devRoutesEnabled) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

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
  if (!devRoutesEnabled) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

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
