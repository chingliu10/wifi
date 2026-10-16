const {
  normalizePhone,
  normalizeNetwork,
  getMobileMoneyDisbursementFee,
  lookupMobileMoneyRecipient,
  initiateMobileMoneyDisbursement
} = require('./providers/splashpay-provider');
const {
  createPayoutReservation,
  findPayoutByReference,
  updatePayoutProviderState,
  completePayout,
  failPayout
} = require('../../repositories/payout-repository');

const extractRecipientName = (lookup) => {
  const candidates = [
    lookup?.data,
    lookup?.raw?.data,
    lookup?.raw
  ].filter(Boolean);

  const keys = [
    'account_name',
    'accountName',
    'account_holder_name',
    'accountHolderName',
    'recipient_name',
    'recipientName',
    'customer_name',
    'customerName',
    'full_name',
    'fullName',
    'name'
  ];

  const findName = (value, depth = 0) => {
    if (!value || depth > 3) return '';

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findName(item, depth + 1);
        if (found) return found;
      }

      return '';
    }

    if (typeof value !== 'object') return '';

    for (const key of keys) {
      const candidate = value[key];

      if (
        typeof candidate === 'string' &&
        candidate.trim()
      ) {
        return candidate.trim();
      }
    }

    for (const nested of Object.values(value)) {
      const found = findName(nested, depth + 1);
      if (found) return found;
    }

    return '';
  };

  for (const candidate of candidates) {
    const found = findName(candidate);
    if (found) return found;
  }

  return '';
};

const normalizeAmount = (value) => {
  const amount = Number(value);

  if (
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    throw new Error('Withdrawal amount must be a positive whole TZS amount');
  }

  return amount;
};

const previewMobileMoneyPayout = async ({
  phone,
  network,
  amountTzs
}) => {
  const normalizedPhone = normalizePhone(phone);
  const normalizedNetwork = normalizeNetwork(network);
  const amount = normalizeAmount(amountTzs);
  const feeTzs = getMobileMoneyDisbursementFee(amount);
  const totalAmountTzs = amount + feeTzs;

  const lookup = await lookupMobileMoneyRecipient({
    phone: normalizedPhone
  });

  const recipientName = extractRecipientName(lookup);

  if (!recipientName) {
    throw new Error(
      'SplashPay did not return a recipient name for this mobile number'
    );
  }

  return {
    phone: normalizedPhone,
    network: normalizedNetwork,
    amountTzs: amount,
    feeTzs,
    totalAmountTzs,
    recipientName
  };
};

const requestMobileMoneyPayout = async ({
  organizationId,
  requestedByUserId,
  reference,
  phone,
  network,
  amountTzs,
  remarks
}) => {
  const preview = await previewMobileMoneyPayout({
    phone,
    network,
    amountTzs
  });

  let reservation;

  try {
    reservation = await createPayoutReservation({
      organizationId,
      requestedByUserId,
      reference,
      recipientPhone: preview.phone,
      recipientName: preview.recipientName,
      network: preview.network,
      amountTzs: preview.amountTzs,
      feeTzs: preview.feeTzs,
      totalAmountTzs: preview.totalAmountTzs,
      remarks
    });
  } catch (error) {
    if (error.code !== '23505') {
      throw error;
    }

    const existing = await findPayoutByReference(reference);

    if (
      existing &&
      Number(existing.organization_id) === Number(organizationId) &&
      String(existing.recipient_phone) === String(preview.phone) &&
      String(existing.network) === String(preview.network) &&
      Number(existing.amount_tzs) === Number(preview.amountTzs)
    ) {
      return {
        payout: existing,
        preview,
        duplicate: true
      };
    }

    throw error;
  }

  let provider;

  try {
    provider = await initiateMobileMoneyDisbursement({
      reference,
      phone: preview.phone,
      recipientName: preview.recipientName,
      amountTzs: preview.amountTzs,
      network: preview.network,
      remarks,
      metadata: {
        organization_id: String(organizationId),
        payout_transaction_id: String(reservation.id)
      }
    });
  } catch (error) {
    await failPayout({
      reference,
      code: error.providerCode || error.code || null,
      message: error.message
    });

    throw error;
  }

  const providerStatus = String(
    provider.status || 'pending'
  ).toLowerCase();
  const safeStatus =
    providerStatus === 'processing'
      ? 'processing'
      : 'pending';

  if (
    provider.reference &&
    provider.reference !== reference
  ) {
    await updatePayoutProviderState({
      reference,
      providerReference: provider.providerReference,
      status: safeStatus
    });

    throw new Error('SplashPay accepted payout with a mismatched reference');
  }

  if (
    Number(provider.amountTzs) !== Number(preview.amountTzs)
  ) {
    await updatePayoutProviderState({
      reference,
      providerReference: provider.providerReference,
      status: safeStatus
    });

    throw new Error('SplashPay accepted payout with a mismatched amount');
  }

  const providerFee = Number.isFinite(Number(provider.feeTzs))
    ? Number(provider.feeTzs)
    : preview.feeTzs;
  const providerTotal = Number.isFinite(Number(provider.totalAmountTzs))
    ? Number(provider.totalAmountTzs)
    : preview.amountTzs + providerFee;

  if (
    Math.abs(
      providerTotal -
      (preview.amountTzs + providerFee)
    ) > 0.01
  ) {
    await updatePayoutProviderState({
      reference,
      providerReference: provider.providerReference,
      status: safeStatus
    });

    throw new Error('SplashPay accepted payout with an invalid total');
  }

  if (
    providerStatus === 'paid' ||
    providerStatus === 'success' ||
    providerStatus === 'completed'
  ) {
    const completed = await completePayout({
      reference,
      providerReference: provider.providerReference,
      amountTzs: preview.amountTzs,
      feeTzs: providerFee,
      totalAmountTzs: providerTotal
    });

    return {
      payout: completed,
      preview
    };
  }

  const updated = await updatePayoutProviderState({
    reference,
    providerReference: provider.providerReference,
    feeTzs: providerFee,
    totalAmountTzs: providerTotal,
    status: safeStatus
  });

  return {
    payout: updated,
    preview
  };
};

const mobileMoneyNetworks = [
  { value: 'MPESA', label: 'M-Pesa (Vodacom)' },
  { value: 'AIRTEL_MONEY', label: 'Airtel Money' },
  { value: 'MIXX_BY_YAS', label: 'Mixx by Yas' },
  { value: 'HALOPESA', label: 'HaloPesa' },
  { value: 'EZYPESA', label: 'EzyPesa' },
  { value: 'TTCLPESA', label: 'TTCL Pesa' }
];

module.exports = {
  previewMobileMoneyPayout,
  requestMobileMoneyPayout,
  mobileMoneyNetworks
};
