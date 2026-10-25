const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');

const read = (relativePath) =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('voucher UI is feature-gated and preserves the working payment form', () => {
  const portal = read('views/portal/index.hbs');

  assert.match(
    portal,
    /id="portal-payment-form"[\s\S]*action="\/portal\/pay"/
  );

  const gateIndex = portal.indexOf(
    '{{#if siteConfig.voucher_portal_enabled}}'
  );
  const voucherFormIndex = portal.indexOf(
    'action="/portal/voucher"'
  );

  assert.ok(gateIndex >= 0, 'voucher feature gate must exist');
  assert.ok(
    voucherFormIndex > gateIndex,
    'voucher form must remain behind the portal feature gate'
  );

  assert.match(portal, /inputmode="numeric"/);
  assert.match(portal, /placeholder="Mfano: 4827 1936"/);
  assert.match(portal, /id="voucher-open-button"/);
  assert.match(portal, /id="voucher-modal"/);
  assert.match(portal, /aria-haspopup="dialog"/);
});

test('voucher redemption uses External Portal and does not introduce MAC-auth provisioning', () => {
  const app = read('src/app.js');
  const voucherService = read('src/services/vouchers/voucher-service.js');
  const hotspotService = read('src/services/omada/hotspot-service.js');

  assert.match(app, /app\.post\('\/portal\/voucher'/);
  assert.match(
    app,
    /omadaPortal\.authorizeExternalPortalClient\(/
  );

  assert.doesNotMatch(
    voucherService,
    /authorizeSubscription\(/
  );

  assert.match(
    hotspotService,
    /disableMacAuthForSsid/
  );
});

test('cashier voucher workflow is restricted to its own route and cannot expose admin navigation', () => {
  const adminRoutes = read('src/routes/admin.js');
  const layout = read('views/layouts/admin.hbs');
  const cashierView = read('views/admin/cashier.hbs');

  assert.match(adminRoutes, /req\.authUser\?\.role !== 'cashier'/);
  assert.match(adminRoutes, /req\.path\.startsWith\('\/cashier\/'\)/);
  assert.match(adminRoutes, /router\.post\('\/cashier\/sales'/);
  assert.match(adminRoutes, /requireOwnerOrSuperAdmin/);

  assert.match(layout, /\{\{#if isCashier\}\}/);
  assert.match(layout, /href="\/admin\/cashier"/);
  assert.match(cashierView, /cashier\.customerPaidIssue/);
  assert.doesNotMatch(cashierView, /\/admin\/wallet/);
  assert.doesNotMatch(cashierView, /\/admin\/packages/);
});

test('cashier Handlebars templates compile', () => {
  for (const file of [
    'views/layouts/admin.hbs',
    'views/admin/cashier.hbs',
    'views/admin/cashier-receipt.hbs',
    'views/admin/cashiers.hbs',
    'views/admin/vouchers.hbs',
    'views/admin/dashboard.hbs'
  ]) {
    assert.doesNotThrow(
      () => Handlebars.precompile(read(file)),
      file + ' should compile'
    );
  }
});

test('cashier can void only through the dedicated voucher-sale action', () => {
  const adminRoutes = read('src/routes/admin.js');
  const receipt = read('views/admin/cashier-receipt.hbs');

  assert.match(
    adminRoutes,
    /router\.post\('\/cashier\/sales\/:id\/void'/
  );
  assert.match(adminRoutes, /voidCashierVoucherSale/);
  assert.match(receipt, /cashier\.voidVoucher/);
  assert.match(receipt, /\{\{#if sale\.voidable\}\}/);
});

test('voucher admin exposes consolidated status and redemption activity', () => {
  const portal = read('views/admin/vouchers.hbs');
  const voucherService = read('src/services/vouchers/voucher-service.js');

  assert.match(portal, /voucherStats\.redeemed/);
  assert.match(portal, /voucherStats\.unused/);
  assert.match(portal, /cashierSummary\.totals\.expected_cash_today/);
  assert.match(portal, /voucherActivity/);
  assert.match(portal, /redeemed_mac/);
  assert.match(portal, /known_phone/);
  assert.match(portal, /access_expires_at/);

  assert.match(voucherService, /const getVoucherOverview/);
  assert.match(voucherService, /LEFT JOIN voucher_sales/);
  assert.match(voucherService, /LEFT JOIN LATERAL/);
});

test('voucher management uses focused workspace tabs instead of one long page', () => {
  const view = read('views/admin/vouchers.hbs');

  assert.match(view, /vouchers\.tabOverview/);
  assert.match(view, /vouchers\.tabAll/);
  assert.match(view, /vouchers\.tabCashier/);
  assert.match(view, /vouchers\.tabBatches/);

  assert.match(view, /data-open-voucher-create/);
  assert.match(view, /id="voucher-create-modal"/);
  assert.match(view, /data-voucher-detail-open/);
  assert.match(view, /voucher-detail-drawer/);

  assert.doesNotMatch(
    view,
    /<section class="page-head">[\s\S]*?<h2>\{\{t 'vouchers\.title'\}\}<\/h2>/
  );
});

test('live clients expose the active Solidus package and access source', () => {
  const adminRoutes = read('src/routes/admin.js');
  const liveView = read('views/admin/live-clients.hbs');

  assert.match(adminRoutes, /sub\.access_source/);
  assert.match(adminRoutes, /vb\.package_name_snapshot/);
  assert.match(adminRoutes, /pt\.reference AS payment_reference/);
  assert.match(adminRoutes, /v\.code_last4 AS voucher_last4/);
  assert.match(adminRoutes, /subscription_mismatch/);

  assert.match(liveView, /access_source_voucher/);
  assert.match(liveView, /live\.sourceVoucher/);
  assert.match(liveView, /live\.sourcePaid/);
  assert.match(liveView, /live\.sourceComplimentary/);
  assert.match(liveView, /subscription_expires_at/);
  assert.match(liveView, /live\.unknownSource/);
});

test('dashboard is a live business-network workspace and setup progress is removed', () => {
  const adminRoutes = read('src/routes/admin.js');
  const dashboard = read('views/admin/dashboard.hbs');

  assert.match(adminRoutes, /router\.get\('\/dashboard\/data'/);
  assert.match(adminRoutes, /loadDashboardNetworkData/);
  assert.match(adminRoutes, /loadDashboardBusinessData/);
  assert.match(adminRoutes, /loadLiveClientSnapshot/);

  assert.match(dashboard, /data-dashboard-tab="overview"/);
  assert.match(dashboard, /data-dashboard-tab="network"/);
  assert.match(dashboard, /data-dashboard-tab="clients"/);
  assert.match(dashboard, /data-dashboard-tab="sales"/);
  assert.match(dashboard, /setInterval\(refreshDashboard, 30000\)/);
  assert.match(dashboard, /dashboard\.cashVouchers/);
  assert.match(dashboard, /dashboard\.band24/);
  assert.match(dashboard, /dashboard\.band5/);

  assert.doesNotMatch(dashboard, /dashboard\.setupProgress/);
  assert.doesNotMatch(dashboard, /dashboard\.setupHint/);
  assert.doesNotMatch(dashboard, /checklist/);
});

test('dashboard compares payment gateway and voucher sales while voucher reports support periods', () => {
  const adminRoutes = read('src/routes/admin.js');
  const dashboard = read('views/admin/dashboard.hbs');
  const vouchers = read('views/admin/vouchers.hbs');
  const voucherService = read('src/services/vouchers/voucher-service.js');

  assert.match(adminRoutes, /payment_gateway/);
  assert.match(adminRoutes, /voucher_sales/);
  assert.match(adminRoutes, /resolveVoucherSalesRange/);
  assert.match(adminRoutes, /last_month/);
  assert.match(adminRoutes, /last30/);

  assert.match(dashboard, /data-payment-gateway/);
  assert.match(dashboard, /data-voucher-sales/);
  assert.match(dashboard, /data-gateway-bar/);
  assert.match(dashboard, /data-voucher-bar/);

  assert.match(vouchers, /name="voucherRange"/);
  assert.match(vouchers, /vouchers\.periodLast7/);
  assert.match(vouchers, /vouchers\.periodLastMonth/);
  assert.match(vouchers, /cashierSummary\.totals\.collected_period/);

  assert.match(voucherService, /collected_period/);
  assert.match(voucherService, /Africa\/Dar_es_Salaam/);
});
