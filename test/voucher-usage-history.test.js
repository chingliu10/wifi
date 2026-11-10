const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('node:events');
const Handlebars = require('handlebars');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const testUrl = String(process.env.TEST_DATABASE_URL || '').trim();
if (testUrl) process.env.DATABASE_URL = testUrl;
const pool = require('../src/config/database');
const counters = require('../src/services/usage/usage-counters');
const usage = require('../src/services/usage/usage-service');
const worker = require('../src/services/usage/usage-worker');
const { translate } = require('../src/i18n/admin');
const at = time => Date.parse('2026-11-10T' + time + '+03:00');
const now = at('20:00:00');
const mac = '02:11:22:33:44:55';
const live = (start, seen, down, up = 0) => counters.normalizeReading({ mac, trafficDown: down,
  trafficUp: up, uptime: (seen - start) / 1000, lastSeen: seen, name: 'Customer device' }, { now });
const history = (id, start, seen, down, up = 0) => counters.normalizeReading({ id, mac,
  associated: start, lastSeen: seen, download: down, upload: up }, { history: true, now });

test('usage reads documented byte counters and rejects missing, rate-only or unsafe measurements', () => {
  assert.equal(live(at('08:00:00'), at('08:10:00'), 7000000).down, 7000000n);
  assert.equal(counters.normalizeReading({ mac, downloadActivity: 7000000, uptime: 60, lastSeen: now }, { now }), null);
  for (const value of [null, undefined, '', -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.equal(counters.bytes(value), null);
  assert.equal(counters.bytes('9007199254740993'), 9007199254740993n);
  assert.equal(counters.normalizeReading(null), null);
  assert.equal(counters.timestamp(1794301200), 1794301200000);
  assert.equal(history('visit', at('08:00:00'), at('08:20:00'), 8000000).final, true);
});

test('daily allocation preserves every byte at Dar es Salaam midnight and marks estimated splits', () => {
  const rows = counters.allocateDays(Date.parse('2026-11-09T23:59:00+03:00'), at('00:01:00'), 7n, 3n);
  assert.deepEqual(rows.map(row => row.day), ['2026-11-09', '2026-11-10']);
  assert.equal(rows.reduce((sum, row) => sum + row.down, 0n), 7n);
  assert.equal(rows.reduce((sum, row) => sum + row.up, 0n), 3n);
  assert.ok(rows.every(row => row.estimated));
  assert.equal(counters.allocateDays(at('08:00:00'), at('08:10:00'), 7000000n, 0n)[0].estimated, false);
  assert.equal(counters.allocateDays(at('00:00:00'), at('00:00:00'), 1n, 0n)[0].day, '2026-11-10');
  assert.equal(counters.formatBytes(1000000000), '1 GB');
});

test('usage collection reads all pages beyond 25 clients and rejects repeated or incomplete pages', async () => {
  let calls = 0;
  const rows = await worker.pageAll(async page => { calls++; return { rows: Array.from({ length: page === 3 ? 3 : 25 }, (_, i) => ({ mac: page + '-' + i })), total: 53 }; });
  assert.equal(rows.length, 53);
  assert.equal(calls, 3);
  await assert.rejects(worker.pageAll(async () => ({ rows: [{ mac }], total: 3 })), error => error.code === 'usage_pagination');
  await assert.rejects(worker.pageAll(async () => ({ rows: [], total: 10 })), error => error.code === 'usage_pagination');
  assert.deepEqual(await worker.collectOnce({ api: { configured: () => false } }), { sites: 0 });
});

test('usage access excludes cashiers and both languages render setup, history and reward controls', () => {
  assert.throws(() => usage.scopeFor({ id: 9, role: 'cashier', organization_id: 1 }), error => error.statusCode === 403);
  assert.equal(usage.scopeFor({ id: 1, role: 'client_owner', organization_id: 7 }, 999), 7);
  assert.throws(() => usage.scopeFor({ role: 'client_owner', organization_id: 7, active: false }));
  const source = fs.readFileSync(path.join(__dirname, '../views/admin/usage.hbs'), 'utf8');
  for (const language of ['en','sw']) {
    const handlebars = Handlebars.create();
    handlebars.registerHelper('t', key => translate(language, key));
    handlebars.registerHelper('formatDate', value => String(value || ''));
    for (const match of source.matchAll(/\{\{t '([^']+)'/g)) assert.notEqual(translate(language, match[1]), match[1]);
    const render = handlebars.compile(source);
    assert.ok(render({ installed: false }).includes(translate(language, 'usage.notInstalled')));
    const html = render({ installed: true, selectedOrg: { id: 1 }, totals: {}, sites: [],
      clients: [{ canReward: true, client_mac: mac, site_id: 2, name: '<script>unsafe</script>' }] });
    assert.match(html, /action="\/admin\/live-clients\/complimentary-access"/);
    assert.ok(!html.includes('<script>unsafe</script>'));
    assert.ok(html.includes(translate(language, 'usage.reward')));
  }
});

test('usage APIs use the documented read-only endpoints and retain pagination metadata', async t => {
  const http = require('http');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/openapi/authorize/token')
      ? { errorCode: 0, result: { accessToken: 'test-usage-token', expiresIn: 7200 } }
      : req.url.endsWith('/history-enable') ? { errorCode: 0, result: { clientsDataEnable: true } }
        : { errorCode: 0, result: { totalRows: 53, data: [{ mac }] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const keys = ['OMADA_API_ENABLED','OMADA_BASE_URL','OMADA_CLIENT_ID','OMADA_CLIENT_SECRET','OMADA_OMADAC_ID'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OMADA_API_ENABLED: 'true', OMADA_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    OMADA_CLIENT_ID: 'usage-test', OMADA_CLIENT_SECRET: 'usage-test', OMADA_OMADAC_ID: 'test-controller' });
  t.after(async () => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await new Promise(resolve => server.close(resolve)); });
  const api = require('../src/services/omada/open-api-client');
  assert.equal((await api.getUsagePage({ siteId: 'test-site', page: 2 })).total, 53);
  await api.getUsagePage({ siteId: 'test-site', known: true, start: 100, end: 200 });
  await api.getUsagePage({ siteId: 'test-site', clientMac: mac });
  assert.equal(await api.getUsageHistorySetting(), true);
  assert.ok(requests.some(row => row.url.includes('/clients?page=2&pageSize=25')));
  assert.ok(requests.some(row => row.url.includes('/insight/clients?')));
  assert.ok(requests.some(row => row.url.includes('/02-11-22-33-44-55/client-history?')));
  assert.ok(requests.every(row => row.method === 'GET' || row.url.startsWith('/openapi/authorize/token')));
});

test('usage history persists across reconnects, reconciles final counters and isolates business data', {
  skip: testUrl ? false : 'TEST_DATABASE_URL is required; production is never used for usage integration tests'
}, async t => {
  const { createClientOwner, createCashier, createSession } = require('../src/services/auth-service');
  const suffix = crypto.randomBytes(7).toString('hex');
  const tenant = async name => {
    const org = (await pool.query('INSERT INTO organizations (name,slug) VALUES ($1,$2) RETURNING *', [name,name + suffix])).rows[0];
    const site = (await pool.query(`INSERT INTO sites (organization_id,name,slug,external_portal_site_id)
      VALUES ($1,$2,$3,$4) RETURNING *`, [org.id,name,name + suffix,'controller-' + name + suffix])).rows[0];
    const owner = await createClientOwner({ organizationId: org.id, fullName: name, username: name + suffix, password: 'UsageTest123!' });
    return { org, site, owner };
  };
  const a = await tenant('usage-a'), b = await tenant('usage-b');
  const cashier = await createCashier({ organizationId: a.org.id, siteId: a.site.id, fullName: 'Usage cashier', username: 'usage-cashier-' + suffix, password: 'UsageTest123!' });
  const dates = { startDate: '2026-11-10', endDate: '2026-11-10' };
  assert.equal(await usage.isInstalled(), true);
  await assert.rejects(usage.setCollection({ user: a.owner, organizationId: b.org.id, siteId: b.site.id, enabled: true }), error => error.statusCode === 404);
  await usage.setCollection({ user: a.owner, siteId: a.site.id, enabled: true });
  await usage.setCollection({ user: b.owner, siteId: b.site.id, enabled: false });
  const save = reading => usage.recordReading({ organizationId: a.org.id, siteId: a.site.id, reading });

  await t.test('7 MB from the first visit survives a zero reset and a later 20 MB visit', async () => {
    await save({ ...history('first-visit',at('08:00:00'),at('08:10:00'),7000000,1000000),final:false });
    await save({ ...history('second-visit',at('11:00:00'),at('11:00:00'),0,0),final:false });
    await save({ ...history('second-visit',at('11:00:00'),at('11:10:00'),20000000,3000000),final:false });
    const report = await usage.getReport({ user: a.owner, organizationId: b.org.id, ...dates });
    assert.equal(report.totals.download, '27000000'); assert.equal(report.totals.upload, '4000000');
    assert.equal(report.clients.length, 1); assert.equal(report.clients[0].visits, '2');
    assert.equal(report.clients[0].provisional, true);
  });
  await t.test('completed history adds only the missing tail; repeated and concurrent imports are idempotent', async () => {
    const first = history('first-visit', at('08:00:00'), at('08:20:00'), 8000000, 1500000);
    await Promise.all([save(first), save(first)]);
    await save(history('second-visit', at('11:00:00'), at('11:20:00'), 21000000, 3500000));
    await save(first); await save(live(at('08:00:00'), at('08:10:00'), 7000000, 1000000));
    const report = await usage.getReport({ user: a.owner, mac, ...dates });
    assert.equal(report.totals.download, '29000000'); assert.equal(report.totals.upload, '5000000');
    assert.equal(report.sessions.length, 2); assert.ok(report.sessions.every(row => row.history_confirmed));
  });
  await t.test('midnight splits, counter gaps and foreign-scope writes are accounted for honestly', async () => {
    await save(history('overnight', Date.parse('2026-11-09T23:59:00+03:00'), at('00:01:00'), 6000000));
    const today = await usage.getReport({ user: a.owner, ...dates });
    assert.equal(today.totals.download, '32000000'); assert.equal(today.totals.estimated, true);
    const yesterday = await usage.getReport({ user: a.owner, startDate: '2026-11-09', endDate: '2026-11-09' });
    assert.equal(yesterday.totals.download, '3000000');
    await assert.rejects(usage.recordReading({ organizationId: b.org.id, siteId: a.site.id,
      reading: history('foreign', at('14:00:00'), at('14:10:00'), 5000000) }));
    assert.equal((await usage.getReport({ user: b.owner, ...dates })).clients.length, 0);
    await assert.rejects(usage.getReport({ user: cashier, ...dates }), error => error.statusCode === 403);
  });
  await t.test('background collection paginates 53 clients and catches final history without the browser', async () => {
    const calls = [];
    const raws = Array.from({ length: 53 }, (_, i) => ({ mac: '02:AA:00:00:00:' + i.toString(16).padStart(2,'0').toUpperCase(),
      name: 'Device ' + i, trafficDown: 100, trafficUp: 50, lastSeen: now, uptime: 600, active: true }));
    const api = { configured: () => true, getUsageHistorySetting: async () => true,
      getUsagePage: async options => {
        calls.push(options);
        const rows = options.clientMac ? options.clientMac === mac ? [] : [{
          id: 'history-' + options.clientMac, mac: options.clientMac, associated: now - 600000,
          lastSeen: now, download: 100, upload: 50 }] : raws;
        return { total: rows.length, rows: rows.slice((options.page - 1) * 25, options.page * 25) };
      } };
    for (let cycle = 0; cycle < 6; cycle++) await worker.collectOnce({ api, now });
    assert.ok(calls.some(row => !row.known && !row.clientMac && row.page === 3));
    assert.ok(calls.some(row => row.clientMac));
    const report = await usage.getReport({ user: a.owner, ...dates });
    assert.equal(report.clients.length, 54);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM usage_clients WHERE site_id=$1 AND is_online', [a.site.id])).rows[0].count, '53');
    assert.equal(report.totals.download, String(32000000 + 5300));
    await worker.collectOnce({ api, now });
    assert.equal((await usage.getReport({ user: a.owner, ...dates })).totals.download, String(32000000 + 5300));
    const offlineApi = { ...api, getUsagePage: async options => !options.known && !options.clientMac
      ? { rows:[],total:0 } : api.getUsagePage(options) };
    for (let cycle = 0; cycle < 6; cycle++) await worker.collectOnce({ api:offlineApi,now });
    const closed = await usage.getReport({ user:a.owner,...dates });
    assert.equal(closed.totals.download,String(32000000 + 5300));
    assert.ok(closed.clients.every(row => !row.provisional));
    await worker.collectOnce({ api: { ...api, getUsagePage: async () => { throw new Error('Controller offline'); } }, now });
    assert.equal((await usage.getReport({ user: a.owner, ...dates })).totals.download, String(32000000 + 5300));
    assert.equal((await pool.query('SELECT last_error_code FROM usage_sites WHERE site_id=$1', [a.site.id])).rows[0].last_error_code, 'usage_controller');
    await usage.setCollection({ user: a.owner, siteId: a.site.id, enabled: false });
    const before = calls.length; await worker.collectOnce({ api, now }); assert.equal(calls.length, before);
  });
  await t.test('counter drops stay flagged and a reused controller identifier never merges separate visits', async () => {
    const saveB = reading => usage.recordReading({ organizationId:b.org.id,siteId:b.site.id,reading });
    await saveB(live(at('08:00:00'),at('08:10:00'),100));
    await saveB(live(at('08:00:00'),at('08:11:00'),50));
    await saveB(live(at('08:00:00'),at('08:12:00'),60));
    let result = await usage.getReport({ user:b.owner,...dates });
    assert.equal(result.totals.download,'110'); assert.equal(result.totals.estimated,true);
    await saveB(history('reused-id',at('08:00:00'),at('08:20:00'),110));
    await saveB(history('reused-id',at('11:00:00'),at('11:20:00'),200));
    result = await usage.getReport({ user:b.owner,mac,...dates });
    assert.equal(result.sessions.length,2); assert.equal(result.totals.download,'310');
    const fastMac = '02:11:22:33:44:66';
    await saveB({ ...history('fast',at('12:00:00') + 100,at('12:00:00') + 200,7), mac:fastMac });
    await saveB({ ...history('fast',at('12:00:00') + 300,at('12:00:00') + 400,20), mac:fastMac });
    const fast = await usage.getReport({ user:b.owner,mac:fastMac,...dates });
    assert.equal(fast.sessions.length,2); assert.equal(fast.totals.download,'27');
  });
  await t.test('owner routes, manual rewards and cashier blocks preserve existing access behavior', async () => {
    const express = require('express');
    const app = express(); app.use(express.urlencoded({ extended: false }));
    app.use((req,res,next) => { res.render = (view,data) => res.json({ view, installed:data.installed, clients:data.clients, sites:data.sites, totals:data.totals }); next(); });
    app.use('/admin', require('../src/routes/admin'));
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const ownerHeaders = { cookie: 'solidus_session=' + await createSession(a.owner.id) };
    const cashierHeaders = { cookie: 'solidus_session=' + await createSession(cashier.id) };
    const query = '?range=custom&from=2026-11-10&to=2026-11-10&org=' + b.org.id;
    const response = await fetch(origin + '/admin/usage' + query, { headers:ownerHeaders }); assert.equal(response.status,200);
    const body = await response.json(); assert.equal(body.installed,true); assert.equal(body.clients.length,54);
    assert.ok(body.sites.every(row => Number(row.id) !== Number(b.site.id)));
    const blocked = await fetch(origin + '/admin/usage' + query, { headers:cashierHeaders,redirect:'manual' });
    assert.equal(blocked.status,302); assert.equal(blocked.headers.get('location'),'/admin/cashier');
    const settings = await fetch(origin + '/admin/usage/sites/' + b.site.id + '/collection', { method:'POST',headers:ownerHeaders,
      body:new URLSearchParams({ enabled:'true' }),redirect:'manual' }); assert.equal(settings.status,404);
    const reward = await fetch(origin + '/admin/live-clients/complimentary-access', { method:'POST', headers:ownerHeaders,
      body:new URLSearchParams({ siteId:a.site.id,clientMac:mac,durationSeconds:'3600',grantNote:'Usage reward' }),redirect:'manual' });
    assert.equal(reward.status,302);
    const rewards = await pool.query(`SELECT sub.access_source FROM subscriptions sub JOIN devices d ON d.id=sub.device_id
      WHERE sub.site_id=$1 AND d.mac_address=$2`, [a.site.id,mac]);
    assert.ok(rewards.rows.some(row => row.access_source === 'complimentary'));
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM voucher_sales WHERE organization_id=$1', [a.org.id])).rows[0].count,'0');
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM wallet_entries WHERE organization_id=$1', [a.org.id])).rows[0].count,'0');
  });
});
test.after(() => pool.end());
