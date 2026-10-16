require('dotenv').config();

const pool = require('../config/database');
const {
  getSpendableBalance,
  createPayoutReservation,
  findPayoutByReference,
  completePayout
} = require('../repositories/payout-repository');

const args = process.argv.slice(2);

const readArg = (name) => {
  const index = args.indexOf('--' + name);
  if (index === -1) return null;
  return args[index + 1] ?? '';
};

const hasFlag = (name) => args.includes('--' + name);

const money = (value) =>
  Number(value || 0).toLocaleString('en-TZ', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });

const run = async () => {
  const organizationId = Number(readArg('org'));
  const amountTzs = Number(readArg('amount'));
  const feeTzs = Number(readArg('fee') || 0);
  const reference = String(readArg('reference') || '').trim();
  const recipientName =
    String(readArg('recipient-name') || '').trim() ||
    'Historical payout recipient';
  const recipientPhone =
    String(readArg('phone') || '').trim() ||
    'not-recorded';
  const network =
    String(readArg('network') || '').trim().toUpperCase() ||
    'MPESA';
  const confirmed = readArg('confirm') === 'RECONCILE';

  if (
    !Number.isInteger(organizationId) ||
    organizationId <= 0 ||
    !Number.isFinite(amountTzs) ||
    amountTzs <= 0 ||
    !Number.isFinite(feeTzs) ||
    feeTzs < 0 ||
    !reference
  ) {
    throw new Error(
      'Usage: npm run wallet:reconcile-payout -- --org <id> --amount <tzs> --fee <tzs> --reference <unique-ref> [--recipient-name "..."] [--phone "..."] [--network MPESA] [--confirm RECONCILE]'
    );
  }

  const totalAmountTzs = amountTzs + feeTzs;

  const orgResult = await pool.query(
    `
      SELECT id, name
      FROM organizations
      WHERE id = $1
      LIMIT 1
    `,
    [organizationId]
  );

  const organization = orgResult.rows[0];

  if (!organization) {
    throw new Error('Organization not found: ' + organizationId);
  }

  const existing = await findPayoutByReference(reference);

  if (existing) {
    console.log('');
    console.log('Historical payout already exists.');
    console.log('Reference:', existing.reference);
    console.log('Tenant:', organization.name, '(org ' + organization.id + ')');
    console.log('Status:', existing.status);
    console.log('Amount:', money(existing.amount_tzs), 'TZS');
    console.log('Fee:', money(existing.fee_tzs), 'TZS');
    console.log('Total debit:', money(existing.total_amount_tzs), 'TZS');
    console.log('');
    console.log('No duplicate entry was created.');
    return;
  }

  const availableBefore = await getSpendableBalance(organizationId);

  console.log('');
  console.log('=== Historical payout reconciliation ===');
  console.log('Tenant:', organization.name, '(org ' + organization.id + ')');
  console.log('Reference:', reference);
  console.log('Recipient amount:', money(amountTzs), 'TZS');
  console.log('Payout fee:', money(feeTzs), 'TZS');
  console.log('Total wallet debit:', money(totalAmountTzs), 'TZS');
  console.log('Available before:', money(availableBefore), 'TZS');
  console.log(
    'Available after:',
    money(availableBefore - totalAmountTzs),
    'TZS'
  );
  console.log('');
  console.log(
    'IMPORTANT: This records an ALREADY-COMPLETED external payout. It does not send money.'
  );

  if (!confirmed) {
    console.log('');
    console.log('DRY RUN ONLY — nothing was changed.');
    console.log(
      'Re-run with --confirm RECONCILE after checking the tenant, amount and fee.'
    );
    return;
  }

  if (availableBefore < totalAmountTzs) {
    throw new Error(
      'Tenant wallet is too small to reconcile this historical payout.'
    );
  }

  await createPayoutReservation({
    organizationId,
    requestedByUserId: null,
    reference,
    recipientPhone,
    recipientName,
    network,
    amountTzs,
    feeTzs,
    totalAmountTzs,
    remarks:
      'Historical SplashPay payout recorded after the fact; no provider API call made.'
  });

  await completePayout({
    reference,
    providerReference: null,
    amountTzs,
    feeTzs,
    totalAmountTzs
  });

  const availableAfter = await getSpendableBalance(organizationId);

  console.log('');
  console.log('RECONCILIATION COMPLETE');
  console.log('No money was sent by this script.');
  console.log('Available balance is now:', money(availableAfter), 'TZS');
};

run()
  .catch((error) => {
    console.error('Historical payout reconciliation failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
