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
    'views/admin/cashiers.hbs'
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
