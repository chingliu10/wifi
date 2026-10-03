const pool = require('../config/database');

const findOrCreateDevice = async (macAddress) => {
  const result = await pool.query(
    `
      INSERT INTO devices (
        mac_address,
        first_seen_at,
        last_seen_at
      )
      VALUES ($1, NOW(), NOW())

      ON CONFLICT (mac_address)
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW()

      RETURNING *
    `,
    [macAddress]
  );

  return result.rows[0];
};

module.exports = {
  findOrCreateDevice
};