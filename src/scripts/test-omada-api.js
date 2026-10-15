require('dotenv').config();

const omada = require('../services/omada/open-api-client');

const run = async () => {
  if (!omada.configured()) {
    throw new Error('Set OMADA_API_ENABLED=true first');
  }

  const info = await omada.getControllerInfo();
  await omada.getAccessToken({ force: true });
  const sites = await omada.listSites();
  const scenarios = await omada.listScenarios();

  console.log('Omada Open API connection OK');
  console.log('Controller version:', info.controllerVersion || 'unknown');
  console.log('Omada ID detected:', info.omadacId ? 'yes' : 'no');
  console.log('Sites visible:', sites.length);
  console.log('Scenarios visible:', scenarios.length);
};

run()
  .catch((error) => {
    console.error('Omada Open API test failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 20);
  });
