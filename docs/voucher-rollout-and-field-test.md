# Voucher rollout and field-test plan

## Decision

Solidus vouchers stay inside the existing **External Portal Server** architecture.

We do **not** switch the SSID to Omada native Voucher authentication and we do
**not** re-enable Omada MAC Authentication.

Why:

- The paid flow already works through the Solidus external portal.
- The tested Omada MAC-auth path ignored RADIUS Session-Timeout and created
  extremely long authorizations, so voucher access must not depend on it.
- One portal can safely support both mobile-money payment and voucher entry.
- A redeemed voucher becomes a normal time-limited Solidus subscription, so
  reconnect behavior uses the same proven External Portal reauthorization path.

## Voucher model

A generated code is:

- scoped to one organization and one site;
- tied to a snapshot of the package name and duration;
- single-use;
- optionally redeemable only before a configured deadline;
- bound to the first device that redeems it;
- idempotent for that same device while its resulting subscription is active;
- never counted as a payment or wallet credit.

The package duration starts when the voucher is first redeemed. If another
active subscription already exists for that device/site, the voucher time is
stacked after the current expiry rather than destroying paid time.

## Safety boundaries

Voucher generation and customer-portal redemption have separate feature flags:

- `vouchers_enabled` controls voucher administration.
- `voucher_portal_enabled` controls whether customers see and can submit a
  voucher on the captive portal.

Keep `voucher_portal_enabled = FALSE` until the deployment and field-test
checklist below is complete. With the portal flag off, the existing payment
portal remains unchanged.

## Redemption sequence

1. Client joins the existing paid hotspot SSID.
2. Omada redirects the unauthenticated client to Solidus External Portal.
3. Client opens **NINA VOCHA** and submits the voucher code.
4. Solidus normalizes and hashes the code.
5. PostgreSQL locks the voucher row and validates tenant/site/batch/status.
6. If unused and valid, Solidus creates an `access_source = 'voucher'`
   subscription using the batch's snapshotted duration.
7. Solidus atomically marks the voucher redeemed and binds it to the device.
8. Only after the database transaction commits, Solidus asks Omada External
   Portal Server to authorize that client for the exact remaining duration.
9. If Omada authorization fails, the entitlement is not lost. Reconnecting to
   the portal finds the active subscription and retries External Portal auth.

This order is intentional: database entitlement is committed before network
authorization so a controller/API failure cannot consume the voucher without
preserving the customer's time.

## Admin lifecycle

Admins can:

- generate voucher batches;
- set a redeem-by date;
- view encrypted-at-rest voucher codes;
- copy codes;
- export CSV;
- print the batch;
- cancel one unused code;
- cancel all unused codes in a batch;
- see used-device MACs for redeemed codes.

Cancelling a batch does not revoke already-redeemed active subscriptions.

## Automated regression tests

The repository includes `test/voucher-lifecycle.test.js` and a GitHub Actions
workflow using PostgreSQL 16.

The tests verify:

- formatting normalization and stable lookup hashing;
- generation of unique codes;
- tenant/site scoping;
- successful single-use redemption;
- exact package-duration subscription creation;
- same-device retry idempotency;
- rejection when another device reuses a redeemed code;
- individual cancellation;
- redemption-deadline expiry;
- redeemed-code retry after the batch deadline;
- batch cancellation;
- redeemed-code retry after batch cancellation;
- redeemed vouchers remain redeemed while unused vouchers become cancelled.

The workflow also runs Node syntax checks and every database migration before
the voucher tests.

## Deployment checklist before field test

Run on the server:

```bash
cd ~/apps/wifi
git pull
npm ci
npm run migrate
npm run test:vouchers

node --check src/app.js
node --check src/routes/admin.js
node --check src/services/vouchers/voucher-service.js
node --check src/repositories/subscription-repository.js
node --check src/i18n/admin.js

/home/true/trueodds/node_modules/pm2/bin/pm2 restart smallgarden-wifi --update-env
```

After deployment, leave customer voucher redemption disabled until you are at
the hotspot and ready to test.

## Field-test checklist at the AP

Use SMALL GARDEN first, not ELI.

### Test A — payment regression

Before enabling voucher redemption:

1. Connect a test phone.
2. Confirm the normal payment portal looks exactly as expected.
3. Confirm there is no voucher option while the portal flag is disabled.
4. Confirm Live Clients still shows the device.

This proves the voucher code did not alter the working payment path.

### Test B — enable voucher portal

1. In Admin, open Vouchers for the SMALL GARDEN organization.
2. Enable **Customer portal redemption**.
3. Generate a batch containing at least 4 short-duration test vouchers.
4. Keep the batch page open so the codes and statuses are visible.

### Test C — successful voucher redemption

1. Connect a phone with no active package.
2. Open the captive portal.
3. Confirm **NINA VOCHA** appears.
4. Enter voucher #1.
5. Confirm the success screen appears without a mobile-money request.
6. Confirm Internet works.
7. Confirm the voucher becomes **Redeemed** and shows the device MAC.
8. Confirm Live Clients shows **Internet** rather than **Portal only**.
9. Run `npm run omada:auth-record-check -- "<PHONE-MAC>"`.
10. Confirm the new authorization type is **External Portal Server**, not
    **MAC Auth (with fail over)**.

### Test D — reconnect while voucher time remains

1. Disconnect/reconnect the same phone.
2. Let Omada redirect it again if needed.
3. Confirm Solidus detects the active voucher subscription and automatically
   reauthorizes it without asking for the voucher again.
4. Confirm the new Omada record ends at the original voucher subscription
   expiry, not an arbitrary long date.

### Test E — second-device replay protection

1. On a different phone, enter voucher #1.
2. Confirm it is rejected as already used.
3. Confirm the first phone's access is unaffected.

### Test F — typo/invalid code

1. Enter a random incorrect code.
2. Confirm the portal stays usable.
3. Confirm payment options remain available.
4. Confirm no subscription is created.

### Test G — individual cancellation

1. Cancel unused voucher #2 in Admin.
2. Try voucher #2 on a phone.
3. Confirm it is rejected as cancelled.

### Test H — batch cancellation

1. Cancel the batch.
2. Confirm every still-unused voucher becomes cancelled.
3. Confirm voucher #1 remains redeemed.
4. Confirm the phone that used voucher #1 keeps its existing Internet until
   the original subscription expiry.

### Test I — expiry enforcement

Use a short test duration if available.

1. Keep the phone actively using Internet near the expiry time.
2. Confirm access stops when the External Portal authorization expires.
3. Confirm the client is redirected back to the portal afterward.
4. Confirm no 100-year MAC-auth record is created.

### Test J — disable voucher rollout

1. Disable **Customer portal redemption**.
2. Reconnect an expired/no-access device.
3. Confirm **NINA VOCHA** disappears.
4. Confirm mobile-money payment remains available and unchanged.

## Completion rule

Do not mark voucher rollout fully field-verified until Tests A-J pass on a real
Omada AP. Automated CI proves the application/database lifecycle; only the
field test can prove controller/captive-browser behavior end-to-end.
