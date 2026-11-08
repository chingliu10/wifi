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
const { getSalesScope, hasSalesPermission, listSales, listCashierVouchers,
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

test('sales reports isolate accounts and use first-redemption dates without changing issuance or wallet flows', {
  skip: testDatabaseUrl ? false : 'TEST_DATABASE_URL is required; no integration queries run against production'
}, async t => {
  const { createClientOwner, createCashier, createSession } = require('../src/services/auth-service');
  const { createCashierVoucherSale, redeemVoucher, voidCashierVoucherSale,
    getCashierVoucherSale, getCashierVoucherSalesSummary } = require('../src/services/vouchers/voucher-service');
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
  const makeVoucher = async (tenant, user, issuedAt, usedAt = null) => {
    const issued = await createCashierVoucherSale({ organizationId: tenant.org.id,
      siteId: tenant.site.id, packageId: tenant.pkg.id, cashierUserId: user.id,
      requestKey: crypto.randomUUID() });
    await pool.query('UPDATE voucher_sales SET issued_at = $2 WHERE id = $1', [issued.sale.id, issuedAt]);
    if (usedAt) {
      const mac = '02:' + crypto.randomBytes(5).toString('hex').match(/../g).join(':');
      const device = (await pool.query('INSERT INTO devices (mac_address) VALUES ($1) RETURNING *', [mac])).rows[0];
      const request = { organizationId: tenant.org.id, siteId: tenant.site.id,
        deviceId: device.id, clientMac: mac, code: issued.code };
      await redeemVoucher(request);
      assert.equal((await redeemVoucher(request)).reused, true);
      await pool.query('UPDATE vouchers SET redeemed_at = $2 WHERE id = $1', [issued.voucher.id, usedAt]);
    }
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

  await t.test('cashier sees own first-use sales, including previous-day issues and local midnight', async () => {
    const result = await listSales({ user: ca, organizationId: b.org.id, cashierUserId: cb.id,
      source: 'gateway', ...period });
    assert.equal(result.total, 1);
    assert.equal(Number(result.total_sales_tzs), 1000);
    assert.equal(Number(result.sales[0].id), Number(first.sale.id));
    assert.equal(result.sales[0].source, 'voucher');
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

  await t.test('cashier dashboard separates 3500 used sales from 4500 issued cash and excludes gateway payments', async () => {
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
  });

  await t.test('authenticated routes keep forged tenant and cashier parameters inside the session scope', async () => {
    const express = require('express');
    const app = express();
    app.use((req, res, next) => {
      res.render = (view, data) => res.json({ view, sales: data.sales, vouchers: data.vouchers,
        total: data.report?.total });
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
    assert.equal(Number(body.sales[0].id), Number(first.sale.id));
    const forbidden = await fetch(origin + '/admin/sales', { headers, redirect: 'manual' });
    assert.equal(forbidden.status, 302);
    assert.equal(forbidden.headers.get('location'), '/admin/cashier');
    const receipt = await fetch(origin + '/admin/cashier/sales/' + otherCashier.sale.id, { headers });
    assert.equal(receipt.status, 404);
  });
});

test.after(async () => { await pool.end(); });
