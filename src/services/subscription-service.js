const {
  findActiveSubscriptionByDeviceId,
  createOrExtendSubscription
} = require('../repositories/subscription-repository');

const { getActivePackageById } = require('./package-service');

const getDeviceAccessStatus = async (deviceId) => {
  const subscription = await findActiveSubscriptionByDeviceId(deviceId);

  if (!subscription) {
    return {
      active: false,
      subscription: null
    };
  }

  return {
    active: true,
    subscription
  };
};

const activatePackageForDevice = async ({
  deviceId,
  packageId,
  paymentId = null
}) => {
  const packageData = await getActivePackageById(packageId);

  return createOrExtendSubscription({
    siteId: packageData.site_id,
    deviceId,
    packageId: packageData.id,
    paymentId,
    durationSeconds: packageData.duration_seconds
  });
};

module.exports = {
  getDeviceAccessStatus,
  activatePackageForDevice
};