const { normalizeMacAddress } = require('../utils/mac-address');
const { findOrCreateDevice } = require('../repositories/device-repository');

const getOrCreateDevice = async (macAddress) => {
  const normalizedMac = normalizeMacAddress(macAddress);

  if (!normalizedMac) {
    throw new Error('Invalid MAC address');
  }

  return findOrCreateDevice(normalizedMac);
};

module.exports = {
  getOrCreateDevice
};