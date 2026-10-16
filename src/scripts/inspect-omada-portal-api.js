require('dotenv').config();

const omada = require('../services/omada/open-api-client');

const normalize = (value) => String(value || '').toLowerCase();

const isPortalCandidate = ({ path, method, operation }) => {
  const tags = Array.isArray(operation?.tags) ? operation.tags.join(' ') : '';
  const haystack = normalize([
    path,
    method,
    operation?.summary,
    operation?.description,
    operation?.operationId,
    tags
  ].join(' '));

  if (!/(portal|radius|authentication)/.test(haystack)) {
    return false;
  }

  if (/(voucher|localuser|local-user|survey|authed-record|authorized client|statistics)/.test(haystack)) {
    return false;
  }

  return true;
};

const getRequestSchema = (operation) => {
  const content = operation?.requestBody?.content || {};

  for (const mediaType of Object.keys(content)) {
    const schema = content[mediaType]?.schema;

    if (!schema) continue;

    if (schema.$ref) return schema.$ref;
    if (schema.type) return schema.type;
    return JSON.stringify(schema);
  }

  return null;
};

const run = async () => {
  if (!omada.configured()) {
    throw new Error('Set OMADA_API_ENABLED=true first');
  }

  const info = await omada.getControllerInfo();
  const spec = await omada.getOpenApiDocument();
  const paths = spec?.paths || {};
  const rows = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      const verb = method.toUpperCase();

      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) {
        continue;
      }

      if (!isPortalCandidate({ path, method: verb, operation })) {
        continue;
      }

      rows.push({
        method: verb,
        path,
        summary: operation?.summary || '',
        operationId: operation?.operationId || '',
        tags: Array.isArray(operation?.tags) ? operation.tags.join(', ') : '',
        requestSchema: getRequestSchema(operation) || ''
      });
    }
  }

  rows.sort((a, b) =>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );

  console.log('Omada portal API discovery');
  console.log('Controller version:', info.controllerVersion || 'unknown');
  console.log('OpenAPI paths:', Object.keys(paths).length);
  console.log('Portal/RADIUS candidates:', rows.length);
  console.log('');

  if (!rows.length) {
    console.log('No matching configuration endpoints were found.');
    console.log('The controller may not expose portal-profile configuration through Open API.');
    return;
  }

  for (const row of rows) {
    console.log(row.method + ' ' + row.path);
    if (row.summary) console.log('  summary: ' + row.summary);
    if (row.operationId) console.log('  operationId: ' + row.operationId);
    if (row.tags) console.log('  tags: ' + row.tags);
    if (row.requestSchema) console.log('  request: ' + row.requestSchema);
    console.log('');
  }
};

run()
  .catch((error) => {
    console.error('Omada portal API discovery failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 20);
  });
