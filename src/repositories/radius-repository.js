const pool = require('../config/database');

const query = (db, sql, params) => {
  return (db || pool).query(sql, params);
};

const upsertRadcheck = async ({
  db,
  username,
  attribute,
  op,
  value
}) => {
  const updateResult = await query(
    db,
    `
      UPDATE radcheck
      SET
        op = $3,
        value = $4
      WHERE username = $1
        AND attribute = $2
      RETURNING *
    `,
    [username, attribute, op, value]
  );

  if (updateResult.rows[0]) {
    return updateResult.rows[0];
  }

  const insertResult = await query(
    db,
    `
      INSERT INTO radcheck (
        username,
        attribute,
        op,
        value
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [username, attribute, op, value]
  );

  return insertResult.rows[0];
};

const upsertRadiusAuthorization = async ({
  db,
  subscriptionId,
  clientMac,
  username,
  startsAt,
  expiresAt
}) => {
  const result = await query(
    db,
    `
      INSERT INTO radius_authorizations (
        subscription_id,
        client_mac,
        username,
        starts_at,
        expires_at,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'active')
      ON CONFLICT (client_mac)
      DO UPDATE SET
        subscription_id = EXCLUDED.subscription_id,
        username = EXCLUDED.username,
        starts_at = EXCLUDED.starts_at,
        expires_at = EXCLUDED.expires_at,
        status = 'active',
        updated_at = NOW()
      RETURNING *
    `,
    [subscriptionId, clientMac, username, startsAt, expiresAt]
  );

  return result.rows[0];
};

const findRadcheckByUsername = async ({ db, username }) => {
  const result = await query(
    db,
    `
      SELECT
        id,
        username,
        attribute,
        op,
        value
      FROM radcheck
      WHERE username = $1
      ORDER BY attribute
    `,
    [username]
  );

  return result.rows;
};

module.exports = {
  upsertRadcheck,
  upsertRadiusAuthorization,
  findRadcheckByUsername
};
