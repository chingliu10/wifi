require('dotenv').config();

const omada = require('../services/omada/open-api-client');

const schemaNames = [
  'PortalSetting',
  'CreateRadiusProfileOpenApiVO',
  'UpdateMacAuthOpenApiVO',
  'PortalCandidatesOpenApiVO'
];

const printSchema = (spec, name) => {
  const schema = spec?.components?.schemas?.[name];
  console.log('\n=== SCHEMA: ' + name + ' ===');
  if (!schema) {
    console.log('Not found');
    return;
  }
  console.log(JSON.stringify(schema, null, 2));
};

const printSite = async (site) => {
  const siteId = site.siteId || site.id;
  console.log('\n\n########################################');
  console.log('SITE:', site.name || '(unnamed)');
  console.log('SITE ID:', siteId);
  console.log('########################################');

  try {
    const portals = await omada.listPortals({ siteId });
    console.log('\nPORTALS:');
    console.log(JSON.stringify(portals, null, 2));

    const portalRows = Array.isArray(portals)
      ? portals
      : Array.isArray(portals?.data)
        ? portals.data
        : [];

    for (const portal of portalRows) {
      const portalId = portal.portalId || portal.id;
      if (!portalId) continue;
      try {
        const detail = await omada.getPortalDetail({ siteId, portalId });
        console.log('\nPORTAL DETAIL ' + portalId + ':');
        console.log(JSON.stringify(detail, null, 2));
      } catch (error) {
        console.log('\nPORTAL DETAIL ERROR ' + portalId + ': ' + error.message);
      }
    }
  } catch (error) {
    console.log('\nPORTALS ERROR:', error.message);
  }

  try {
    const radius = await omada.listRadiusProfiles({ siteId });
    console.log('\nRADIUS PROFILES:');
    console.log(JSON.stringify(radius, null, 2));
  } catch (error) {
    console.log('\nRADIUS PROFILES ERROR:', error.message);
  }

  try {
    const macAuth = await omada.getMacAuthSetting({ siteId });
    console.log('\nMAC AUTH:');
    console.log(JSON.stringify(macAuth, null, 2));
  } catch (error) {
    console.log('\nMAC AUTH ERROR:', error.message);
  }
};

const run = async () => {
  if (!omada.configured()) {
    throw new Error('Set OMADA_API_ENABLED=true first');
  }

  await omada.getAccessToken({ force: true });
  const spec = await omada.getOpenApiDocument();

  for (const name of schemaNames) {
    printSchema(spec, name);
  }

  const sites = await omada.listSites();
  console.log('\n\nSITES VISIBLE:', sites.length);

  for (const site of sites) {
    await printSite(site);
  }
};

run()
  .catch((error) => {
    console.error('Omada hotspot reference inspection failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 20);
  });
