const express = require('express');
const pool = require('./config/database');
const { getOrCreateDevice } = require('./services/device-service');
const { getDeviceAccessStatus } = require('./services/subscription-service');
const { activatePackageForDevice } = require('./services/subscription-service');

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Hotspot backend is running'
  });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      success: true,
      database: 'connected',
      time: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/packages', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        price_tzs,
        duration_seconds
      FROM packages
      WHERE active = true
      ORDER BY sort_order
    `);

    res.json({
      success: true,
      packages: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/devices', async (req, res) => {
  try {
    const { macAddress } = req.body;

    const device = await getOrCreateDevice(macAddress);

    res.json({
      success: true,
      device
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});


app.get('/devices/:mac/access', async (req, res) => {
  try {
    const device = await getOrCreateDevice(req.params.mac);

    const access = await getDeviceAccessStatus(device.id);

    res.json({
      success: true,
      device: {
        id: device.id,
        macAddress: device.mac_address
      },
      access
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/test/activate', async (req, res) => {
  try {
    const { macAddress, packageId } = req.body;

    const device = await getOrCreateDevice(macAddress);

    const subscription = await activatePackageForDevice({
      deviceId: device.id,
      packageId
    });

    res.json({
      success: true,
      device: {
        id: device.id,
        macAddress: device.mac_address
      },
      subscription
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});


module.exports = app;