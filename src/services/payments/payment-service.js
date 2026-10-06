const mockProvider = require('./providers/mock-provider');

const initiatePayment = async ({
  transaction,
  packageData
}) => {
  return mockProvider.initiatePayment({
    reference: transaction.reference,
    phone: transaction.phone,
    amountTzs: transaction.amount_tzs,
    packageData
  });
};

module.exports = {
  initiatePayment
};
