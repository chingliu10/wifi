const mockProvider = require('./providers/mock-provider');
const malipoPayProvider = require('./providers/malipopay-provider');

const getProvider = () => {
  const provider = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') {
    return mockProvider;
  }

  if (provider === 'malipopay') {
    return malipoPayProvider;
  }

  throw new Error(`Unsupported payment provider: ${provider}`);
};

const initiatePayment = async ({
  transaction,
  packageData
}) => {
  const provider = getProvider();

  return provider.initiatePayment({
    reference: transaction.reference,
    phone: transaction.phone,
    amountTzs: transaction.amount_tzs,
    packageData,
    clientMac: transaction.client_mac
  });
};

module.exports = {
  initiatePayment
};
