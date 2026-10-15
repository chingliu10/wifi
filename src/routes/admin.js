const express = require('express');
const crypto = require('crypto');
const pool = require('../config/database');
const { normalizeMacAddress } = require('../utils/mac-address');

const router = express.Router();

const safeCompare = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
};

const requireAdmin = (req, res, next) => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    return res.status(503).send('Admin dashboard is not configured.');
  }

  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Solidus WiFi"');
    return res.status(401).send('Authentication required.');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const suppliedUser = separator === -1 ? decoded : decoded.slice(0, separator);
  const suppliedPassword = separator === -1 ? '' : decoded.slice(separator + 1);

  if (
    !safeCompare(suppliedUser, username) ||
    !safeCompare(suppliedPassword, password)
  ) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Solidus WiFi"');
    return res.status(401).send('Invalid credentials.');
  }

  next();
};

router.use(requireAdmin);

const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

const getOrganizations = async () => {
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
    ORDER BY name
  `);

  return result.rows;
};

const getSelectedOrganization = async (req) => {
  const organizations = await getOrganizations();

  if (!organizations.length) {
    return { organizations, selectedOrg: null };
  }

  const requestedId = Number(req.query.org || req.body?.organizationId);
  const selectedOrg =
    organizations.find((org) => Number(org.id) === requestedId) ||
    organizations[0];

  const options = organizations.map((org) => ({
    ...org,
    selected: Number(org.id) === Number(selectedOrg.id)
  }));

  return { organizations: options, selectedOrg };
};

const renderAdmin = (res, view, data) =>
  res.render(view, {
    layout: 'admin',
    title: data.title || 'Solidus WiFi',
    ...data
  });

router.get('/', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

    if (!selectedOrg) {
      return renderAdmin(res, 'admin/dashboard', {
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
            (SELECT COUNT(*) FROM sites WHERE organization_id = $1 AND active = true)::INTEGER AS sites,
            (
              SELECT COUNT(*)
              FROM network_devices nd
              JOIN sites s ON s.id = nd.site_id
              WHERE s.organization_id = $1
                AND nd.active = true
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
              SELECT 1 FROM sites WHERE organization_id = $1
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
                AND p.active = true
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

    return renderAdmin(res, 'admin/dashboard', {
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

router.get('/clients/new', async (req, res) => {
  const organizations = await getOrganizations();

  return renderAdmin(res, 'admin/client-new', {
    title: 'Add client',
    organizations,
    selectedOrg: null
  });
});

router.post('/clients', async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      organizationName,
      ownerName,
      ownerPhone,
      siteName,
      supportPhone,
      primaryColor
    } = req.body;

    const orgName = String(organizationName || '').trim();
    const site = String(siteName || '').trim();

    if (!orgName || !site) {
      return res.status(400).send('Client name and site name are required.');
    }

    const baseSlug = slugify(orgName) || 'client';
    const suffix = crypto.randomBytes(2).toString('hex');
    const orgSlug = `${baseSlug}-${suffix}`;
    const siteSlug = `${slugify(site) || 'site'}-${suffix}`;

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
      [orgName, orgSlug, ownerName || null, ownerPhone || null]
    );

    const organization = orgResult.rows[0];

    const siteResult = await client.query(
      `
        INSERT INTO sites (
          organization_id,
          name,
          slug,
          brand_name,
          support_phone,
          primary_color
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        organization.id,
        site,
        siteSlug,
        orgName + ' WiFi',
        supportPhone || ownerPhone || null,
        primaryColor || '#0B6B47'
      ]
    );

    const createdSite = siteResult.rows[0];

    await client.query(
      `
        INSERT INTO packages (
          site_id,
          name,
          price_tzs,
          duration_seconds,
          sort_order
        )
        VALUES
          ($1, '7 Hours', 500, 25200, 1),
          ($1, '24 Hours', 1000, 86400, 2),
          ($1, '30 Days', 9000, 2592000, 3)
      `,
      [createdSite.id]
    );

    await client.query('COMMIT');

    res.redirect('/admin?org=' + organization.id);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ADMIN CREATE CLIENT ERROR:', error);
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

    return renderAdmin(res, 'admin/sites', {
      title: 'Sites & devices',
      organizations,
      selectedOrg,
      sites,
      devices
    });
  } catch (error) {
    console.error('ADMIN SITES ERROR:', error);
    res.status(500).send('Unable to load sites.');
  }
});

router.post('/devices', async (req, res) => {
  try {
    const {
      organizationId,
      siteId,
      name,
      brand,
      model,
      apMac,
      nasIdentifier,
      managementIp,
      deviceType
    } = req.body;

    const orgId = Number(organizationId);
    const selectedSiteId = Number(siteId);
    const normalizedApMac = normalizeMacAddress(apMac);

    if (!orgId || !selectedSiteId || !name || !normalizedApMac) {
      return res.status(400).send('Site, device name and valid AP MAC are required.');
    }

    const siteResult = await pool.query(
      `
        SELECT id
        FROM sites
        WHERE id = $1
          AND organization_id = $2
          AND active = true
        LIMIT 1
      `,
      [selectedSiteId, orgId]
    );

    if (!siteResult.rows[0]) {
      return res.status(400).send('The selected site does not belong to this client.');
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

    res.redirect('/admin/sites?org=' + orgId);
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

router.get('/packages', async (req, res) => {
  try {
    const { organizations, selectedOrg } = await getSelectedOrganization(req);

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

    return renderAdmin(res, 'admin/packages', {
      title: 'Packages',
      organizations,
      selectedOrg,
      packages
    });
  } catch (error) {
    console.error('ADMIN PACKAGES ERROR:', error);
    res.status(500).send('Unable to load packages.');
  }
});

router.post('/packages/:id', async (req, res) => {
  try {
    const packageId = Number(req.params.id);
    const organizationId = Number(req.body.organizationId);
    const priceTzs = Number(req.body.priceTzs);
    const active = req.body.active === 'on';

    if (!packageId || !organizationId || !Number.isInteger(priceTzs) || priceTzs <= 0) {
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
      [priceTzs, active, packageId, organizationId]
    );

    res.redirect('/admin/packages?org=' + organizationId);
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

    return renderAdmin(res, 'admin/payments', {
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
                MAX(pt.customer_name) FILTER (WHERE pt.customer_name IS NOT NULL) AS customer_name,
                MAX(pt.phone) AS phone,
                COUNT(*) FILTER (WHERE pt.status = 'paid')::INTEGER AS paid_orders,
                COALESCE(SUM(pt.amount_tzs) FILTER (WHERE pt.status = 'paid'), 0)::BIGINT AS total_spent,
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

    return renderAdmin(res, 'admin/customers', {
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

    return renderAdmin(res, 'admin/wallet', {
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
