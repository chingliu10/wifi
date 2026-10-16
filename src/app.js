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
  updatePaymentProviderDetails,
  updatePaymentStatus
} = require('./repositories/payment-transaction-repository');
const {
  findSubscriptionByPaymentTransactionId
} = require('./repositories/subscription-repository');
const { initiatePayment, checkPaymentStatus } = require('./services/payments/payment-service');
const {
  activateSubscriptionForPayment
} = require('./services/subscriptions/subscription-service');
const adminRouter = require('./routes/admin');

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
          s.external_portal_site_id
        FROM sites s
        LEFT JOIN network_devices nd ON nd.site_id = s.id
        WHERE s.active = true
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
  if (transaction.status === 'paid' && subscription && subscription.status === 'active') {
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
  const paymentActive = Boolean(
    transaction.status === 'paid' &&
    subscription &&
    subscription.status === 'active' &&
    new Date(subscription.expires_at).getTime() > Date.now()
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
    showPayNow: transaction.status === 'pending' && !transaction.provider_reference,
    paymentInitiated: transaction.status === 'pending' && Boolean(transaction.provider_reference)
  });
};

app.engine('hbs', engine({
  extname: '.hbs',
  defaultLayout: 'main',
  helpers: {
    formatTzs: (amount) => Number(amount).toLocaleString('en-US'),
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
    json: (value) => JSON.stringify(value)
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

app.get('/portal/setup/:portalKey', async (req, res) => {
  console.log('OMADA SETUP QUERY:', req.query);

  try {
    const {
      clientMac,
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
        ORDER BY sort_order
      `,
      [siteConfig.id]
    );

    const portalContext = {
      site,
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
      site,
      apMac,
      ssidName,
      redirectUrl,
      radioId
    } = req.body;

    if (!customerName || !phone || !packageId || !clientMac || !deviceId) {
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
      providerReference: providerResult.providerReference
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
      providerReference: providerResult.providerReference
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
        new Date(subscription.expires_at).getTime() > Date.now()
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
