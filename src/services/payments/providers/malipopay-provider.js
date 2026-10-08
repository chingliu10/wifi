const DEFAULT_BASE_URL = 'https://core-prod.malipopay.co.tz';

const requiredEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const initiatePayment = async ({
  reference,
  amountTzs,
  packageData
}) => {
  const apiToken = requiredEnv('MALIPOPAY_API_TOKEN');
  const baseUrl = (process.env.MALIPOPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const callbackBaseUrl = (
    process.env.MALIPOPAY_CALLBACK_BASE_URL ||
    'https://portal.soliduslogic.co.tz'
  ).replace(/\/$/, '');

  const payload = {
    amount: Number(amountTzs),
    currency: 'TZS',
    description: `Small Garden WiFi - ${packageData.name}`,
    callbackUrl: `${callbackBaseUrl}/portal/payment/${encodeURIComponent(reference)}`,
    reference
  };

  const response = await fetch(`${baseUrl}/api/v1/payment/link`, {
    method: 'POST',
    headers: {
      apiToken,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let body;

  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`MalipoPay returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || body.success === false) {
    const message = body.message || body.error || `HTTP ${response.status}`;
    throw new Error(`MalipoPay payment link failed: ${message}`);
  }

  const data = body.data || body;
  const redirectUrl =
    data.checkoutUrl ||
    data.checkout_url ||
    data.paymentUrl ||
    data.payment_url ||
    data.url ||
    data.link ||
    body.checkoutUrl ||
    body.url ||
    body.link;

  if (!redirectUrl) {
    throw new Error('MalipoPay response did not include a checkout URL');
  }

  return {
    provider: 'malipopay',
    providerReference: data.reference || body.reference || reference,
    status: data.status || 'pending',
    message: body.message || 'MalipoPay checkout created',
    redirectUrl,
    reference,
    amountTzs: Number(amountTzs)
  };
};

module.exports = {
  initiatePayment
};
