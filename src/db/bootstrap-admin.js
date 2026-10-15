require('dotenv').config();

const pool = require('../config/database');
const {
  normalizeUsername,
  hashPassword
} = require('../services/auth-service');

const run = async () => {
  const username = normalizeUsername(
    process.env.SUPER_ADMIN_USERNAME ||
    process.env.ADMIN_USERNAME ||
    'admin'
  );
  const password =
    process.env.SUPER_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD;
  const fullName =
    process.env.SUPER_ADMIN_NAME ||
    'Solidus Admin';

  if (!password) {
    throw new Error(
      'Set SUPER_ADMIN_PASSWORD (or the legacy ADMIN_PASSWORD) before bootstrapping.'
    );
  }

  const passwordHash = hashPassword(password);

  const result = await pool.query(
    `
      INSERT INTO platform_users (
        organization_id,
        role,
        full_name,
        username,
        password_hash,
        active
      )
      VALUES (
        NULL,
        'super_admin',
        $1,
        $2,
        $3,
        TRUE
      )
      ON CONFLICT (username)
      DO UPDATE SET
        organization_id = NULL,
        role = 'super_admin',
        full_name = EXCLUDED.full_name,
        password_hash = EXCLUDED.password_hash,
        active = TRUE,
        updated_at = NOW()
      RETURNING id, username, full_name, role
    `,
    [fullName, username, passwordHash]
  );

  console.log(
    `Super admin ready: ${result.rows[0].username} (${result.rows[0].full_name})`
  );
};

run()
  .catch((error) => {
    console.error('Super admin bootstrap failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
