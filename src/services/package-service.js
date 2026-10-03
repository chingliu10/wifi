const { findPackageById } = require('../repositories/package-repository');

const getActivePackageById = async (packageId) => {
  const packageData = await findPackageById(packageId);

  if (!packageData) {
    throw new Error('Package not found');
  }

  if (!packageData.active) {
    throw new Error('Package is not active');
  }

  return packageData;
};

module.exports = {
  getActivePackageById
};
