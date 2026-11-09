const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const Handlebars = require('handlebars');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const pool = require('../src/config/database');
const { getSalesScope, hasSalesPermission, listSales, listVoucherIssuers, listCashierVouchers,
  getCashierActivity } = require('../src/services/sales-service');
const { getAccountingReport } = require('../src/services/accounting-service');
const { translate } = require('../src/i18n/admin');

test('sales permissions derive cashier and tenant scope from the authenticated account', async () => {
  const cashier = { id: 7, organization_id: 3, role: 'cashier', active: true };
  assert.deepEqual(getSalesScope(cashier, 999), { organizationId: 3, cashierUserId: 7 });
  assert.equal(hasSalesPermission(cashier, 'sales.view_organization'), false);
  assert.deepEqual(getSalesScope({ role: 'client_owner', organization_id: 3 }, 999),
    { organizationId: 3, cashierUserId: null });
  assert.deepEqual(getSalesScope({ role: 'super_admin' }, 9),
    { organizationId: 9, cashierUserId: null });
  for (const user of [null, { role: 'unknown' }, { ...cashier, active: false }, { role: 'cashier' }, { role: 'super_admin' }]) {
    assert.throws(() => getSalesScope(user), error => error.statusCode === 403);
  }
  await assert.rejects(listCashierVouchers({ user: { role: 'client_owner', organization_id: 3 } }),
    error => error.statusCode === 403);
  await assert.rejects(listVoucherIssuers({ user: cashier, organizationId: 999 }),
    error => error.statusCode === 403);
});

