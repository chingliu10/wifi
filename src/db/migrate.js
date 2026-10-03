const fs = require('fs');
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});
const pool = require('../config/database');

const runMigration = async () => {
  try {
    const filePath = path.join(
      __dirname,
      'migrations',
      '001_initial_schema.sql'
    );

    const sql = fs.readFileSync(filePath, 'utf8');

    await pool.query(sql);

    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

runMigration();
