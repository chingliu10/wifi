require('dotenv').config();

const crypto = require('crypto');
const {
  normalizePhone,
  normalizeNetwork,
  getMobileMoneyDisbursementFee,
  lookupMobileMoneyRecipient,
  initiateMobileMoneyDisbursement,
  checkDisbursementStatus
} = require('../services/payouts/providers/splashpay-provider');

const args = process.argv.slice(2);

const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const hasArg = (name) => args.includes(name);

const requiredArg = (name) => {
  const value = getArg(name);

  if (!value) {
    throw new Error('Missing required argument: ' + name);
  }

  return value;
};

const formatTzs = (value) =>
  Number(value || 0).toLocaleString('en-TZ', {
    maximumFractionDigits: 2
  });

const makeReference = () =>
  'PAYOUT-TEST-' +
  new Date().toISOString().replace(/\D/g, '').slice(0, 14) +
  '-' +
  crypto.randomBytes(3).toString('hex').toUpperCase();

const extractRecipientName = (lookup) => {
  const data = lookup?.data || {};

  return String(
    data.account_name ||
    data.accountName ||
    data.recipient_name ||
    data.recipientName ||
    data.name ||
    ''
  ).trim();
};

const printUsage = () => {
  console.log('');
  console.log('SplashPay disbursement proof');
  console.log('');
  console.log('Dry run / recipient lookup only:');
  console.log(
    '  npm run splashpay:payout-proof -- --phone 07XXXXXXXX --network MPESA --amount 1000'
  );
  console.log('');
  console.log('Actually send money:');
  console.log(
    '  npm run splashpay:payout-proof -- --phone 07XXXXXXXX --network MPESA --amount 1000 --confirm SEND'
  );
  console.log('');
  console.log('Supported network values:');
  console.log('  MPESA');
  console.log('  MIXX_BY_YAS');
  console.log('  AIRTEL_MONEY');
  console.log('  HALOPESA');
  console.log('  EZYPESA');
  console.log('  TTCLPESA');
};

const run = async () => {
  if (hasArg('--help') || hasArg('-h')) {
    printUsage();
    return;
  }

  const phone = normalizePhone(requiredArg('--phone'));
  const network = normalizeNetwork(requiredArg('--network'));
  const amountTzs = Number(requiredArg('--amount'));
  const confirm = String(getArg('--confirm') || '').trim().toUpperCase();
  const explicitName = String(getArg('--name') || '').trim();

  if (!Number.isFinite(amountTzs) || amountTzs <= 0) {
    throw new Error('--amount must be greater than zero');
  }

  const expectedFeeTzs = getMobileMoneyDisbursementFee(amountTzs);
  const expectedTotalTzs = amountTzs + expectedFeeTzs;

  console.log('');
  console.log('=== SplashPay disbursement proof ===');
  console.log('Phone:', phone);
  console.log('Network:', network);
  console.log('Recipient amount:', formatTzs(amountTzs), 'TZS');
  console.log('Expected payout fee:', formatTzs(expectedFeeTzs), 'TZS');
  console.log('Expected wallet debit:', formatTzs(expectedTotalTzs), 'TZS');
  console.log('');

  console.log('1. Verifying recipient name...');

  const lookup = await lookupMobileMoneyRecipient({ phone });
  const lookupName = extractRecipientName(lookup);
  const recipientName = explicitName || lookupName;

  console.log('   Lookup status:', lookup.status || '—');
  console.log('   Lookup message:', lookup.message || '—');
  console.log('   Recipient:', recipientName || 'NOT RETURNED');

  if (!recipientName) {
    throw new Error(
      'SplashPay name lookup did not return a recipient name. ' +
      'Do not send until the recipient can be verified.'
    );
  }

  if (confirm !== 'SEND') {
    console.log('');
    console.log('=== DRY RUN COMPLETE ===');
    console.log('No money was sent.');
    console.log('');
    console.log(
      'To perform the real payout after checking the recipient above, rerun with:'
    );
    console.log('  --confirm SEND');
    return;
  }

  const reference = String(getArg('--reference') || makeReference()).trim();

  console.log('');
  console.log('2. Sending REAL mobile-money disbursement...');
  console.log('   Reference:', reference);
  console.log('   Recipient:', recipientName);
  console.log('');

  const result = await initiateMobileMoneyDisbursement({
    reference,
    phone,
    recipientName,
    amountTzs,
    network,
    remarks: 'Solidus WiFi payout proof',
    metadata: {
      proof: true,
      source: 'solidus-wifi'
    }
  });

  console.log('   SplashPay accepted request.');
  console.log('   Status:', result.status || '—');
  console.log('   Provider reference:', result.providerReference || '—');
  console.log('   Amount:', formatTzs(result.amountTzs), 'TZS');
  console.log(
    '   Fee:',
    result.feeTzs === null ? '—' : formatTzs(result.feeTzs) + ' TZS'
  );
  console.log(
    '   Total amount:',
    result.totalAmountTzs === null
      ? '—'
      : formatTzs(result.totalAmountTzs) + ' TZS'
  );

  if (
    result.feeTzs !== null &&
    Number(result.feeTzs) !== Number(expectedFeeTzs)
  ) {
    console.log('');
    console.log(
      'WARNING: SplashPay returned a different fee from the current pricing table.'
    );
    console.log(
      'Use the provider-returned fee as authoritative and review the configured fee tiers.'
    );
  }

  console.log('');
  console.log('3. Checking disbursement status...');

  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    const status = await checkDisbursementStatus({ reference });

    console.log('   Status:', status.status || '—');
    console.log('   Provider reference:', status.providerReference || '—');
    console.log(
      '   Fee:',
      status.feeTzs === null ? '—' : formatTzs(status.feeTzs) + ' TZS'
    );
    console.log(
      '   Total amount:',
      status.totalAmountTzs === null
        ? '—'
        : formatTzs(status.totalAmountTzs) + ' TZS'
    );
  } catch (error) {
    console.log('   Status lookup failed:', error.message);
  }

  console.log('');
  console.log('=== PAYOUT PROOF SUBMITTED ===');
  console.log(
    'If status is pending or processing, confirm the final result from SplashPay webhook/status before treating it as completed.'
  );
};

run().catch((error) => {
  console.error('');
  console.error('SplashPay disbursement proof failed:', error.message);

  if (error.providerCode) {
    console.error('Provider code:', error.providerCode);
  }

  process.exitCode = 1;
});
