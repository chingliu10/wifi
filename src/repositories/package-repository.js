const pool = require('../config/database');

const findPackageById = async (packageId) => {
  const result = await pool.query(
    `
      SELECT
        id,
        site_id,
        name,
        price_tzs,
        duration_seconds,
        active,
        sort_order,
        created_at,
        updated_at
      FROM packages
      WHERE id = $1
      LIMIT 1
    `,
    [packageId]
  );

  return result.rows[0] || null;
};

module.exports = {
  findPackageById
};
