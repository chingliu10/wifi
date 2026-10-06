const crypto = require('crypto');

const generatePaymentReference = () => {
  return `PAY-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
};

module.exports = {
  generatePaymentReference
};
