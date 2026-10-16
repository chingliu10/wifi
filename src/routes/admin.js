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
  createClientOwner
} = require('../services/auth-service');
const omada = require('../services/omada/open-api-client');
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

const router = express.Router();

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

const renderAdmin = (req, res, view, data) =>
  res.render(view, {
    layout: 'admin',
    title: data.title || 'Solidus WiFi',
    currentUser: req.authUser,
    isSuperAdmin: req.authUser?.role === 'super_admin',
    isClientOwner: req.authUser?.role === 'client_owner',
    ...data
  });

router.get('/login', async (req, res) => {
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
    title: 'Sign in'
  });
});

router.post('/login', async (req, res) => {
  try {
    const user = await authenticateUser({
      username: req.body.username,
      password: req.body.password
    });

    if (!user) {
      return res.status(401).render('admin/login', {
        layout: 'auth',
        title: 'Sign in',
        username: String(req.body.username || '').trim(),
        error: 'Username or password is incorrect.'
      });
    }

    const token = await createSession(user.id);
    setSessionCookie(req, res, token);

    res.redirect('/admin');
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error);

    res.status(500).render('admin/login', {
      layout: 'auth',
      title: 'Sign in',
      username: String(req.body.username || '').trim(),
      error: 'Unable to sign in right now.'
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

router.get('/', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return renderAdmin(req, res, 'admin/dashboard', {
        title: 'Dashboard',
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
            p.name AS package_name,
            s.name AS site_name
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
            COALESCE(SUM(amount_tzs), 0)::NUMERIC(18,2) AS available_balance,
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
      title: 'Dashboard',
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
      checklist: [
        { label: 'Create your first site', done: setup.has_site },
        { label: 'Add a router / access point', done: setup.has_device },
        { label: 'Set packages and prices', done: setup.has_package },
        { label: 'Brand the customer portal', done: setup.has_branding },
        { label: 'Receive the first payment', done: setup.has_payment }
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
      ownerPassword
    } = req.body;

    const orgName = String(organizationName || '').trim();
    const contactName = String(ownerName || '').trim();

    if (!orgName || !contactName || !ownerUsername || !ownerPassword) {
      return res.status(400).send(
        'Business name, owner name, owner username and owner password are required.'
      );
    }

    if (String(ownerPassword).length < 8) {
      return res.status(400).send('Owner password must be at least 8 characters.');
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
        claims: claims.filter(
          (claim) => Number(claim.site_id) === Number(site.id)
        )
      });
    }

    const devices = selectedOrg
      ? (
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
              WHERE s.organization_id = $1
              ORDER BY s.name, nd.name
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    return renderAdmin(req, res, 'admin/sites', {
      title: 'Sites & devices',
      organizations,
      selectedOrg,
      sites: siteViews,
      devices,
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
        ).rows
      : [];

    const packages = selectedOrg
      ? (
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
              WHERE s.organization_id = $1
                AND p.deleted_at IS NULL
              ORDER BY s.name, p.sort_order, p.id
            `,
            [selectedOrg.id]
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
        })
      : [];

    return renderAdmin(req, res, 'admin/packages', {
      title: 'Packages',
      organizations,
      selectedOrg,
      sites,
      packages
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
          updated_at = NOW()
        FROM sites s
        WHERE p.id = $1
          AND p.deleted_at IS NULL
          AND s.id = p.site_id
          AND s.organization_id = $2
        RETURNING p.id
      `,
      [packageId, selectedOrg.id]
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

    const payments = selectedOrg
      ? (
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
                p.name AS package_name,
                s.id AS site_id,
                s.name AS site_name
              FROM payment_transactions pt
              JOIN packages p ON p.id = pt.package_id
              JOIN sites s ON s.id = p.site_id
              WHERE pt.organization_id = $1
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
              ORDER BY pt.created_at DESC
              LIMIT 250
            `,
            [
              selectedOrg.id,
              status,
              siteId,
              search,
              dateFrom,
              dateTo
            ]
          )
        ).rows
      : [];

    const statusOptions = [
      { value: '', label: 'All statuses' },
      { value: 'paid', label: 'Paid' },
      { value: 'pending', label: 'Pending' },
      { value: 'failed', label: 'Failed' },
      { value: 'cancelled', label: 'Cancelled' },
      { value: 'expired', label: 'Expired' }
    ].map((option) => ({
      ...option,
      selected: option.value === status
    }));

    return renderAdmin(req, res, 'admin/payments', {
      title: 'Payments',
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
      payments
    });
  } catch (error) {
    console.error('ADMIN PAYMENTS ERROR:', error);
    res.status(500).send('Unable to load payments.');
  }
});

router.get('/customers', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    const customers = selectedOrg
      ? (
          await pool.query(
            `
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
                  SELECT p.name
                  FROM payment_transactions latest_pt
                  JOIN packages p ON p.id = latest_pt.package_id
                  WHERE latest_pt.organization_id = $1
                    AND latest_pt.device_id = pt.device_id
                    AND latest_pt.status = 'paid'
                  ORDER BY
                    latest_pt.paid_at DESC NULLS LAST,
                    latest_pt.created_at DESC
                  LIMIT 1
                ) AS latest_package
              FROM payment_transactions pt
              WHERE pt.organization_id = $1
              GROUP BY pt.device_id
              ORDER BY last_seen DESC
              LIMIT 100
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    return renderAdmin(req, res, 'admin/customers', {
      title: 'Customers',
      organizations,
      selectedOrg,
      customers
    });
  } catch (error) {
    console.error('ADMIN CUSTOMERS ERROR:', error);
    res.status(500).send('Unable to load customers.');
  }
});

router.get('/wallet', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    const wallet = selectedOrg
      ? (
          await pool.query(
            `
              SELECT
                COALESCE(SUM(amount_tzs), 0)::NUMERIC(18,2) AS available_balance,
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
                COUNT(*)::INTEGER AS entries
              FROM wallet_entries
              WHERE organization_id = $1
            `,
            [selectedOrg.id]
          )
        ).rows[0]
      : {
          available_balance: 0,
          gateway_fees: 0,
          platform_fees: 0,
          paid_out: 0,
          entries: 0
        };

    const settlement = selectedOrg
      ? (
          await pool.query(
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
          )
        ).rows[0]
      : {
          gross_collected: 0,
          net_collected: 0,
          unreconciled_payments: 0
        };

    return renderAdmin(req, res, 'admin/wallet', {
      title: 'Wallet & payouts',
      organizations,
      selectedOrg,
      wallet,
      settlement
    });
  } catch (error) {
    console.error('ADMIN WALLET ERROR:', error);
    res.status(500).send('Unable to load wallet.');
  }
});

module.exports = router;
