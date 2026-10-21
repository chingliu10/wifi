const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
