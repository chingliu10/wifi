const crypto = require('crypto');

const initiatePayment = async ({
  reference,
  phone,
  amountTzs,
  packageData
}) => {
  return {
    provider: 'mock',
    providerReference: `MOCK-${crypto.randomBytes(12).toString('hex').toUpperCase()}`,
    status: 'pending',
    message: `Mock payment request sent for ${packageData.name}`,
    reference,
    phone,
    amountTzs
  };
};

module.exports = {
  initiatePayment
};
