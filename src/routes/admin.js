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
            )::BIGINT AS collected_total
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
          SELECT COALESCE(SUM(amount_tzs), 0)::BIGINT AS ledger_balance
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
        ledger_balance: walletResult.rows[0].ledger_balance
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
                s.active,
                COUNT(nd.id)::INTEGER AS device_count
              FROM sites s
              LEFT JOIN network_devices nd ON nd.site_id = s.id
              WHERE s.organization_id = $1
              GROUP BY s.id
              ORDER BY s.name
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    const sitesWithKeys = await ensurePortalKeys(sites);
    const publicBaseUrl = getPublicBaseUrl(req);

    const siteViews = sitesWithKeys.map((site) => ({
      ...site,
      setup_url: `${publicBaseUrl}/portal/setup/${site.portal_key}`,
      omada_connected: Boolean(site.external_portal_site_id)
    }));

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
      devices
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

    await pool.query(
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

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN SITE CREATE ERROR:', error);

    if (error.code === '23505') {
      return res.status(409).send('Unable to create a unique portal setup link. Please retry.');
    }

    res.status(500).send('Unable to create site.');
  }
});

router.post('/devices', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return res.status(400).send('Create or select a client first.');
    }

    const {
      siteId,
      name,
      brand,
      model,
      apMac,
      nasIdentifier,
      managementIp,
      deviceType
    } = req.body;

    const selectedSiteId = Number(siteId);
    const normalizedApMac = normalizeMacAddress(apMac);

    if (!selectedSiteId || !name || !normalizedApMac) {
      return res.status(400).send(
        'Site, device name and valid AP MAC are required.'
      );
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
      [selectedSiteId, selectedOrg.id]
    );

    if (!siteResult.rows[0]) {
      return res.status(400).send(
        'The selected site does not belong to this client.'
      );
    }

    await pool.query(
      `
        INSERT INTO network_devices (
          site_id,
          name,
          nas_identifier,
          brand,
          model,
          management_ip,
          ap_mac,
          device_type,
          active
        )
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::inet, $7, $8, TRUE)
        ON CONFLICT (site_id, nas_identifier)
        DO UPDATE SET
          name = EXCLUDED.name,
          brand = EXCLUDED.brand,
          model = EXCLUDED.model,
          management_ip = EXCLUDED.management_ip,
          ap_mac = EXCLUDED.ap_mac,
          device_type = EXCLUDED.device_type,
          active = TRUE,
          updated_at = NOW()
      `,
      [
        selectedSiteId,
        String(name).trim(),
        String(nasIdentifier || normalizedApMac).trim(),
        String(brand || '').trim() || null,
        String(model || '').trim() || null,
        String(managementIp || '').trim(),
        normalizedApMac,
        String(deviceType || 'omada').trim().toLowerCase()
      ]
    );

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN DEVICE CREATE ERROR:', error);

    if (error.code === '23505') {
      return res.status(409).send('That AP MAC / NAS is already registered.');
    }

    if (error.code === '22P02') {
      return res.status(400).send('Management IP address is invalid.');
    }

    res.status(500).send('Unable to register network device.');
  }
});

router.post('/devices/:id/delete', async (req, res) => {
  try {
    const { selectedOrg } = await getSelectedOrganization(req);
    const deviceId = Number(req.params.id);

    if (!selectedOrg || !deviceId) {
      return res.status(400).send('Invalid device.');
    }

    await pool.query(
      `
        DELETE FROM network_devices nd
        USING sites s
        WHERE nd.id = $1
          AND s.id = nd.site_id
          AND s.organization_id = $2
      `,
      [deviceId, selectedOrg.id]
    );

    res.redirect('/admin/sites?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN DEVICE DELETE ERROR:', error);
    res.status(500).send('Unable to remove network device.');
  }
});

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
              ORDER BY s.name, p.sort_order, p.id
            `,
            [selectedOrg.id]
          )
        ).rows
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
      hours: 3600,
      days: 86400
    };

    const multiplier = multipliers[durationUnit];
    const durationSeconds = durationValue * multiplier;

    if (
      !siteId ||
      !packageName ||
      !Number.isInteger(priceTzs) ||
      priceTzs <= 0 ||
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
    const priceTzs = Number(req.body.priceTzs);
    const active = req.body.active === 'on';

    if (
      !selectedOrg ||
      !packageId ||
      !Number.isInteger(priceTzs) ||
      priceTzs <= 0
    ) {
      return res.status(400).send('Invalid package update.');
    }

    await pool.query(
      `
        UPDATE packages p
        SET
          price_tzs = $1,
          active = $2,
          updated_at = NOW()
        FROM sites s
        WHERE p.id = $3
          AND s.id = p.site_id
          AND s.organization_id = $4
      `,
      [priceTzs, active, packageId, selectedOrg.id]
    );

    res.redirect('/admin/packages?org=' + selectedOrg.id);
  } catch (error) {
    console.error('ADMIN PACKAGE UPDATE ERROR:', error);
    res.status(500).send('Unable to update package.');
  }
});

router.get('/payments', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    const payments = selectedOrg
      ? (
          await pool.query(
            `
              SELECT
                pt.reference,
                pt.customer_name,
                pt.phone,
                pt.amount_tzs,
                pt.status,
                pt.provider,
                pt.created_at,
                pt.paid_at,
                p.name AS package_name,
                s.name AS site_name
              FROM payment_transactions pt
              JOIN packages p ON p.id = pt.package_id
              JOIN sites s ON s.id = p.site_id
              WHERE pt.organization_id = $1
              ORDER BY pt.created_at DESC
              LIMIT 100
            `,
            [selectedOrg.id]
          )
        ).rows
      : [];

    return renderAdmin(req, res, 'admin/payments', {
      title: 'Payments',
      organizations,
      selectedOrg,
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
                MAX(pt.customer_name) FILTER (
                  WHERE pt.customer_name IS NOT NULL
                ) AS customer_name,
                MAX(pt.phone) AS phone,
                COUNT(*) FILTER (
                  WHERE pt.status = 'paid'
                )::INTEGER AS paid_orders,
                COALESCE(
                  SUM(pt.amount_tzs) FILTER (
                    WHERE pt.status = 'paid'
                  ),
                  0
                )::BIGINT AS total_spent,
                MAX(pt.created_at) AS last_seen
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
                COALESCE(SUM(amount_tzs), 0)::BIGINT AS ledger_balance,
                COUNT(*)::INTEGER AS entries
              FROM wallet_entries
              WHERE organization_id = $1
            `,
            [selectedOrg.id]
          )
        ).rows[0]
      : { ledger_balance: 0, entries: 0 };

    const collected = selectedOrg
      ? (
          await pool.query(
            `
              SELECT COALESCE(SUM(amount_tzs), 0)::BIGINT AS total
              FROM payment_transactions
              WHERE organization_id = $1
                AND status = 'paid'
            `,
            [selectedOrg.id]
          )
        ).rows[0].total
      : 0;

    return renderAdmin(req, res, 'admin/wallet', {
      title: 'Wallet & payouts',
      organizations,
      selectedOrg,
      wallet,
      collected
    });
  } catch (error) {
    console.error('ADMIN WALLET ERROR:', error);
    res.status(500).send('Unable to load wallet.');
  }
});

module.exports = router;