test('new reporting templates compile and have English and Swahili labels', () => {
  for (const file of ['sales.hbs', 'cashier-vouchers.hbs', 'cashier.hbs']) {
    const source = fs.readFileSync(path.join(__dirname, '../views/admin', file), 'utf8');
    assert.doesNotThrow(() => Handlebars.precompile(source));
    for (const match of source.matchAll(/\{\{t '([^']+)'/g)) {
      for (const language of ['en', 'sw']) {
        assert.notEqual(translate(language, match[1]), match[1], language + ': ' + match[1]);
      }
    }
  }
});

test('cashier report labels separate used sales and issued cash without owner payment controls', () => {
  for (const language of ['en', 'sw']) {
    const handlebars = Handlebars.create();
    handlebars.registerHelper('t', key => translate(language, key));
    handlebars.registerHelper('formatTzs', value => Number(value || 0).toLocaleString('en-US'));
    handlebars.registerHelper('formatDate', value => String(value || ''));
    handlebars.registerPartial('admin-pagination', '');
    const render = handlebars.compile(fs.readFileSync(path.join(__dirname, '../views/admin/sales.hbs'), 'utf8'));
    const context = {
      ownOnly: true, basePath: '/admin/cashier/report', filters: {},
      range: { startDate: '2026-11-08', endDate: '2026-11-08' },
      report: { total: 6, total_sales_tzs: 3500, voucher_sales_tzs: 3500, gateway_sales_tzs: 0 },
      activity: { issued_period: 8, expected_cash_period: 4500, waiting_today: 2, unused_value_tzs: 1000 },
      sales: [{ isVoucher: true, reference: 'V-121', code_last4: '7281', amount_tzs: 500,
        issued_by_name: 'Test cashier', package_name: 'Voucher package', receiptUrl: '/admin/cashier/sales/121' }]
    };
    const cashierHtml = render(context);
    assert.ok(cashierHtml.includes(translate(language, 'sales.usedSales')));
    assert.ok(cashierHtml.includes('6 ' + translate(language, 'sales.firstUsedInPeriod')));
    assert.ok(cashierHtml.includes(translate(language, 'sales.expectedVoucherCash')));
    assert.ok(cashierHtml.includes('8 ' + translate(language, 'sales.cashIssuedHint')));
    assert.ok(cashierHtml.includes('3,500'));
    assert.ok(cashierHtml.includes('4,500'));
    assert.ok(!cashierHtml.includes(translate(language, 'sales.source.gateway')));
    assert.doesNotMatch(cashierHtml, /name="(?:source|siteId|cashierId|issuerId|org)"/);

    const ownerHtml = render({ ...context, ownOnly: false, basePath: '/admin/sales',
      report: { total: 7, total_sales_tzs: 4500, voucher_sales_tzs: 3500, gateway_sales_tzs: 1000 } });
    assert.ok(ownerHtml.includes(translate(language, 'sales.totalSales')));
    assert.ok(ownerHtml.includes(translate(language, 'sales.source.gateway')));
    assert.ok(ownerHtml.includes(translate(language, 'sales.source.voucher')));
    assert.match(ownerHtml, /name="source"/);
    assert.match(ownerHtml, /name="issuerId"/);
    const adminHtml = render({ ...context, ownOnly: false, sales: [{ isVoucher: true,
      reference: 'AV-1', issued_by_name: 'Report admin', amount_tzs: 1000 }] });
    assert.ok(adminHtml.includes('Report admin'));
    const legacyHtml = render({ ...context, ownOnly: false, sales: [{ isVoucher: true,
      reference: 'AV-2', amount_tzs: 1000 }] });
    assert.ok(legacyHtml.includes(translate(language, 'vouchers.adminBatch')));
  }
});

test('sales reports isolate accounts and use first-redemption dates without changing issuance or wallet flows', {
  skip: testDatabaseUrl ? false : 'TEST_DATABASE_URL is required; no integration queries run against production'
}, async t => {
  const { createClientOwner, createCashier, createSession, hashPassword } = require('../src/services/auth-service');
  const { createCashierVoucherSale, redeemVoucher, voidCashierVoucherSale,
    createVoucherBatch, cancelVoucherBatch, getCashierVoucherSale, getCashierVoucherSalesSummary } = require('../src/services/vouchers/voucher-service');
  const { createPaymentTransaction } = require('../src/repositories/payment-transaction-repository');
  const suffix = crypto.randomBytes(7).toString('hex');
  const tenant = async name => {
    const org = (await pool.query(`INSERT INTO organizations
      (name, slug, vouchers_enabled, voucher_portal_enabled) VALUES ($1, $2, TRUE, TRUE) RETURNING *`,
    [name, name + suffix])).rows[0];
    const site = (await pool.query(`INSERT INTO sites (organization_id, name, slug)
      VALUES ($1, $2, $3) RETURNING *`, [org.id, name, name + suffix])).rows[0];
    const pkg = (await pool.query(`INSERT INTO packages (site_id, name, price_tzs, duration_seconds)
      VALUES ($1, 'Test hour', 1000, 3600) RETURNING *`, [site.id])).rows[0];
    const owner = await createClientOwner({ organizationId: org.id, fullName: name,
      username: name + suffix, password: 'Reporting123!' });
    return { org, site, pkg, owner };
  };
  const a = await tenant('sales-a');
  const b = await tenant('sales-b');
  const cashier = async (tenant, name) => createCashier({ organizationId: tenant.org.id,
    siteId: tenant.site.id, fullName: name, username: name + suffix, password: 'Reporting123!' });
  const ca = await cashier(a, 'cashier-a');
  const cb = await cashier(a, 'cashier-b');
  const cc = await cashier(b, 'cashier-c');
  const useVoucher = async (tenant, code, usedAt) => {
    const mac = '02:' + crypto.randomBytes(5).toString('hex').match(/../g).join(':');
    const device = (await pool.query('INSERT INTO devices (mac_address) VALUES ($1) RETURNING *', [mac])).rows[0];
    const request = { organizationId: tenant.org.id, siteId: tenant.site.id,
      deviceId: device.id, clientMac: mac, code };
    const result = await redeemVoucher(request);
    assert.equal((await redeemVoucher(request)).reused, true);
    await pool.query('UPDATE vouchers SET redeemed_at = $2 WHERE id = $1', [result.voucher.id, usedAt]);
    return result.voucher;
  };
  const makeVoucher = async (tenant, user, issuedAt, usedAt = null) => {
    const issued = await createCashierVoucherSale({ organizationId: tenant.org.id,
      siteId: tenant.site.id, packageId: tenant.pkg.id, cashierUserId: user.id,
      requestKey: crypto.randomUUID() });
    await pool.query('UPDATE voucher_sales SET issued_at = $2 WHERE id = $1', [issued.sale.id, issuedAt]);
    if (usedAt) await useVoucher(tenant, issued.code, usedAt);
    return issued;
  };
  const first = await makeVoucher(a, ca, '2026-11-07T18:00:00+03:00', '2026-11-08T00:05:00+03:00');
  const unused = await makeVoucher(a, ca, '2026-11-08T10:00:00+03:00');
  await makeVoucher(a, ca, '2026-11-07T17:00:00+03:00', '2026-11-07T23:59:59+03:00');
  await makeVoucher(a, ca, '2026-11-08T16:00:00+03:00', '2026-11-09T00:00:00+03:00');
  const voided = await makeVoucher(a, ca, '2026-11-08T11:00:00+03:00');
  await voidCashierVoucherSale({ cashierUserId: ca.id, saleId: voided.sale.id });
  const otherCashier = await makeVoucher(a, cb, '2026-11-07T18:00:00+03:00', '2026-11-08T09:00:00+03:00');
  await makeVoucher(b, cc, '2026-11-07T18:00:00+03:00', '2026-11-08T09:00:00+03:00');
  const gateway = async (tenant, status, knownFee) => {
    const reference = 'report-' + crypto.randomUUID();
    const mac = '02:' + crypto.randomBytes(5).toString('hex').match(/../g).join(':');
    const device = (await pool.query('INSERT INTO devices (mac_address) VALUES ($1) RETURNING *', [mac])).rows[0];
    const transaction = await createPaymentTransaction({ reference, customerName: 'Report customer',
      phone: '0712345678', packageId: tenant.pkg.id, clientMac: mac,
      deviceId: device.id, amountTzs: 1000, status, provider: 'mock' });
    await pool.query(`UPDATE payment_transactions SET created_at = '2026-11-07T12:00:00+03:00',
      paid_at = $2, gateway_fee_tzs = $3, net_amount_tzs = $4 WHERE id = $1`,
    [transaction.id, status === 'paid' ? '2026-11-08T00:01:00+03:00' : null,
      knownFee ? 15 : null, knownFee ? 985 : null]);
    return reference;
  };
  const gatewayReference = await gateway(a, 'paid', true);
  await gateway(a, 'paid', false);
  await gateway(a, 'pending', false);
  await gateway(a, 'failed', false);
  await gateway(b, 'paid', true);
  const period = { startDate: '2026-11-08', endDate: '2026-11-08' };
  let adminScenario;

  await t.test('cashier sees own first-use sales, including previous-day issues and local midnight', async () => {
    const result = await listSales({ user: ca, organizationId: b.org.id, cashierUserId: cb.id,
      source: 'gateway', ...period });
    assert.equal(result.total, 1);
    assert.equal(Number(result.total_sales_tzs), 1000);
    assert.equal(Number(result.sales[0].id), Number(first.sale.id));
    assert.equal(result.sales[0].source, 'voucher');
    assert.equal(Number(result.voucher_sales_tzs), 1000);
    assert.equal(Number(result.gateway_sales_tzs), 0);
    assert.equal('code' in result.sales[0], false);
    assert.equal('code_enc' in result.sales[0], false);
    const activity = await getCashierActivity({ user: ca, ...period });
    assert.equal(Number(activity.issued_period), 2);
    assert.equal(Number(activity.expected_cash_period), 2000);
    assert.equal(Number(activity.waiting_today), 1);
    assert.equal(Number(activity.unused_value_tzs), 1000);
    const cashSummary = await getCashierVoucherSalesSummary({ organizationId: a.org.id, ...period });
    assert.equal(Number(cashSummary.totals.redeemed_period), 2);
  });

  await t.test('cashier with no voucher sales gets zero even when gateway payments exist', async () => {
    const user = await cashier(a, 'cashier-empty');
    const result = await listSales({ user, source: 'gateway', ...period });
    assert.equal(result.total, 0);
    assert.equal(Number(result.total_sales_tzs), 0);
    assert.equal(Number(result.gateway_sales_tzs), 0);
    assert.deepEqual(result.sales, []);
  });

  await t.test('voucher history includes unused and voided records but no other cashier', async () => {
    const result = await listCashierVouchers({ user: ca, status: 'unused' });
    assert.equal(result.total, 1);
    assert.equal(Number(result.vouchers[0].id), Number(unused.sale.id));
    assert.equal((await listCashierVouchers({ user: ca, status: 'voided' })).total, 1);
    assert.equal(await getCashierVoucherSale({ cashierUserId: ca.id, saleId: otherCashier.sale.id }), null);
  });

  await t.test('owner combines paid gateway and redeemed vouchers exactly once within their tenant', async () => {
    const result = await listSales({ user: a.owner, organizationId: b.org.id, ...period });
    assert.equal(result.total, 4);
    assert.equal(Number(result.total_sales_tzs), 4000);
    assert.equal(Number(result.voucher_sales_tzs), 2000);
    assert.equal(Number(result.gateway_sales_tzs), 2000);
    assert.equal(Number(result.gateway_fees_tzs), 15);
    assert.equal(Number(result.unreconciled_count), 1);
    assert.equal((await listSales({ user: a.owner, source: 'gateway', ...period })).total, 2);
    assert.equal((await listSales({ user: a.owner, cashierUserId: cb.id, ...period })).total, 1);
    assert.equal((await listSales({ user: a.owner, search: gatewayReference, ...period })).total, 1);
    assert.equal((await listSales({ user: a.owner, siteId: b.site.id, ...period })).total, 0);
    const paged = await listSales({ user: a.owner, page: 999, pageSize: 2, ...period });
    assert.equal(paged.page, 2);
    assert.equal(paged.sales.length, 2);
    const empty = await listSales({ user: a.owner, startDate: '2020-01-01', endDate: '2020-01-01' });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.sales, []);
    const accounting = await getAccountingReport({ organizationId: a.org.id, ...period });
    assert.equal(accounting.summary.voucher_gross, 2000);
    assert.equal(accounting.summary.gateway_gross, 2000);
    assert.equal(accounting.summary.total_revenue, 4000);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS total FROM wallet_entries WHERE organization_id = $1', [a.org.id])).rows[0].total), 0);
  });

  await t.test('used admin vouchers join sales at saved prices, including past and unattributed batches', async () => {
    const business = await tenant('admin-sales');
    const foreign = await tenant('admin-foreign');
    const user = await cashier(business, 'admin-sales-cashier');
    const admin = (await pool.query(`INSERT INTO platform_users (role, full_name, username, password_hash)
      VALUES ('super_admin', 'Report administrator', $1, $2) RETURNING *`,
    ['report-admin-' + suffix, await hashPassword('Reporting123!')])).rows[0];
    const days = (await pool.query(`SELECT
      (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date::text AS today,
      ((NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date - 1)::text AS yesterday,
      ((NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date + 1)::text AS tomorrow`)).rows[0];
    const dates = { startDate: days.today, endDate: days.today };
    const batch = (account, creator, quantity = 1) => createVoucherBatch({
      organizationId: account.org.id, siteId: account.site.id, packageId: account.pkg.id,
      quantity, redeemableUntil: null, createdByUserId: creator?.id || null });
    const stock = await batch(business, business.owner, 5);
    await pool.query('UPDATE voucher_batches SET created_at = $2 WHERE id = $1',
      [stock.batch.id, days.yesterday + 'T18:00:00+03:00']);
    await pool.query('UPDATE vouchers SET created_at = $2 WHERE batch_id = $1',
      [stock.batch.id, days.yesterday + 'T18:00:00+03:00']);
    const beforeUse = await listSales({ user: business.owner, ...dates });
    assert.equal(beforeUse.total, 0);
    assert.equal(Number(beforeUse.total_sales_tzs), 0);
    const firstAdminVoucher = await useVoucher(business, stock.codes[0], days.today + 'T00:05:00+03:00');
    await useVoucher(business, stock.codes[1], days.today + 'T13:00:00+03:00');
    await useVoucher(business, stock.codes[2], days.yesterday + 'T23:59:59+03:00');
    await useVoucher(business, stock.codes[3], days.tomorrow + 'T00:00:00+03:00');
    const adminStock = await batch(business, admin);
    await useVoucher(business, adminStock.codes[0], days.today + 'T13:00:00+03:00');
    // Cancelling the remaining batch stock cannot erase an already-used voucher sale.
    await cancelVoucherBatch({ organizationId: business.org.id, batchId: adminStock.batch.id });
    const legacyStock = await batch(business, null);
    await useVoucher(business, legacyStock.codes[0], days.today + 'T13:00:00+03:00');
    const cancelled = await batch(business, business.owner);
    await cancelVoucherBatch({ organizationId: business.org.id, batchId: cancelled.batch.id });
    const expired = await batch(business, business.owner);
    await pool.query("UPDATE voucher_batches SET redeemable_until = NOW() - INTERVAL '1 day' WHERE id = $1", [expired.batch.id]);
    const foreignStock = await batch(foreign, foreign.owner);
    await useVoucher(foreign, foreignStock.codes[0], days.today + 'T13:00:00+03:00');
    const cashierVoucher = await makeVoucher(business, user, days.today + 'T12:00:00+03:00', days.today + 'T13:00:00+03:00');
    const reference = await gateway(business, 'paid', true);
    await pool.query('UPDATE payment_transactions SET paid_at = $2 WHERE reference = $1',
      [reference, days.today + 'T00:01:00+03:00']);
    await pool.query("UPDATE packages SET price_tzs = 9000, name = 'Changed package' WHERE id = $1", [business.pkg.id]);

    const report = await listSales({ user: business.owner, organizationId: foreign.org.id, ...dates });
    assert.equal(report.total, 6);
    assert.equal(Number(report.total_sales_tzs), 6000);
    assert.equal(Number(report.voucher_sales_tzs), 5000);
    assert.equal(Number(report.gateway_sales_tzs), 1000);
    const adminSales = report.sales.filter(sale => sale.reference.startsWith('AV-'));
    assert.equal(adminSales.length, 4);
    assert.ok(adminSales.every(sale => Number(sale.amount_tzs) === 1000 && sale.package_name === 'Test hour'));
    const first = adminSales.find(sale => Number(sale.voucher_id) === Number(firstAdminVoucher.id));
    assert.equal(first.issued_by_name, business.owner.full_name);
    assert.equal(Number(first.issued_by_user_id), Number(business.owner.id));
    assert.equal(first.cashier_user_id, null);
    assert.equal(first.cashier_name, null);
    assert.ok(adminSales.some(sale => Number(sale.issued_by_user_id) === Number(admin.id)));
    assert.ok(adminSales.some(sale => sale.issued_by_user_id === null));
    assert.equal((await pool.query('SELECT COUNT(*) AS total FROM voucher_sales WHERE organization_id = $1',
      [business.org.id])).rows[0].total, '1');
    adminScenario = { business, foreign, user, admin, dates, cashierVoucher, report };
  });

  await t.test('issuer filters include authorized admin creators while cashier scope stays personal', async () => {
    const { business, foreign, user, admin, dates, cashierVoucher } = adminScenario;
    const issuers = await listVoucherIssuers({ user: business.owner, organizationId: foreign.org.id });
    assert.deepEqual(issuers.map(issuer => Number(issuer.id)).sort((a, b) => a - b),
      [business.owner.id, user.id, admin.id].map(Number).sort((a, b) => a - b));
    const ownerSales = await listSales({ user: business.owner, issuerUserId: business.owner.id, ...dates });
    assert.equal(ownerSales.total, 2);
    assert.equal(Number(ownerSales.total_sales_tzs), 2000);
    assert.equal((await listSales({ user: business.owner, issuerUserId: admin.id, ...dates })).total, 1);
    assert.equal((await listSales({ user: admin, organizationId: business.org.id, ...dates })).total, 6);
    assert.equal((await listSales({ user: business.owner, search: admin.full_name, ...dates })).total, 1);
    assert.equal((await listSales({ user: business.owner, siteId: foreign.site.id, ...dates })).total, 0);
    const personal = await listSales({ user, issuerUserId: business.owner.id,
      organizationId: foreign.org.id, source: 'gateway', ...dates });
    assert.equal(personal.total, 1);
    assert.equal(Number(personal.total_sales_tzs), 1000);
    assert.equal(Number(personal.sales[0].id), Number(cashierVoucher.sale.id));
    const references = [];
    for (let page = 1; page <= 3; page++) {
      const result = await listSales({ user: business.owner, page, pageSize: 2, ...dates });
      assert.equal(result.total, 6);
      references.push(...result.sales.map(sale => sale.reference));
    }
    assert.equal(references.length, 6);
    assert.equal(new Set(references).size, 6);
  });

  await t.test('admin voucher sales match P&L, daily trends and site totals without changing wallet entries', async () => {
    const { business, dates } = adminScenario;
    const report = await getAccountingReport({ organizationId: business.org.id, ...dates });
    assert.equal(report.summary.voucher_gross, 5000);
    assert.equal(report.summary.gateway_gross, 1000);
    assert.equal(report.summary.total_revenue, 6000);
    assert.equal(report.trend.length, 1);
    assert.equal(report.trend[0].voucher, 5000);
    assert.equal(report.sites.find(site => Number(site.id) === Number(business.site.id)).voucher, 5000);
    assert.equal((await pool.query('SELECT COUNT(*) AS total FROM wallet_entries WHERE organization_id = $1',
      [business.org.id])).rows[0].total, '0');
  });

  await t.test('cashier dashboard and report separate 3500 used sales from 4500 issued cash and exclude gateway payments', async () => {
    const business = await tenant('dashboard-cash');
    const user = await cashier(business, 'dashboard-cashier');
    const smallPackage = (await pool.query(`INSERT INTO packages (site_id, name, price_tzs, duration_seconds)
      VALUES ($1, 'Small package', 500, 3600) RETURNING *`, [business.site.id])).rows[0];
    const small = { ...business, pkg: smallPackage };
    const now = new Date().toISOString();
    await makeVoucher(business, user, now, now);
    for (let i = 0; i < 5; i++) await makeVoucher(small, user, now, now);
    for (let i = 0; i < 2; i++) await makeVoucher(small, user, now);
    const reference = await gateway(business, 'paid', true);
    await pool.query('UPDATE payment_transactions SET paid_at = NOW() WHERE reference = $1', [reference]);
    const stats = await getCashierActivity({ user });
    assert.equal(Number(stats.issued_today), 8);
    assert.equal(Number(stats.expected_cash_today), 4500);
    assert.equal(Number(stats.redeemed_today), 6);
    assert.equal(Number(stats.used_sales_today_tzs), 3500);
    assert.equal(Number(stats.waiting_today), 2);
    const today = (await pool.query("SELECT (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date::text AS today")).rows[0].today;
    const report = await listSales({ user, organizationId: a.org.id, cashierUserId: ca.id,
      source: 'gateway', startDate: today, endDate: today });
    assert.equal(report.total, 6);
    assert.equal(Number(report.total_sales_tzs), 3500);
    assert.equal(Number(report.voucher_sales_tzs), 3500);
    assert.equal(Number(report.gateway_sales_tzs), 0);
    assert.equal(report.sales.length, 6);
    assert.ok(report.sales.every(sale => sale.source === 'voucher' && Number(sale.cashier_user_id) === Number(user.id)));
  });

  await t.test('authenticated routes keep forged tenant and cashier parameters inside the session scope', async () => {
    const express = require('express');
    const app = express();
    app.use((req, res, next) => {
      res.render = (view, data) => res.json({ view, sales: data.sales, vouchers: data.vouchers,
        total: data.report?.total, ownOnly: data.ownOnly, report: data.report, activity: data.activity,
        issuers: data.issuers, filters: data.filters });
      next();
    });
    app.use('/admin', require('../src/routes/admin'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const token = await createSession(ca.id);
    const headers = { cookie: 'solidus_session=' + token };
    const response = await fetch(origin + '/admin/cashier/report?range=custom&from=2026-11-08&to=2026-11-08&org=' + b.org.id + '&cashierId=' + cb.id + '&source=gateway', { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(body.ownOnly, true);
    assert.equal(Number(body.report.total_sales_tzs), 1000);
    assert.equal(Number(body.report.gateway_sales_tzs), 0);
    assert.equal(Number(body.activity.expected_cash_period), 2000);
    assert.equal(Number(body.sales[0].id), Number(first.sale.id));
    const forbidden = await fetch(origin + '/admin/sales', { headers, redirect: 'manual' });
    assert.equal(forbidden.status, 302);
    assert.equal(forbidden.headers.get('location'), '/admin/cashier');
    const receipt = await fetch(origin + '/admin/cashier/sales/' + otherCashier.sale.id, { headers });
    assert.equal(receipt.status, 404);
    const blockedBatch = await fetch(origin + '/admin/vouchers/batches', { method: 'POST', headers, redirect: 'manual' });
    assert.equal(blockedBatch.status, 302);
    assert.equal(blockedBatch.headers.get('location'), '/admin/cashier');

    const { business, user, admin, dates } = adminScenario;
    const ownerHeaders = { cookie: 'solidus_session=' + await createSession(business.owner.id) };
    const query = '?range=custom&from=' + dates.startDate + '&to=' + dates.endDate;
    const allSales = await fetch(origin + '/admin/sales' + query, { headers: ownerHeaders });
    assert.equal(allSales.status, 200);
    const ownerBody = await allSales.json();
    assert.equal(ownerBody.total, 6);
    assert.equal(Number(ownerBody.report.total_sales_tzs), 6000);
    assert.ok(ownerBody.issuers.some(issuer => Number(issuer.id) === Number(admin.id)));
    const legacyFilter = await fetch(origin + '/admin/sales' + query + '&cashierId=' + business.owner.id, { headers: ownerHeaders });
    const filteredBody = await legacyFilter.json();
    assert.equal(filteredBody.total, 2);
    assert.equal(Number(filteredBody.filters.issuerId), Number(business.owner.id));
    const issuerFilter = await fetch(origin + '/admin/sales' + query + '&issuerId=' + admin.id, { headers: ownerHeaders });
    assert.equal((await issuerFilter.json()).total, 1);
    const ownHeaders = { cookie: 'solidus_session=' + await createSession(user.id) };
    const ownReport = await fetch(origin + '/admin/cashier/report' + query + '&issuerId=' + business.owner.id + '&source=gateway', { headers: ownHeaders });
    const ownBody = await ownReport.json();
    assert.equal(ownBody.total, 1);
    assert.equal(Number(ownBody.report.total_sales_tzs), 1000);
    assert.equal(Number(ownBody.report.gateway_sales_tzs), 0);

    const dashboardResponse = await fetch(origin + '/admin/dashboard/data', { headers: ownerHeaders });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = (await dashboardResponse.json()).business;
    assert.equal(dashboard.stats.total_sales_today, 6000);
    assert.equal(dashboard.stats.cashier_cash_today, 5000);
    assert.equal(dashboard.stats.sales_count_today, 6);
    assert.equal(dashboard.salesTrend.at(-1).voucher_sales, 5000);
    assert.equal(dashboard.salesTrend.at(-1).payment_gateway, 1000);
    assert.ok(dashboard.recentActivity.some(sale => sale.title === admin.full_name && sale.source === 'voucher'));
    assert.ok(dashboard.recentActivity.some(sale => sale.title === business.owner.full_name && sale.source === 'voucher'));
  });
});

test.after(async () => { await pool.end(); });
