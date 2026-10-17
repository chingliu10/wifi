const express = require('express');
const crypto = require('crypto');
const pool = require('../config/database');
const { normalizeMacAddress } = require('../utils/mac-address');
const {
  authenticateUser,
  createSession,
  destroySession,
  getUserFromRequest,
  setSessionCookie,
  clearSessionCookie,
  changePassword,
  createClientOwner
} = require('../services/auth-service');
const omada = require('../services/omada/open-api-client');
const { normalizeLanguage, translate } = require('../i18n/admin');
const {
  provisionSite,
  recordProvisionError,
  getDeviceCredentials,
  getInformHost,
  createDeviceClaim
} = require('../services/omada/provisioning-service');
const {
  detectSiteRadioCapabilities,
  listSiteWifiNetworks,
  createSiteWifiNetwork,
  renameSiteWifiNetwork
} = require('../services/omada/wifi-service');
const {
  previewMobileMoneyPayout,
  requestMobileMoneyPayout,
  mobileMoneyNetworks
} = require('../services/payouts/payout-service');
const {
  MAX_BATCH_QUANTITY,
  getVoucherAdminOptions,
  createVoucherBatch,
  listVoucherBatches,
  getVoucherBatch
} = require('../services/vouchers/voucher-service');

const router = express.Router();

const ADMIN_PAGE_SIZE = 25;

const readCookie = (req, name) => {
  const cookieHeader = String(req.headers.cookie || '');

  for (const pair of cookieHeader.split(';')) {
    const [key, ...valueParts] = pair.trim().split('=');

    if (key === name) {
      return decodeURIComponent(valueParts.join('=') || '');
    }
  }

  return null;
};

const getPage = (value) => {
  const page = Number.parseInt(String(value || '1'), 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
};

const buildPagination = ({
  page,
  total,
  basePath,
  query = {},
  pageParam = 'page'
}) => {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / ADMIN_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const buildUrl = (targetPage) => {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries({
      ...query,
      [pageParam]: targetPage
    })) {
      if (value !== undefined && value !== null && String(value) !== '') {
        params.set(key, String(value));
      }
    }

    return basePath + '?' + params.toString();
  };

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  const pages = [];

  for (let number = start; number <= end; number += 1) {
    pages.push({
      number,
      current: number === currentPage,
      url: buildUrl(number)
    });
  }

  return {
    page: currentPage,
    pageSize: ADMIN_PAGE_SIZE,
    total: Number(total || 0),
    totalPages,
    hasPrevious: currentPage > 1,
    hasNext: currentPage < totalPages,
    previousUrl: currentPage > 1 ? buildUrl(currentPage - 1) : null,
    nextUrl: currentPage < totalPages ? buildUrl(currentPage + 1) : null,
    pages
  };
};

const formatLiveClientDuration = (value) => {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return value ? String(value) : '—';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
};

const normalizeLiveClient = (client) => {
  const signalValue =
    client.rssi ??
    client.signal ??
    client.signalLevel ??
    client.signalStrength ??
    null;

  const durationValue =
    client.uptime ??
    client.duration ??
    client.connectDuration ??
    client.connectedTime ??
    null;

  return {
    name:
      client.name ||
      client.clientName ||
      client.deviceName ||
      client.hostname ||
      client.hostName ||
      '—',
    mac:
      client.mac ||
      client.clientMac ||
      client.macAddress ||
      '—',
    ip:
      client.ip ||
      client.clientIp ||
      client.ipAddress ||
      '—',
    ssid:
      client.ssid ||
      client.ssidName ||
      client.wlanName ||
      '—',
    ap:
      client.apName ||
      client.deviceName ||
      client.apMac ||
      client.gatewayName ||
      '—',
    signal:
      signalValue === null || signalValue === undefined
        ? '—'
        : String(signalValue).includes('dBm')
          ? String(signalValue)
          : String(signalValue) + ' dBm',
    uptime: formatLiveClientDuration(durationValue)
  };
};



const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

const createPortalKey = () =>
  crypto.randomBytes(24).toString('base64url');

const getPublicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();

  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProto || req.protocol || 'https';

  return `${protocol}://${req.get('host')}`;
};

const ensurePortalKeys = async (sites) => {
  const result = [];

  for (const site of sites) {
    let portalKey = site.portal_key;

    if (!portalKey) {
      portalKey = createPortalKey();

      await pool.query(
        `
          UPDATE sites
          SET
            portal_key = $2,
            updated_at = NOW()
          WHERE id = $1
            AND portal_key IS NULL
        `,
        [site.id, portalKey]
      );

      const refreshed = await pool.query(
        'SELECT portal_key FROM sites WHERE id = $1 LIMIT 1',
        [site.id]
      );

      portalKey = refreshed.rows[0]?.portal_key || portalKey;
    }

    result.push({
      ...site,
      portal_key: portalKey
    });
  }

  return result;
};

const requireAuth = async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.redirect('/admin/login');
    }

    req.authUser = user;
    next();
  } catch (error) {
    console.error('ADMIN AUTH ERROR:', error);
    res.status(500).send('Unable to authenticate.');
  }
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.authUser || req.authUser.role !== 'super_admin') {
    return res.status(403).send('Super admin access is required.');
  }

  next();
};

const getOrganizations = async (user) => {
  if (user.role === 'client_owner') {
    const result = await pool.query(
      `
        SELECT
          id,
          name,
          slug,
          owner_name,
          owner_phone,
          active,
          vouchers_enabled,
          voucher_portal_enabled,
          created_at
        FROM organizations
        WHERE id = $1
          AND active = TRUE
        LIMIT 1
      `,
      [user.organization_id]
    );

    return result.rows;
  }

  const result = await pool.query(`
    SELECT
      id,
      name,
      slug,
      owner_name,
      owner_phone,
      active,
      vouchers_enabled,
      voucher_portal_enabled,
      created_at
    FROM organizations
    WHERE active = TRUE
    ORDER BY name
  `);

  return result.rows;
};

const getSelectedOrganization = async (req) => {
  const organizations = await getOrganizations(req.authUser);

  if (!organizations.length) {
    return { organizations, selectedOrg: null };
  }

  if (req.authUser.role === 'client_owner') {
    return {
      organizations: [{ ...organizations[0], selected: true }],
      selectedOrg: organizations[0]
    };
  }

  const requestedId = Number(
    req.query.org ||
    req.body?.organizationId
  );

  const selectedOrg =
    organizations.find((org) => Number(org.id) === requestedId) ||
    organizations[0];

  const options = organizations.map((org) => ({
    ...org,
    selected: Number(org.id) === Number(selectedOrg.id)
  }));

  return { organizations: options, selectedOrg };
};

const renderAdmin = (req, res, view, data) => {
  const title = data.titleKey
    ? req.t(data.titleKey)
    : data.title || 'Solidus WiFi';

  return res.render(view, {
    layout: 'admin',
    ...data,
    title,
    language: req.language,
    isEnglish: req.language === 'en',
    isSwahili: req.language === 'sw',
    currentUser: req.authUser,
    isSuperAdmin: req.authUser?.role === 'super_admin',
    isClientOwner: req.authUser?.role === 'client_owner'
  });
};

const ensureVoucherFeatureEnabled = (selectedOrg) => {
  if (!selectedOrg?.vouchers_enabled) {
    const error = new Error('Voucher management is not enabled for this client');
    error.statusCode = 404;
    throw error;
  }
};

