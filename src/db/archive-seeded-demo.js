require('dotenv').config();

const pool = require('../config/database');

const run = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orgResult = await client.query(
      `
        SELECT id, name
        FROM organizations
        WHERE slug = 'small-garden'
          AND active = TRUE
        LIMIT 1
        FOR UPDATE
      `
    );

    const organization = orgResult.rows[0];

    if (!organization) {
      await client.query('ROLLBACK');
      console.log('No active legacy Small Garden seed was found. Nothing changed.');
      return;
    }

    const siteResult = await client.query(
      `
        SELECT id
        FROM sites
        WHERE organization_id = $1
          AND slug = 'small-garden'
        LIMIT 1
        FOR UPDATE
      `,
      [organization.id]
    );

    const site = siteResult.rows[0];

    if (site) {
      await client.query(
        `
          DELETE FROM network_devices
          WHERE site_id = $1
        `,
        [site.id]
      );

      await client.query(
        `
          UPDATE sites
          SET
            active = FALSE,
            external_portal_site_id = NULL,
            updated_at = NOW()
          WHERE id = $1
        `,
        [site.id]
      );
    }

    await client.query(
      `
        UPDATE organizations
        SET
          active = FALSE,
          updated_at = NOW()
        WHERE id = $1
      `,
      [organization.id]
    );

    await client.query('COMMIT');

    console.log(
      'Legacy Small Garden onboarding data archived. Historical payments and subscriptions were preserved.'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

run()
  .catch((error) => {
    console.error('Archive failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
