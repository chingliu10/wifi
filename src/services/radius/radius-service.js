const {
  upsertRadcheck,
  upsertRadiusAuthorization,
  findRadcheckByUsername
} = require('../../repositories/radius-repository');

const formatRadiusExpiration = (date) => {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).format(date).replace(',', '');
};

const authorizeSubscription = async ({ db, subscription }) => {
  if (process.env.MOCK_RADIUS_FAILURE === 'true') {
    throw new Error('Simulated RADIUS provisioning failure');
  }

  const username = subscription.client_mac;
  const expiresAt = new Date(subscription.expires_at);

  await upsertRadcheck({
    db,
    username,
    attribute: 'Cleartext-Password',
    op: ':=',
    value: username
  });

  await upsertRadcheck({
    db,
    username,
    attribute: 'Expiration',
    op: ':=',
    value: formatRadiusExpiration(expiresAt)
  });

  await upsertRadiusAuthorization({
    db,
    subscriptionId: subscription.id,
    clientMac: subscription.client_mac,
    username,
    startsAt: subscription.starts_at,
    expiresAt: subscription.expires_at
  });

  return findRadcheckByUsername({ db, username });
};

module.exports = {
  authorizeSubscription,
  formatRadiusExpiration
};