const csvCell = (value) => {
  const text = String(value ?? '');

  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return '"' + text.replace(/"/g, '""') + '"';
};

const renderVoucherAdmin = async ({
  req,
  res,
  organizations,
  selectedOrg,
  error = null
}) => {
  ensureVoucherFeatureEnabled(selectedOrg);

  const page = getPage(req.query.page);
  const [{ sites, packages }, batchResult] = await Promise.all([
    getVoucherAdminOptions(selectedOrg.id),
    listVoucherBatches({
      organizationId: selectedOrg.id,
      page,
      pageSize: ADMIN_PAGE_SIZE
    })
  ]);

  const pagination = buildPagination({
    page,
    total: batchResult.total,
    basePath: '/admin/vouchers',
    query: {
      org: selectedOrg.id
    }
  });

  return renderAdmin(req, res, 'admin/vouchers', {
    titleKey: 'vouchers.title',
    organizations,
    selectedOrg,
    sites,
    packages,
    batches: batchResult.batches,
    pagination,
    maxBatchQuantity: MAX_BATCH_QUANTITY,
    error
  });
};

router.get('/login', async (req, res) => {
  const language = normalizeLanguage(
    req.query.lang || readCookie(req, 'solidus_admin_lang') || 'en'
  );

  if (req.query.lang) {
    res.cookie('solidus_admin_lang', language, {
      httpOnly: false,
      sameSite: 'lax',
      secure: String(req.headers['x-forwarded-proto'] || req.protocol) === 'https',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
  }

  try {
    const user = await getUserFromRequest(req);

    if (user) {
      return res.redirect('/admin');
    }
  } catch (error) {
    console.error('LOGIN SESSION CHECK ERROR:', error);
  }

  res.render('admin/login', {
    layout: 'auth',
    title: translate(language, 'login.signIn'),
    language,
    isEnglish: language === 'en',
    isSwahili: language === 'sw'
  });
});

router.post('/login', async (req, res) => {
  const language = normalizeLanguage(
    req.body.language || readCookie(req, 'solidus_admin_lang') || 'en'
  );

  try {
    const user = await authenticateUser({
      username: req.body.username,
      password: req.body.password
    });

    if (!user) {
      return res.status(401).render('admin/login', {
        layout: 'auth',
        title: translate(language, 'login.signIn'),
        language,
        isEnglish: language === 'en',
        isSwahili: language === 'sw',
        username: String(req.body.username || '').trim(),
        error: translate(language, 'login.invalid')
      });
    }

    const token = await createSession(user.id);
    setSessionCookie(req, res, token);

    res.redirect('/admin');
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error);

    res.status(500).render('admin/login', {
      layout: 'auth',
      title: translate(language, 'login.signIn'),
      language,
      isEnglish: language === 'en',
      isSwahili: language === 'sw',
      username: String(req.body.username || '').trim(),
      error: translate(language, 'login.error')
    });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const cookieHeader = String(req.headers.cookie || '');
    const match = cookieHeader.match(/(?:^|;\s*)solidus_session=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;

    await destroySession(token);
  } catch (error) {
    console.error('ADMIN LOGOUT ERROR:', error);
  }

  clearSessionCookie(req, res);
  res.redirect('/admin/login');
});

router.use(requireAuth);

router.get('/app', (req, res) => {
  return res.redirect(302, '/admin');
});

router.use((req, res, next) => {
  const requested = req.query.lang;
  const language = normalizeLanguage(
    requested || readCookie(req, 'solidus_admin_lang') || 'en'
  );

  if (requested) {
    res.cookie('solidus_admin_lang', language, {
      httpOnly: false,
      sameSite: 'lax',
      secure: String(req.headers['x-forwarded-proto'] || req.protocol) === 'https',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
  }

  req.language = language;
  req.t = (key) => translate(language, key);
  next();
});

router.get('/account/password', async (req, res) => {
  const { organizations, selectedOrg } = await getSelectedOrganization(req);

  return renderAdmin(req, res, 'admin/change-password', {
    titleKey: 'account.changePassword',
    organizations,
    selectedOrg,
    success:
      String(req.query.updated || '') === '1'
        ? req.t('account.passwordUpdated')
        : null
  });
});

router.post('/account/password', async (req, res) => {
  const { organizations, selectedOrg } = await getSelectedOrganization(req);
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  const renderError = (message) =>
    renderAdmin(req, res.status(400), 'admin/change-password', {
      titleKey: 'account.changePassword',
      organizations,
      selectedOrg,
      error: message
    });

  if (
    newPassword.length < 8 ||
    newPassword.length > 128
  ) {
    return renderError(req.t('account.passwordInvalid'));
  }

  if (newPassword !== confirmPassword) {
    return renderError(req.t('account.passwordMismatch'));
  }

  try {
    await changePassword({
      userId: req.authUser.id,
      currentPassword,
      newPassword
    });

    const token = await createSession(req.authUser.id);
    setSessionCookie(req, res, token);

    return res.redirect('/admin/account/password?updated=1');
  } catch (error) {
    if (error.code === 'INVALID_CURRENT_PASSWORD') {
      return renderError(req.t('account.currentPasswordWrong'));
    }

    if (error.code === 'PASSWORD_UNCHANGED') {
      return renderError(req.t('account.passwordSame'));
    }

    console.error('ADMIN CHANGE PASSWORD ERROR:', error);

    return res.status(500).send('Unable to change password.');
  }
});

router.get('/', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return renderAdmin(req, res, 'admin/dashboard', {
        titleKey: 'dashboard.title',
        organizations,
        selectedOrg: null,
        stats: {},
        recentPayments: [],
        checklist: []
      });
    }

    const [
      statsResult,
      recentPaymentsResult,
      setupResult,
      walletResult
    ] = await Promise.all([
      pool.query(
        `
          SELECT
            (
              SELECT COUNT(*)
              FROM sites
              WHERE organization_id = $1
                AND active = TRUE
            )::INTEGER AS sites,
            (
              SELECT COUNT(*)
              FROM network_devices nd
              JOIN sites s ON s.id = nd.site_id
              WHERE s.organization_id = $1
                AND nd.active = TRUE
            )::INTEGER AS devices,
            (
              SELECT COUNT(DISTINCT pt.device_id)
              FROM payment_transactions pt
              WHERE pt.organization_id = $1
                AND pt.status = 'paid'
            )::INTEGER AS customers,
            (
              SELECT COUNT(*)
              FROM subscriptions sub
              JOIN sites s ON s.id = sub.site_id
              WHERE s.organization_id = $1
                AND sub.status = 'active'
                AND sub.expires_at > NOW()
            )::INTEGER AS active_sessions,
            (
              SELECT COUNT(*)
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
                AND paid_at::date = CURRENT_DATE
            )::INTEGER AS payments_today,
            (
              SELECT COALESCE(SUM(amount_tzs), 0)
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
                AND paid_at::date = CURRENT_DATE
            )::BIGINT AS revenue_today,
            (
              SELECT COALESCE(SUM(amount_tzs), 0)
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
            )::NUMERIC(18,2) AS collected_total,
            (
              SELECT COUNT(*)
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
                AND (
                  gateway_fee_tzs IS NULL
                  OR net_amount_tzs IS NULL
                )
            )::INTEGER AS unreconciled_payments
        `,
        [selectedOrg.id]
      ),
      pool.query(
        `
          SELECT
            pt.reference,
            pt.customer_name,
            pt.phone,
            pt.amount_tzs,
            pt.gateway_fee_tzs,
            pt.net_amount_tzs,
            pt.status,
            pt.paid_at,
            COALESCE(pt.package_name_snapshot, p.name) AS package_name,
            COALESCE(pt.site_name_snapshot, s.name) AS site_name
          FROM payment_transactions pt
          JOIN packages p ON p.id = pt.package_id
          JOIN sites s ON s.id = p.site_id
          WHERE pt.organization_id = $1
          ORDER BY pt.created_at DESC
          LIMIT 8
        `,
        [selectedOrg.id]
      ),
      pool.query(
        `
          SELECT
            EXISTS(
              SELECT 1
              FROM sites
              WHERE organization_id = $1
            ) AS has_site,
            EXISTS(
              SELECT 1
              FROM network_devices nd
              JOIN sites s ON s.id = nd.site_id
              WHERE s.organization_id = $1
            ) AS has_device,
            EXISTS(
              SELECT 1
              FROM packages p
              JOIN sites s ON s.id = p.site_id
              WHERE s.organization_id = $1
                AND p.active = TRUE
            ) AS has_package,
            EXISTS(
              SELECT 1
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
            ) AS has_payment,
            EXISTS(
              SELECT 1
              FROM sites
              WHERE organization_id = $1
                AND brand_name IS NOT NULL
                AND support_phone IS NOT NULL
            ) AS has_branding
        `,
        [selectedOrg.id]
      ),
      pool.query(
        `
          SELECT
            (
              COALESCE((
                SELECT SUM(
                  CASE
                    WHEN entry_type = 'adjustment' AND amount_tzs > 0 THEN 0
                    ELSE amount_tzs
                  END
                )
                FROM wallet_entries
                WHERE organization_id = $1
              ), 0)
              -
              COALESCE((
                SELECT SUM(total_amount_tzs)
                FROM payout_transactions
                WHERE organization_id = $1
                  AND status IN ('pending', 'processing')
              ), 0)
            )::NUMERIC(18,2) AS available_balance,
            COALESCE(
              -SUM(amount_tzs) FILTER (WHERE entry_type = 'gateway_fee'),
              0
            )::NUMERIC(18,2) AS gateway_fees,
            COALESCE(
              -SUM(amount_tzs) FILTER (WHERE entry_type = 'platform_fee'),
              0
            )::NUMERIC(18,2) AS platform_fees,
            COALESCE(
              -SUM(amount_tzs) FILTER (WHERE entry_type = 'payout_debit'),
              0
            )::NUMERIC(18,2) AS paid_out
          FROM wallet_entries
          WHERE organization_id = $1
        `,
        [selectedOrg.id]
      )
    ]);

    const setup = setupResult.rows[0];

    return renderAdmin(req, res, 'admin/dashboard', {
      titleKey: 'dashboard.title',
      organizations,
      selectedOrg,
      stats: {
        ...statsResult.rows[0],
        available_balance: walletResult.rows[0].available_balance,
        gateway_fees: walletResult.rows[0].gateway_fees,
        platform_fees: walletResult.rows[0].platform_fees,
        paid_out: walletResult.rows[0].paid_out
      },
      recentPayments: recentPaymentsResult.rows,
      voucherFeatureUpdated:
        String(req.query.voucherFeature || '') === 'enabled'
          ? 'enabled'
          : String(req.query.voucherFeature || '') === 'disabled'
            ? 'disabled'
            : null,
      checklist: [
        { label: req.t('checklist.site'), done: setup.has_site },
        { label: req.t('checklist.device'), done: setup.has_device },
        { label: req.t('checklist.package'), done: setup.has_package },
        { label: req.t('checklist.branding'), done: setup.has_branding },
        { label: req.t('checklist.payment'), done: setup.has_payment }
      ]
    });
  } catch (error) {
    console.error('ADMIN DASHBOARD ERROR:', error);
    res.status(500).send('Unable to load admin dashboard.');
  }
});

router.get('/clients/new', requireSuperAdmin, async (req, res) => {
  const organizations = await getOrganizations(req.authUser);

  return renderAdmin(req, res, 'admin/client-new', {
    title: 'Add client',
    organizations,
    selectedOrg: null
  });
});

router.post('/clients', requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      organizationName,
      ownerName,
      ownerPhone,
      ownerUsername,
      ownerPassword,
      ownerPasswordConfirm
    } = req.body;

    const orgName = String(organizationName || '').trim();
    const contactName = String(ownerName || '').trim();

    if (!orgName || !contactName || !ownerUsername || !ownerPassword) {
      return res.status(400).send(
        'Business name, owner name, owner username and owner password are required.'
      );
    }

    if (
      String(ownerPassword).length < 8 ||
      String(ownerPassword).length > 128
    ) {
      return res.status(400).send(
        'Owner password must be between 8 and 128 characters.'
      );
    }

    if (ownerPassword !== ownerPasswordConfirm) {
      return res.status(400).send('Owner passwords do not match.');
    }

    const baseSlug = slugify(orgName) || 'client';
    const suffix = crypto.randomBytes(2).toString('hex');
    const orgSlug = `${baseSlug}-${suffix}`;

    await client.query('BEGIN');

    const orgResult = await client.query(
      `
        INSERT INTO organizations (
          name,
          slug,
          owner_name,
          owner_phone
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [orgName, orgSlug, contactName, ownerPhone || null]
    );

    const organization = orgResult.rows[0];

    await createClientOwner({
      db: client,
      organizationId: organization.id,
      fullName: contactName,
      username: ownerUsername,
      password: ownerPassword
    });

    await client.query('COMMIT');

    res.redirect('/admin?org=' + organization.id);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ADMIN CREATE CLIENT ERROR:', error);

    if (error.code === '23505') {
      return res.status(409).send('That owner username is already in use.');
    }

    res.status(500).send('Unable to create client.');
  } finally {
    client.release();
  }
});

router.post(
  '/organizations/:id/features/vouchers',
  requireSuperAdmin,
  async (req, res) => {
    try {
      const organizationId = Number(req.params.id);
      const enabled =
        String(req.body.enabled || '').toLowerCase() === 'true' ||
        String(req.body.enabled || '') === '1' ||
        String(req.body.enabled || '').toLowerCase() === 'on';

      if (!organizationId) {
        return res.status(400).send('Invalid client.');
      }

      const updated = await pool.query(
        `
          UPDATE organizations
          SET
            vouchers_enabled = $2,
            voucher_portal_enabled = CASE
              WHEN $2 = FALSE THEN FALSE
              ELSE voucher_portal_enabled
            END,
            updated_at = NOW()
          WHERE id = $1
            AND active = TRUE
          RETURNING id
        `,
        [organizationId, enabled]
      );

      if (!updated.rows[0]) {
        return res.status(404).send('Client not found.');
      }

      return res.redirect(
        '/admin?org=' +
          organizationId +
          '&voucherFeature=' +
          (enabled ? 'enabled' : 'disabled')
      );
    } catch (error) {
      console.error('ADMIN VOUCHER FEATURE UPDATE ERROR:', error);
      return res.status(500).send('Unable to update voucher feature.');
    }
  }
);

router.get('/vouchers', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    return await renderVoucherAdmin({
      req,
      res,
      organizations,
      selectedOrg
    });
  } catch (error) {
    console.error('ADMIN VOUCHERS ERROR:', error);

    if (error.statusCode === 404) {
      return res.status(404).send('Not found.');
    }

    return res.status(500).send('Unable to load vouchers.');
  }
});

router.post('/vouchers/batches', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    ensureVoucherFeatureEnabled(selectedOrg);

    const created = await createVoucherBatch({
      organizationId: selectedOrg.id,
      siteId: Number(req.body.siteId),
      packageId: Number(req.body.packageId),
      quantity: req.body.quantity,
      redeemableUntil: req.body.redeemableUntil,
      createdByUserId: req.authUser.id
    });

    return res.redirect(
      '/admin/vouchers/batches/' +
        created.batch.id +
        '?org=' +
        selectedOrg.id +
        '&created=1'
    );
  } catch (error) {
    console.error('ADMIN VOUCHER BATCH CREATE ERROR:', error);

    if (error.statusCode === 404) {
      return res.status(404).send('Not found.');
    }

    try {
      const { organizations, selectedOrg } = await getSelectedOrganization(req);

      return await renderVoucherAdmin({
        req,
        res: res.status(400),
        organizations,
        selectedOrg,
        error: error.message
      });
    } catch (renderError) {
      console.error('ADMIN VOUCHER ERROR RENDER FAILED:', renderError);
      return res.status(400).send('Unable to create voucher batch.');
    }
  }
});

router.get('/vouchers/batches/:id', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    ensureVoucherFeatureEnabled(selectedOrg);

    const batchView = await getVoucherBatch({
      organizationId: selectedOrg.id,
      batchId: Number(req.params.id),
      includeCodes: true
    });

    if (!batchView) {
      return res.status(404).send('Voucher batch not found.');
    }

    return renderAdmin(req, res, 'admin/voucher-batch', {
      titleKey: 'vouchers.batchTitle',
      organizations,
      selectedOrg,
      batch: batchView.batch,
      vouchers: batchView.vouchers,
      created: String(req.query.created || '') === '1'
    });
  } catch (error) {
    console.error('ADMIN VOUCHER BATCH ERROR:', error);

    if (error.statusCode === 404) {
      return res.status(404).send('Not found.');
    }

    return res.status(500).send('Unable to load voucher batch.');
  }
});

router.get('/vouchers/batches/:id/export.csv', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);

    ensureVoucherFeatureEnabled(selectedOrg);

    const batchView = await getVoucherBatch({
      organizationId: selectedOrg.id,
      batchId: Number(req.params.id),
      includeCodes: true
    });

    if (!batchView) {
      return res.status(404).send('Voucher batch not found.');
    }

    const rows = [
      ['Code', 'Status', 'Site', 'Package', 'Duration seconds', 'Redeemable until'],
      ...batchView.vouchers.map((voucher) => [
        voucher.code,
        voucher.status,
        batchView.batch.site_name,
        batchView.batch.package_name_snapshot,
        batchView.batch.package_duration_seconds_snapshot,
        batchView.batch.redeemable_until
          ? new Date(batchView.batch.redeemable_until).toISOString()
          : ''
      ])
    ];

    const csv =
      rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const safeReference = String(batchView.batch.batch_reference || 'vouchers')
      .replace(/[^A-Za-z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' + safeReference + '.csv"'
    );

    return res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('ADMIN VOUCHER CSV ERROR:', error);

    if (error.statusCode === 404) {
      return res.status(404).send('Not found.');
    }

    return res.status(500).send('Unable to export vouchers.');
  }
});

router.get('/integrations/omada', requireSuperAdmin, async (req, res) => {
  const { organizations, selectedOrg } = await getSelectedOrganization(req);

  const integration = {
    enabled: omada.configured(),
    connected: false,
    controllerVersion: null,
    sitesVisible: null,
    error: null
  };

  if (integration.enabled) {
    try {
      const info = await omada.getControllerInfo();
      await omada.getAccessToken();
      const remoteSites = await omada.listSites();

      integration.connected = true;
      integration.controllerVersion = info.controllerVersion;
      integration.sitesVisible = remoteSites.length;
    } catch (error) {
      integration.error = error.message;
    }
  }

  return renderAdmin(req, res, 'admin/omada-integration', {
    title: 'Omada integration',
    organizations,
    selectedOrg,
    integration
  });
});

router.post('/integrations/omada/test', requireSuperAdmin, async (req, res) => {
  try {
    await omada.getAccessToken({ force: true });
    await omada.listSites();
    res.redirect('/admin/integrations/omada?tested=1');
  } catch (error) {
    console.error('OMADA INTEGRATION TEST ERROR:', error);
    res.redirect(
      '/admin/integrations/omada?error=' +
      encodeURIComponent(error.message)
    );
  }
});

router.get('/sites', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    const sites = selectedOrg
      ? (
          await pool.query(
            `
              SELECT
                s.id,
                s.name,
                s.slug,
                s.brand_name,
                s.support_phone,
                s.primary_color,
                s.external_portal_site_id,
                s.portal_key,
                s.portal_connected_at,
                s.last_portal_seen_at,
                s.omada_device_username,
                s.omada_device_password_enc,
                s.omada_provisioned_at,
                s.omada_sync_error,
                s.omada_auto_adopt,
                s.active,
                COUNT(nd.id)::INTEGER AS device_count
              FROM sites s
              LEFT JOIN network_devices nd ON nd.site_id = s.id
              WHERE s.organization_id = $1
                AND s.active = TRUE
              GROUP BY s.id
              ORDER BY s.name
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    const sitesWithKeys = await ensurePortalKeys(sites);
    const publicBaseUrl = getPublicBaseUrl(req);
    const informHost = getInformHost();

    const claims = selectedOrg
      ? (
          await pool.query(
            `
              SELECT
                c.id,
                c.site_id,
                c.ap_mac,
                c.status,
                c.last_error,
                c.expires_at,
                c.last_checked_at,
                c.adopted_at,
                c.created_at
              FROM omada_device_claims c
              JOIN sites s ON s.id = c.site_id
              WHERE s.organization_id = $1
              ORDER BY c.created_at DESC
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    const supportUpdatedSiteId =
      Number(req.query.supportUpdated) || null;
    const siteViews = [];

    for (const site of sitesWithKeys) {
      let credentials = null;
      let credentialError = null;

      if (
        site.omada_device_username &&
        site.omada_device_password_enc
      ) {
        try {
          credentials = await getDeviceCredentials(site.id);
        } catch (error) {
          credentialError = error.message;
        }
      }

      let radioCapabilities = null;
      let wifiNetworks = [];
      const wifiErrors = [];

      if (site.external_portal_site_id) {
        try {
          wifiNetworks = await listSiteWifiNetworks(site.id);
        } catch (error) {
          wifiErrors.push('Unable to read WiFi networks: ' + error.message);
        }

        if (Number(site.device_count) > 0) {
          try {
            radioCapabilities = await detectSiteRadioCapabilities(site.id);
          } catch (error) {
            wifiErrors.push('Unable to detect AP radios: ' + error.message);
          }
        }
      }

      siteViews.push({
        ...site,
        setup_url: `${publicBaseUrl}/portal/setup/${site.portal_key}`,
        omada_provisioned: Boolean(site.external_portal_site_id),
        omada_connected: Boolean(site.external_portal_site_id),
        inform_host: informHost,
        device_username: credentials?.username || null,
        device_password: credentials?.password || null,
        credential_error: credentialError,
        radio_capabilities: radioCapabilities,
        wifi_networks: wifiNetworks,
        wifi_error: wifiErrors.join(' '),
        support_updated:
          supportUpdatedSiteId === Number(site.id),
        claims: claims.filter(
          (claim) => Number(claim.site_id) === Number(site.id)
        )
      });
    }

    const deviceSearch = String(req.query.deviceSearch || '')
      .trim()
      .slice(0, 100);
    const deviceSiteId = Number(req.query.deviceSiteId) || null;
    const deviceStatus = ['active', 'inactive'].includes(
      String(req.query.deviceStatus || '')
    )
      ? String(req.query.deviceStatus)
      : '';
    const devicePage = getPage(req.query.devicePage);

    let devices = [];
    let deviceTotal = 0;

    if (selectedOrg) {
      const values = [
        selectedOrg.id,
        deviceSearch,
        deviceSiteId,
        deviceStatus
      ];

      const where = `
        s.organization_id = $1
        AND (
          $2::text = ''
          OR nd.name ILIKE '%' || $2 || '%'
          OR COALESCE(nd.ap_mac, '') ILIKE '%' || $2 || '%'
          OR COALESCE(nd.model, '') ILIKE '%' || $2 || '%'
          OR COALESCE(nd.management_ip::text, '') ILIKE '%' || $2 || '%'
        )
        AND ($3::bigint IS NULL OR nd.site_id = $3)
        AND (
          $4::text = ''
          OR ($4 = 'active' AND nd.active = TRUE)
          OR ($4 = 'inactive' AND nd.active = FALSE)
        )
      `;

      const countResult = await pool.query(
        `
          SELECT COUNT(*)::INTEGER AS total
          FROM network_devices nd
          JOIN sites s ON s.id = nd.site_id
          WHERE ${where}
        `,
        values
      );

      deviceTotal = countResult.rows[0]?.total || 0;
      const paginationPreview = buildPagination({
        page: devicePage,
        total: deviceTotal,
        basePath: '/admin/sites',
        pageParam: 'devicePage'
      });
      const offset =
        (paginationPreview.page - 1) * ADMIN_PAGE_SIZE;

      devices = (
        await pool.query(
          `
            SELECT
              nd.id,
              nd.site_id,
              nd.name,
              nd.nas_identifier,
              nd.brand,
              nd.model,
              nd.management_ip,
              nd.ap_mac,
              nd.device_type,
              nd.ssid_name,
              nd.last_seen_at,
              nd.active,
              s.name AS site_name
            FROM network_devices nd
            JOIN sites s ON s.id = nd.site_id
            WHERE ${where}
            ORDER BY s.name, nd.name
            LIMIT $5 OFFSET $6
          `,
          [...values, ADMIN_PAGE_SIZE, offset]
        )
      ).rows;
    }

    const deviceSiteOptions = sitesWithKeys.map((site) => ({
      id: site.id,
      name: site.name,
      selected: deviceSiteId === Number(site.id)
    }));

    const deviceStatusOptions = [
      { value: '', label: req.t('common.allStatuses') },
      { value: 'active', label: req.t('common.active') },
      { value: 'inactive', label: req.t('common.inactive') }
    ].map((option) => ({
      ...option,
      selected: option.value === deviceStatus
    }));

    const devicePagination = buildPagination({
      page: devicePage,
      total: deviceTotal,
      basePath: '/admin/sites',
      pageParam: 'devicePage',
      query: {
        org: selectedOrg?.id,
        deviceSearch,
        deviceSiteId: deviceSiteId || '',
        deviceStatus
      }
    });

    return renderAdmin(req, res, 'admin/sites', {
      titleKey: 'sites.title',
      organizations,
      selectedOrg,
      sites: siteViews,
      devices,
      deviceSiteOptions,
      deviceStatusOptions,
      deviceFilters: {
        search: deviceSearch,
        siteId: deviceSiteId,
        status: deviceStatus
      },
      devicePagination,
      omadaApiEnabled: omada.configured()
    });
  } catch (error) {
    console.error('ADMIN SITES ERROR:', error);
    res.status(500).send('Unable to load sites.');
  }
});

router.post('/sites', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return res.status(400).send('Create or select a client first.');
    }

    const siteName = String(req.body.siteName || '').trim();
    const brandName = String(req.body.brandName || '').trim();
    const supportPhone = String(req.body.supportPhone || '').trim();
    const primaryColor = String(req.body.primaryColor || '#0B6B47').trim();
    const portalKey = createPortalKey();

    if (!siteName) {
      return res.status(400).send('Site name is required.');
    }

    const suffix = crypto.randomBytes(2).toString('hex');
    const siteSlug = `${slugify(siteName) || 'site'}-${suffix}`;

    const created = await pool.query(
      `
        INSERT INTO sites (
          organization_id,
          name,
          slug,
          brand_name,
          support_phone,
          primary_color,
          portal_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `,
      [
        selectedOrg.id,
        siteName,
        siteSlug,
        brandName || siteName + ' WiFi',
        supportPhone || null,
        primaryColor || '#0B6B47',
        portalKey
      ]
    );

    const siteId = created.rows[0].id;

    if (omada.configured()) {
      try {
        await provisionSite(siteId);
      } catch (error) {
        console.error('OMADA SITE PROVISION ERROR:', error);
        await recordProvisionError(siteId, error);
      }
    }

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN SITE CREATE ERROR:', error);

    if (error.code === '23505') {
      return res.status(409).send(
        'Unable to create a unique site. Please retry.'
      );
    }

    res.status(500).send('Unable to create site.');
  }
});

router.post('/sites/:id/support-phone', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const siteId = Number(req.params.id);
    const supportPhone = String(req.body.supportPhone || '').trim();

    if (!selectedOrg || !siteId) {
      return res.status(400).send('Invalid site.');
    }

    const digits = supportPhone.replace(/\D/g, '');
    const validTanzanianPhone =
      /^0[67]\d{8}$/.test(digits) ||
      /^255[67]\d{8}$/.test(digits);

    if (!validTanzanianPhone) {
      return res.status(400).send(req.t('sites.invalidSupport'));
    }

    const result = await pool.query(
      `
        UPDATE sites
        SET
          support_phone = $3,
          updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        RETURNING id
      `,
      [siteId, selectedOrg.id, supportPhone]
    );

    if (!result.rows[0]) {
      return res.status(404).send('Site not found.');
    }

    return res.redirect(
      '/admin/sites?org=' +
      encodeURIComponent(selectedOrg.id) +
      '&supportUpdated=' +
      encodeURIComponent(siteId)
    );
  } catch (error) {
    console.error('ADMIN SITE SUPPORT PHONE UPDATE ERROR:', error);
    return res.status(500).send('Unable to update support phone.');
  }
});

router.post('/sites/:id/omada/provision', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const siteId = Number(req.params.id);

    if (!selectedOrg || !siteId) {
      return res.status(400).send('Invalid site.');
    }

    const owned = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, selectedOrg.id]
    );

    if (!owned.rows[0]) {
      return res.status(404).send('Site not found.');
    }

    try {
      await provisionSite(siteId);
    } catch (error) {
      await recordProvisionError(siteId, error);
      throw error;
    }

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('OMADA PROVISION RETRY ERROR:', error);
    res.status(500).send(
      'Unable to provision the Omada site: ' + error.message
    );
  }
});

router.post('/sites/:id/omada/claim', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const siteId = Number(req.params.id);

    if (!selectedOrg || !siteId) {
      return res.status(400).send('Invalid site.');
    }

    const owned = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, selectedOrg.id]
    );

    if (!owned.rows[0]) {
      return res.status(404).send('Site not found.');
    }

    await createDeviceClaim({
      siteId,
      apMac: req.body.apMac,
      localUsername: req.body.localUsername,
      localPassword: req.body.localPassword
    });

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('OMADA DEVICE CLAIM ERROR:', error);
    res.status(400).send('Unable to claim AP: ' + error.message);
  }
});

router.post('/sites/:id/wifi-networks', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const siteId = Number(req.params.id);

    if (!selectedOrg || !siteId) {
      return res.status(400).send('Invalid site.');
    }

    const owned = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, selectedOrg.id]
    );

    if (!owned.rows[0]) {
      return res.status(404).send('Site not found.');
    }

    await createSiteWifiNetwork({
      siteId,
      ssidName: req.body.ssidName,
      bandPreference: req.body.bandPreference || 'auto'
    });

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('OMADA WIFI CREATE ERROR:', error);
    res.status(400).send('Unable to create WiFi network: ' + error.message);
  }
});

router.post('/sites/:id/wifi-networks/:ssidId/rename', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const siteId = Number(req.params.id);

    if (!selectedOrg || !siteId) {
      return res.status(400).send('Invalid site.');
    }

    const owned = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, selectedOrg.id]
    );

    if (!owned.rows[0]) {
      return res.status(404).send('Site not found.');
    }

    await renameSiteWifiNetwork({
      siteId,
      wlanId: req.body.wlanId,
      ssidId: req.params.ssidId,
      ssidName: req.body.ssidName
    });

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('OMADA WIFI RENAME ERROR:', error);
    res.status(400).send('Unable to rename WiFi network: ' + error.message);
  }
});

const formatPackageDuration = (seconds) => {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value <= 0) return '—';

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
};

const splitPackageDuration = (seconds) => {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value <= 0) {
    return { value: 1, unit: 'minutes' };
  }

  if (value % 86400 === 0) {
    return { value: value / 86400, unit: 'days' };
  }

  if (value % 3600 === 0) {
    return { value: value / 3600, unit: 'hours' };
  }

  return { value: Math.max(1, Math.round(value / 60)), unit: 'minutes' };
};

router.get('/packages', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const siteId = Number(req.query.siteId) || null;
    const packageStatus = ['active', 'inactive'].includes(
      String(req.query.packageStatus || '')
    )
      ? String(req.query.packageStatus)
      : '';
    const page = getPage(req.query.page);

    const sites = selectedOrg
      ? (
          await pool.query(
            `
              SELECT id, name
              FROM sites
              WHERE organization_id = $1
                AND active = TRUE
              ORDER BY name
            `,
            [selectedOrg.id]
          )
        ).rows.map((site) => ({
          ...site,
          selected: siteId === Number(site.id)
        }))
      : [];

    let packages = [];
    let total = 0;

    if (selectedOrg) {
      const values = [
        selectedOrg.id,
        search,
        siteId,
        packageStatus
      ];

      const where = `
        s.organization_id = $1
        AND p.deleted_at IS NULL
        AND (
          $2::text = ''
          OR p.name ILIKE '%' || $2 || '%'
        )
        AND ($3::bigint IS NULL OR p.site_id = $3)
        AND (
          $4::text = ''
          OR ($4 = 'active' AND p.active = TRUE)
          OR ($4 = 'inactive' AND p.active = FALSE)
        )
      `;

      const countResult = await pool.query(
        `
          SELECT COUNT(*)::INTEGER AS total
          FROM packages p
          JOIN sites s ON s.id = p.site_id
          WHERE ${where}
        `,
        values
      );

      total = countResult.rows[0]?.total || 0;
      const paginationPreview = buildPagination({
        page,
        total,
        basePath: '/admin/packages'
      });
      const offset = (paginationPreview.page - 1) * ADMIN_PAGE_SIZE;

      packages = (
        await pool.query(
          `
            SELECT
              p.id,
              p.name,
              p.price_tzs,
              p.duration_seconds,
              p.active,
              s.name AS site_name
            FROM packages p
            JOIN sites s ON s.id = p.site_id
            WHERE ${where}
            ORDER BY s.name, p.sort_order, p.id
            LIMIT $5 OFFSET $6
          `,
          [...values, ADMIN_PAGE_SIZE, offset]
        )
      ).rows.map((pkg) => {
        const duration = splitPackageDuration(pkg.duration_seconds);

        return {
          ...pkg,
          duration_label: formatPackageDuration(pkg.duration_seconds),
          duration_value: duration.value,
          duration_unit: duration.unit,
          duration_minutes_selected: duration.unit === 'minutes',
          duration_hours_selected: duration.unit === 'hours',
          duration_days_selected: duration.unit === 'days'
        };
      });
    }

    const packageStatusOptions = [
      { value: '', label: req.t('common.allStatuses') },
      { value: 'active', label: req.t('common.active') },
      { value: 'inactive', label: req.t('common.inactive') }
    ].map((option) => ({
      ...option,
      selected: option.value === packageStatus
    }));

    const pagination = buildPagination({
      page,
      total,
      basePath: '/admin/packages',
      query: {
        org: selectedOrg?.id,
        search,
        siteId: siteId || '',
        packageStatus
      }
    });

    return renderAdmin(req, res, 'admin/packages', {
      titleKey: 'packages.title',
      organizations,
      selectedOrg,
      sites,
      packages,
      packageStatusOptions,
      filters: {
        search,
        siteId,
        packageStatus
      },
      pagination
    });
  } catch (error) {
    console.error('ADMIN PACKAGES ERROR:', error);
    res.status(500).send('Unable to load packages.');
  }
});

router.post('/packages', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return res.status(400).send('Create or select a client first.');
    }

    const siteId = Number(req.body.siteId);
    const packageName = String(req.body.packageName || '').trim();
    const priceTzs = Number(req.body.priceTzs);
    const durationValue = Number(req.body.durationValue);
    const durationUnit = String(req.body.durationUnit || 'hours');

    const multipliers = {
      minutes: 60,
      hours: 3600,
      days: 86400
    };

    const multiplier = multipliers[durationUnit];
    const durationSeconds = durationValue * multiplier;

    if (Number.isInteger(priceTzs) && priceTzs < 500) {
      return res.status(400).send('Package price must be at least TZS 500.');
    }

    if (
      !siteId ||
      !packageName ||
      !Number.isInteger(priceTzs) ||
      priceTzs < 500 ||
      !Number.isFinite(durationValue) ||
      durationValue <= 0 ||
      !multiplier
    ) {
      return res.status(400).send('Invalid package details.');
    }

    const siteResult = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, selectedOrg.id]
    );

    if (!siteResult.rows[0]) {
      return res.status(400).send(
        'The selected site does not belong to this client.'
      );
    }

    await pool.query(
      `
        INSERT INTO packages (
          site_id,
          name,
          price_tzs,
          duration_seconds,
          sort_order,
          active
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          COALESCE(
            (SELECT MAX(sort_order) + 1 FROM packages WHERE site_id = $1),
            1
          ),
          TRUE
        )
      `,
      [siteId, packageName, priceTzs, Math.round(durationSeconds)]
    );

    res.redirect('/admin/packages?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN PACKAGE CREATE ERROR:', error);
    res.status(500).send('Unable to create package.');
  }
});

router.post('/packages/:id', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const packageId = Number(req.params.id);
    const packageName = String(req.body.packageName || '').trim();
    const priceTzs = Number(req.body.priceTzs);
    const durationValue = Number(req.body.durationValue);
    const durationUnit = String(req.body.durationUnit || 'hours');
    const active = req.body.active === 'on';

    const multipliers = {
      minutes: 60,
      hours: 3600,
      days: 86400
    };

    const multiplier = multipliers[durationUnit];
    const durationSeconds = durationValue * multiplier;

    if (
      !selectedOrg ||
      !packageId ||
      !packageName ||
      !Number.isInteger(priceTzs) ||
      priceTzs < 500 ||
      !Number.isFinite(durationValue) ||
      durationValue <= 0 ||
      !multiplier
    ) {
      return res.status(400).send('Invalid package details.');
    }

    const updated = await pool.query(
      `
        UPDATE packages p
        SET
          name = $1,
          price_tzs = $2,
          duration_seconds = $3,
          active = $4,
          updated_at = NOW()
        FROM sites s
        WHERE p.id = $5
          AND p.deleted_at IS NULL
          AND s.id = p.site_id
          AND s.organization_id = $6
        RETURNING p.id
      `,
      [
        packageName,
        priceTzs,
        Math.round(durationSeconds),
        active,
        packageId,
        selectedOrg.id
      ]
    );

    if (!updated.rows[0]) {
      return res.status(404).send('Package not found.');
    }

    res.redirect('/admin/packages?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN PACKAGE UPDATE ERROR:', error);
    res.status(500).send('Unable to update package.');
  }
});

router.post('/packages/:id/delete', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const packageId = Number(req.params.id);

    if (!selectedOrg || !packageId) {
      return res.status(400).send('Invalid package.');
    }

    const deleted = await pool.query(
      `
        UPDATE packages p
        SET
          active = FALSE,
          deleted_at = NOW(),
          deleted_by_user_id = $3,
          updated_at = NOW()
        FROM sites s
        WHERE p.id = $1
          AND p.deleted_at IS NULL
          AND s.id = p.site_id
          AND s.organization_id = $2
        RETURNING p.id
      `,
      [packageId, selectedOrg.id, req.authUser.id]
    );

    if (!deleted.rows[0]) {
      return res.status(404).send('Package not found.');
    }

    res.redirect('/admin/packages?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN PACKAGE DELETE ERROR:', error);
    res.status(500).send('Unable to delete package.');
  }
});

router.get('/payments', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    const allowedStatuses = new Set([
      'paid',
      'pending',
      'failed',
      'cancelled',
      'expired'
    ]);

    const status = allowedStatuses.has(String(req.query.status || '').toLowerCase())
      ? String(req.query.status).toLowerCase()
      : '';
    const siteId = Number(req.query.siteId) || null;
    const search = String(req.query.search || '').trim().slice(0, 100);
    const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ''))
      ? String(req.query.dateFrom)
      : '';
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ''))
      ? String(req.query.dateTo)
      : '';
    const page = getPage(req.query.page);

    const sites = selectedOrg
      ? (
          await pool.query(
            `
              SELECT id, name
              FROM sites
              WHERE organization_id = $1
              ORDER BY name
            `,
            [selectedOrg.id]
          )
        ).rows.map((site) => ({
          ...site,
          selected: siteId === Number(site.id)
        }))
      : [];

    let payments = [];
    let total = 0;

    if (selectedOrg) {
      const values = [
        selectedOrg.id,
        status,
        siteId,
        search,
        dateFrom,
        dateTo
      ];

      const where = `
        pt.organization_id = $1
        AND ($2::text = '' OR pt.status = $2)
        AND ($3::bigint IS NULL OR s.id = $3)
        AND (
          $4::text = ''
          OR COALESCE(pt.customer_name, '') ILIKE '%' || $4 || '%'
          OR COALESCE(pt.phone, '') ILIKE '%' || $4 || '%'
          OR COALESCE(pt.reference, '') ILIKE '%' || $4 || '%'
        )
        AND ($5::text = '' OR pt.created_at >= $5::date)
        AND (
          $6::text = ''
          OR pt.created_at < ($6::date + INTERVAL '1 day')
        )
      `;

      const countResult = await pool.query(
        `
          SELECT COUNT(*)::INTEGER AS total
          FROM payment_transactions pt
          JOIN packages p ON p.id = pt.package_id
          JOIN sites s ON s.id = p.site_id
          WHERE ${where}
        `,
        values
      );

      total = countResult.rows[0]?.total || 0;
      const paginationPreview = buildPagination({
        page,
        total,
        basePath: '/admin/payments'
      });
      const offset = (paginationPreview.page - 1) * ADMIN_PAGE_SIZE;

      payments = (
        await pool.query(
          `
            SELECT
              pt.reference,
              pt.customer_name,
              pt.phone,
              pt.amount_tzs,
              pt.gateway_fee_tzs,
              pt.net_amount_tzs,
              pt.status,
              pt.provider,
              pt.created_at,
              pt.paid_at,
              pt.provisioning_status,
              COALESCE(pt.package_name_snapshot, p.name) AS package_name,
              s.id AS site_id,
              COALESCE(pt.site_name_snapshot, s.name) AS site_name
            FROM payment_transactions pt
            JOIN packages p ON p.id = pt.package_id
            JOIN sites s ON s.id = p.site_id
            WHERE ${where}
            ORDER BY pt.created_at DESC
            LIMIT $7 OFFSET $8
          `,
          [...values, ADMIN_PAGE_SIZE, offset]
        )
      ).rows;
    }

    const statusOptions = [
      { value: '', label: req.t('common.allStatuses') },
      { value: 'paid', label: req.t('status.paid') },
      { value: 'pending', label: req.t('status.pending') },
      { value: 'failed', label: req.t('status.failed') },
      { value: 'cancelled', label: req.t('status.cancelled') },
      { value: 'expired', label: req.t('status.expired') }
    ].map((option) => ({
      ...option,
      selected: option.value === status
    }));

    const pagination = buildPagination({
      page,
      total,
      basePath: '/admin/payments',
      query: {
        org: selectedOrg?.id,
        status,
        siteId: siteId || '',
        search,
        dateFrom,
        dateTo
      }
    });

    return renderAdmin(req, res, 'admin/payments', {
      titleKey: 'payments.title',
      organizations,
      selectedOrg,
      sites,
      statusOptions,
      filters: {
        status,
        siteId,
        search,
        dateFrom,
        dateTo
      },
      payments,
      pagination
    });
  } catch (error) {
    console.error('ADMIN PAYMENTS ERROR:', error);
    res.status(500).send('Unable to load payments.');
  }
});

router.get('/customers', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const access = ['active', 'inactive'].includes(String(req.query.access || ''))
      ? String(req.query.access)
      : '';
    const page = getPage(req.query.page);

    let customers = [];
    let total = 0;

    if (selectedOrg) {
      const summarySql = `
        WITH customer_summary AS (
          SELECT
            pt.device_id,
            (
              ARRAY_AGG(
                pt.customer_name
                ORDER BY
                  CASE WHEN pt.status = 'paid' THEN 0 ELSE 1 END,
                  pt.paid_at DESC NULLS LAST,
                  pt.created_at DESC
              ) FILTER (
                WHERE pt.customer_name IS NOT NULL
                  AND BTRIM(pt.customer_name) <> ''
              )
            )[1] AS customer_name,
            (
              ARRAY_AGG(
                pt.phone
                ORDER BY
                  CASE WHEN pt.status = 'paid' THEN 0 ELSE 1 END,
                  pt.paid_at DESC NULLS LAST,
                  pt.created_at DESC
              ) FILTER (
                WHERE pt.phone IS NOT NULL
                  AND BTRIM(pt.phone) <> ''
              )
            )[1] AS phone,
            COUNT(*) FILTER (
              WHERE pt.status = 'paid'
            )::INTEGER AS paid_orders,
            COALESCE(
              SUM(pt.amount_tzs) FILTER (
                WHERE pt.status = 'paid'
              ),
              0
            )::NUMERIC(18,2) AS total_spent,
            MIN(pt.created_at) AS first_seen,
            MAX(pt.created_at) AS last_seen,
            MAX(pt.paid_at) FILTER (
              WHERE pt.status = 'paid'
            ) AS latest_payment_at,
            (
              SELECT COALESCE(
                latest_pt.package_name_snapshot,
                p.name
              )
              FROM payment_transactions latest_pt
              JOIN packages p ON p.id = latest_pt.package_id
              WHERE latest_pt.organization_id = $1
                AND latest_pt.device_id = pt.device_id
                AND latest_pt.status = 'paid'
              ORDER BY
                latest_pt.paid_at DESC NULLS LAST,
                latest_pt.created_at DESC
              LIMIT 1
            ) AS latest_package,
            EXISTS(
              SELECT 1
              FROM subscriptions sub
              JOIN sites sub_site ON sub_site.id = sub.site_id
              WHERE sub.device_id = pt.device_id
                AND sub_site.organization_id = $1
                AND sub.status = 'active'
                AND sub.expires_at > NOW()
            ) AS access_active
          FROM payment_transactions pt
          WHERE pt.organization_id = $1
          GROUP BY pt.device_id
        )
      `;

      const countResult = await pool.query(
        summarySql +
        `
          SELECT COUNT(*)::INTEGER AS total
          FROM customer_summary
          WHERE (
            $2::text = ''
            OR COALESCE(customer_name, '') ILIKE '%' || $2 || '%'
            OR COALESCE(phone, '') ILIKE '%' || $2 || '%'
          )
          AND (
            $3::text = ''
            OR ($3 = 'active' AND access_active = TRUE)
            OR ($3 = 'inactive' AND access_active = FALSE)
          )
        `,
        [selectedOrg.id, search, access]
      );

      total = countResult.rows[0]?.total || 0;
      const paginationPreview = buildPagination({
        page,
        total,
        basePath: '/admin/customers'
      });
      const offset = (paginationPreview.page - 1) * ADMIN_PAGE_SIZE;

      customers = (
        await pool.query(
          summarySql +
          `
            SELECT *
            FROM customer_summary
            WHERE (
              $2::text = ''
              OR COALESCE(customer_name, '') ILIKE '%' || $2 || '%'
              OR COALESCE(phone, '') ILIKE '%' || $2 || '%'
            )
            AND (
              $3::text = ''
              OR ($3 = 'active' AND access_active = TRUE)
              OR ($3 = 'inactive' AND access_active = FALSE)
            )
            ORDER BY last_seen DESC
            LIMIT $4 OFFSET $5
          `,
          [selectedOrg.id, search, access, ADMIN_PAGE_SIZE, offset]
        )
      ).rows;
    }

    const accessOptions = [
      { value: '', label: req.t('common.all') },
      { value: 'active', label: req.t('customers.accessActive') },
      { value: 'inactive', label: req.t('customers.accessExpired') }
    ].map((option) => ({
      ...option,
      selected: option.value === access
    }));

    const pagination = buildPagination({
      page,
      total,
      basePath: '/admin/customers',
      query: {
        org: selectedOrg?.id,
        search,
        access
      }
    });

    return renderAdmin(req, res, 'admin/customers', {
      titleKey: 'customers.title',
      organizations,
      selectedOrg,
      customers,
      accessOptions,
      filters: {
        search,
        access
      },
      pagination
    });
  } catch (error) {
    console.error('ADMIN CUSTOMERS ERROR:', error);
    res.status(500).send('Unable to load customers.');
  }
});

router.get('/live-clients', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);
    const page = getPage(req.query.page);

    const linkedSites = selectedOrg
      ? (
          await pool.query(
            `
              SELECT
                id,
                name,
                external_portal_site_id
              FROM sites
              WHERE organization_id = $1
                AND active = TRUE
                AND external_portal_site_id IS NOT NULL
              ORDER BY name
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    const requestedSiteId = Number(req.query.siteId);
    const selectedSite =
      linkedSites.find((site) => Number(site.id) === requestedSiteId) ||
      linkedSites[0] ||
      null;

    const siteOptions = linkedSites.map((site) => ({
      ...site,
      selected: selectedSite && Number(site.id) === Number(selectedSite.id)
    }));

    let clients = [];
    let error = null;
    let pagination = buildPagination({
      page: 1,
      total: 0,
      basePath: '/admin/live-clients',
      query: {
        org: selectedOrg?.id,
        siteId: selectedSite?.id
      }
    });

    if (selectedSite) {
      try {
        const result = await omada.listClients({
          siteId: selectedSite.external_portal_site_id,
          page,
          pageSize: ADMIN_PAGE_SIZE
        });

        clients = result.rows.map(normalizeLiveClient);

        const inferredTotal =
          result.total ??
          (
            (page - 1) * ADMIN_PAGE_SIZE +
            clients.length +
            (clients.length === ADMIN_PAGE_SIZE ? 1 : 0)
          );

        pagination = buildPagination({
          page,
          total: inferredTotal,
          basePath: '/admin/live-clients',
          query: {
            org: selectedOrg.id,
            siteId: selectedSite.id
          }
        });
      } catch (omadaError) {
        console.error('ADMIN LIVE CLIENTS OMADA ERROR:', omadaError);
        error = req.t('live.unavailable');
      }
    }

    return renderAdmin(req, res, 'admin/live-clients', {
      titleKey: 'live.title',
      organizations,
      selectedOrg,
      selectedSite,
      siteOptions,
      clients,
      pagination,
      error
    });
  } catch (error) {
    console.error('ADMIN LIVE CLIENTS ERROR:', error);
    res.status(500).send('Unable to load live clients.');
  }
});

const loadWalletPageData = async ({
  selectedOrg,
  payoutPage = 1
}) => {
  if (!selectedOrg) {
    return {
      wallet: {
        available_balance: 0,
        ledger_balance: 0,
        reserved_balance: 0,
        gateway_fees: 0,
        platform_fees: 0,
        payout_fees: 0,
        paid_out: 0,
        entries: 0
      },
      settlement: {
        gross_collected: 0,
        net_collected: 0,
        unreconciled_payments: 0
      },
      payouts: [],
      payoutPagination: buildPagination({
        page: 1,
        total: 0,
        basePath: '/admin/wallet',
        pageParam: 'payoutPage'
      })
    };
  }

  const [
    walletResult,
    reserveResult,
    settlementResult,
    payoutCountResult
  ] = await Promise.all([
    pool.query(
      `
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN entry_type = 'adjustment' AND amount_tzs > 0 THEN 0
                ELSE amount_tzs
              END
            ),
            0
          )::NUMERIC(18,2) AS ledger_balance,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'gateway_fee'),
            0
          )::NUMERIC(18,2) AS gateway_fees,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'platform_fee'),
            0
          )::NUMERIC(18,2) AS platform_fees,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'payout_debit'),
            0
          )::NUMERIC(18,2) AS paid_out,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'payout_fee'),
            0
          )::NUMERIC(18,2) AS payout_fees,
          COUNT(*)::INTEGER AS entries
        FROM wallet_entries
        WHERE organization_id = $1
      `,
      [selectedOrg.id]
    ),
    pool.query(
      `
        SELECT
          COALESCE(SUM(total_amount_tzs), 0)::NUMERIC(18,2) AS reserved_balance
        FROM payout_transactions
        WHERE organization_id = $1
          AND status IN ('pending', 'processing')
      `,
      [selectedOrg.id]
    ),
    pool.query(
      `
        SELECT
          COALESCE(
            SUM(amount_tzs) FILTER (WHERE status = 'paid'),
            0
          )::NUMERIC(18,2) AS gross_collected,
          COALESCE(
            SUM(net_amount_tzs) FILTER (
              WHERE status = 'paid'
                AND net_amount_tzs IS NOT NULL
            ),
            0
          )::NUMERIC(18,2) AS net_collected,
          COUNT(*) FILTER (
            WHERE status = 'paid'
              AND (
                gateway_fee_tzs IS NULL
                OR net_amount_tzs IS NULL
              )
          )::INTEGER AS unreconciled_payments
        FROM payment_transactions
        WHERE organization_id = $1
      `,
      [selectedOrg.id]
    ),
    pool.query(
      `
        SELECT COUNT(*)::INTEGER AS total
        FROM payout_transactions
        WHERE organization_id = $1
      `,
      [selectedOrg.id]
    )
  ]);

  const ledgerBalance = Number(
    walletResult.rows[0]?.ledger_balance || 0
  );
  const reservedBalance = Number(
    reserveResult.rows[0]?.reserved_balance || 0
  );
  const payoutTotal = Number(
    payoutCountResult.rows[0]?.total || 0
  );

  const payoutPagination = buildPagination({
    page: payoutPage,
    total: payoutTotal,
    basePath: '/admin/wallet',
    pageParam: 'payoutPage',
    query: {
      org: selectedOrg.id
    }
  });

  const payoutOffset =
    (payoutPagination.page - 1) * ADMIN_PAGE_SIZE;

  const payoutResult = await pool.query(
    `
      SELECT
        id,
        reference,
        provider_reference,
        recipient_phone,
        recipient_name,
        network,
        amount_tzs,
        fee_tzs,
        total_amount_tzs,
        status,
        created_at,
        paid_at,
        failed_at,
        cancelled_at
      FROM payout_transactions
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [selectedOrg.id, ADMIN_PAGE_SIZE, payoutOffset]
  );

  return {
    wallet: {
      ...walletResult.rows[0],
      ledger_balance: ledgerBalance,
      reserved_balance: reservedBalance,
      available_balance: ledgerBalance - reservedBalance
    },
    settlement: settlementResult.rows[0],
    payouts: payoutResult.rows,
    payoutPagination
  };
};

const buildPayoutNetworkOptions = (selectedNetwork = 'MPESA') =>
  mobileMoneyNetworks.map((network) => ({
    ...network,
    selected: network.value === selectedNetwork
  }));

const renderWalletPage = async (req, res, {
  organizations,
  selectedOrg,
  withdrawalPreview = null,
  withdrawalForm = null,
  withdrawalRequestKey = null,
  withdrawalError = null,
  withdrawalSuccess = false
}) => {
  const pageData = await loadWalletPageData({
    selectedOrg,
    payoutPage: getPage(req.query.payoutPage)
  });

  return renderAdmin(req, res, 'admin/wallet', {
    titleKey: 'wallet.title',
    organizations,
    selectedOrg,
    ...pageData,
    withdrawalPreview,
    withdrawalForm,
    withdrawalRequestKey,
    withdrawalError,
    withdrawalSuccess,
    payoutNetworks: buildPayoutNetworkOptions(
      withdrawalPreview?.network ||
      withdrawalForm?.network ||
      'MPESA'
    )
  });
};

router.get('/wallet', async (req, res) => {
  try {
    const { organizations, selectedOrg } =
      await getSelectedOrganization(req);

    return renderWalletPage(req, res, {
      organizations,
      selectedOrg,
      withdrawalSuccess:
        String(req.query.withdrawal || '') === 'requested'
    });
  } catch (error) {
    console.error('ADMIN WALLET ERROR:', error);
    res.status(500).send('Unable to load wallet.');
  }
});

router.post('/wallet/withdraw/verify', async (req, res) => {
  try {
    const { organizations, selectedOrg } =
      await getSelectedOrganization(req);

    if (!selectedOrg) {
      return res.status(400).send('Select a client first.');
    }

    const withdrawalForm = {
      phone: String(req.body.phone || '').trim(),
      network: String(req.body.network || 'MPESA').trim(),
      amountTzs: String(req.body.amountTzs || '').trim()
    };

    try {
      const preview = await previewMobileMoneyPayout({
        phone: withdrawalForm.phone,
        network: withdrawalForm.network,
        amountTzs: withdrawalForm.amountTzs
      });

      const pageData = await loadWalletPageData({
        selectedOrg,
        payoutPage: 1
      });

      if (
        Number(pageData.wallet.available_balance) <
        Number(preview.totalAmountTzs)
      ) {
        return renderAdmin(req, res, 'admin/wallet', {
          titleKey: 'wallet.title',
          organizations,
          selectedOrg,
          ...pageData,
          withdrawalForm,
          withdrawalPreview: null,
          withdrawalError: req.t('wallet.insufficient'),
          withdrawalSuccess: false,
          payoutNetworks: buildPayoutNetworkOptions(
            withdrawalForm.network
          )
        });
      }

      return renderAdmin(req, res, 'admin/wallet', {
        titleKey: 'wallet.title',
        organizations,
        selectedOrg,
        ...pageData,
        withdrawalForm,
        withdrawalPreview: preview,
        withdrawalRequestKey: crypto.randomBytes(12).toString('hex'),
        withdrawalError: null,
        withdrawalSuccess: false,
        payoutNetworks: buildPayoutNetworkOptions(
          preview.network
        )
      });
    } catch (error) {
      console.error('ADMIN PAYOUT VERIFY ERROR:', error);

      return renderWalletPage(req, res, {
        organizations,
        selectedOrg,
        withdrawalForm,
        withdrawalError: error.message
      });
    }
  } catch (error) {
    console.error('ADMIN PAYOUT VERIFY PAGE ERROR:', error);
    res.status(500).send('Unable to verify withdrawal.');
  }
});

router.post('/wallet/withdraw/confirm', async (req, res) => {
  try {
    const { organizations, selectedOrg } =
      await getSelectedOrganization(req);

    if (!selectedOrg) {
      return res.status(400).send('Select a client first.');
    }

    const phone = String(req.body.phone || '').trim();
    const network = String(req.body.network || 'MPESA').trim();
    const amountTzs = String(req.body.amountTzs || '').trim();
    const requestKey = String(req.body.requestKey || '')
      .trim()
      .toLowerCase();

    if (!/^[a-f0-9]{24}$/.test(requestKey)) {
      return renderWalletPage(req, res, {
        organizations,
        selectedOrg,
        withdrawalForm: {
          phone,
          network,
          amountTzs
        },
        withdrawalError: req.t('wallet.previewExpired')
      });
    }

    const reference =
      'WDL-' +
      selectedOrg.id +
      '-' +
      requestKey.toUpperCase();

    try {
      await requestMobileMoneyPayout({
        organizationId: selectedOrg.id,
        requestedByUserId: req.authUser?.id,
        reference,
        phone,
        network,
        amountTzs,
        remarks: 'Solidus WiFi wallet withdrawal'
      });

      return res.redirect(
        '/admin/wallet?org=' +
        encodeURIComponent(selectedOrg.id) +
        '&withdrawal=requested'
      );
    } catch (error) {
      console.error('ADMIN PAYOUT REQUEST ERROR:', error);

      const withdrawalError =
        error.code === 'INSUFFICIENT_WALLET_BALANCE'
          ? req.t('wallet.insufficient')
          : req.t('wallet.withdrawalFailed') + ' ' + error.message;

      return renderWalletPage(req, res, {
        organizations,
        selectedOrg,
        withdrawalForm: {
          phone,
          network,
          amountTzs
        },
        withdrawalError
      });
    }
  } catch (error) {
    console.error('ADMIN PAYOUT CONFIRM PAGE ERROR:', error);
    res.status(500).send('Unable to submit withdrawal.');
  }
});

module.exports = router;
