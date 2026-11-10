const pool = require('../../config/database');
const { getSalesScope, hasSalesPermission } = require('../sales-service');
const { normalizeMac, allocateDays } = require('./usage-counters');

const scopeFor = (user, organizationId) => {
  if (!hasSalesPermission(user, 'sales.view_organization')) {
    throw Object.assign(new Error('Usage access is not permitted.'), { statusCode: 403 });
  }
  return getSalesScope(user, organizationId).organizationId;
};
const isInstalled = async (db = pool) => Boolean((await db.query("SELECT to_regclass('public.usage_days') IS NOT NULL AS ready")).rows[0].ready);

const setCollection = async ({ user, organizationId, siteId, enabled }) => {
  const org = scopeFor(user, organizationId);
  const result = await pool.query(`INSERT INTO usage_sites (site_id, organization_id, enabled, enabled_by)
    SELECT id, organization_id, $3, $4 FROM sites WHERE id = $1 AND organization_id = $2
      AND active AND external_portal_site_id IS NOT NULL
    ON CONFLICT (site_id) DO UPDATE SET enabled = EXCLUDED.enabled, enabled_by = EXCLUDED.enabled_by,
      history_supported = NULL, last_error_code = NULL
    RETURNING site_id`, [siteId, org, enabled === true, user.id]);
  if (!result.rowCount) throw Object.assign(new Error('Site not found.'), { statusCode: 404 });
};

const rememberClient = async (db, org, siteId, mac, name) => db.query(`
  INSERT INTO usage_clients (organization_id, site_id, client_mac, client_name)
  VALUES ($1, $2, $3, $4) ON CONFLICT (site_id, client_mac) DO UPDATE
  SET client_name = COALESCE(NULLIF(EXCLUDED.client_name, ''), usage_clients.client_name)`, [org, siteId, mac, name || null]);

const recordReading = async ({ organizationId, siteId, reading, db = pool }) => {
  if (!reading || !normalizeMac(reading.mac) || reading.down < 0n || reading.up < 0n) throw new Error('Invalid usage reading');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['usage:' + siteId + ':' + reading.mac]);
    await rememberClient(client, organizationId, siteId, reading.mac, reading.name);
    await client.query('UPDATE usage_clients SET last_seen_at = GREATEST(last_seen_at, $3) WHERE site_id = $1 AND client_mac = $2',
      [siteId, reading.mac, new Date(reading.observedAt)]);
    const previous = (await client.query(`SELECT * FROM usage_sessions
      WHERE organization_id = $1 AND site_id = $2 AND client_mac = $3
        AND ABS(EXTRACT(EPOCH FROM (started_at - $5::timestamptz))) <= 5
        AND (started_at = $5::timestamptz OR last_counter_at >= $5::timestamptz)
      ORDER BY (controller_id = $4) DESC NULLS LAST,
        ABS(EXTRACT(EPOCH FROM (started_at - $5::timestamptz))), id
      LIMIT 1 FOR UPDATE`, [organizationId, siteId, reading.mac, reading.controllerId,
      new Date(reading.startedAt)])).rows[0];
    if (previous && ((!reading.history && previous.history_confirmed) ||
      reading.observedAt < new Date(previous.last_counter_at).getTime() && !reading.final)) {
      await client.query('COMMIT');
      return previous.id;
    }
    let down = reading.down, up = reading.up, gap = false;
    let from = previous ? new Date(previous.last_counter_at).getTime() : reading.startedAt;
    if (previous) {
      const oldDown = BigInt(reading.history ? previous.download_total : previous.download_counter);
      const oldUp = BigInt(reading.history ? previous.upload_total : previous.upload_counter);
      gap = reading.down < oldDown || reading.up < oldUp;
      down = reading.down > oldDown ? reading.down - oldDown : 0n;
      up = reading.up > oldUp ? reading.up - oldUp : 0n;
    }
    const correction = previous && reading.observedAt <= from && (down > 0n || up > 0n);
    if (correction) from = reading.startedAt;
    let sessionId = previous?.id;
    if (!sessionId) {
      sessionId = (await client.query(`INSERT INTO usage_sessions
        (organization_id, site_id, client_mac, controller_id, started_at, last_counter_at)
        VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [organizationId, siteId, reading.mac, reading.controllerId, new Date(reading.startedAt)])).rows[0].id;
    }
    if (down > 0n || up > 0n) {
      for (const day of allocateDays(from, reading.observedAt, down, up)) {
        await client.query(`INSERT INTO usage_days
          (session_id, organization_id, site_id, usage_date, download_bytes, upload_bytes, estimated)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (session_id, usage_date) DO UPDATE SET
            download_bytes = usage_days.download_bytes + EXCLUDED.download_bytes,
            upload_bytes = usage_days.upload_bytes + EXCLUDED.upload_bytes,
            estimated = usage_days.estimated OR EXCLUDED.estimated`,
        [sessionId, organizationId, siteId, day.day, day.down.toString(), day.up.toString(), day.estimated || correction]);
      }
    }
    await client.query(`UPDATE usage_sessions SET controller_id = COALESCE($2, controller_id),
      last_counter_at = GREATEST(last_counter_at, $3), download_counter = $4, upload_counter = $5,
      download_total = download_total + $6, upload_total = upload_total + $7,
      history_confirmed = history_confirmed OR $8, ended_at = CASE WHEN $8 THEN $3 ELSE ended_at END,
      has_gap = has_gap OR $9 WHERE id = $1`,
    [sessionId, reading.controllerId, new Date(reading.observedAt), reading.down.toString(), reading.up.toString(),
      down.toString(), up.toString(), reading.final, gap]);
    await client.query('COMMIT');
    return sessionId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};

const getReport = async ({ user, organizationId, siteId = null, mac = null, startDate, endDate, search = '' }) => {
  const org = scopeFor(user, organizationId);
  const cleanMac = mac ? normalizeMac(mac) : null;
  if (mac && !cleanMac) throw Object.assign(new Error('Invalid device.'), { statusCode: 400 });
  const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(String(date)) &&
    Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  if (![startDate, endDate].every(validDate) || endDate < startDate ||
    Date.parse(endDate) - Date.parse(startDate) > 365 * 86400000) {
    throw Object.assign(new Error('Choose up to 366 days.'), { statusCode: 400 });
  }
  const sites = (await pool.query(`SELECT s.id, s.name, s.active, s.external_portal_site_id,
    COALESCE(u.enabled, FALSE) AS enabled, u.last_success_at, u.last_attempt_at,
    u.last_error_code, u.history_supported, u.discovered_at
    FROM sites s LEFT JOIN usage_sites u ON u.site_id = s.id
    WHERE s.organization_id = $1 ORDER BY s.name`, [org])).rows;
  const params = [org, startDate, endDate, siteId || null, cleanMac, String(search).trim().slice(0, 100)];
  const filter = `d.organization_id = $1 AND d.usage_date BETWEEN $2::date AND $3::date
    AND ($4::bigint IS NULL OR d.site_id = $4) AND ($5::text IS NULL OR se.client_mac = $5)
    AND ($6::text = '' OR se.client_mac ILIKE '%' || $6 || '%'
      OR COALESCE(c.client_name, '') ILIKE '%' || $6 || '%'
      OR COALESCE(identity.customer_name, '') ILIKE '%' || $6 || '%'
      OR COALESCE(identity.phone, '') ILIKE '%' || $6 || '%')`;
  const from = `FROM usage_days d JOIN usage_sessions se ON se.id = d.session_id
    JOIN usage_clients c ON c.site_id = se.site_id AND c.client_mac = se.client_mac
    JOIN sites s ON s.id = d.site_id
    LEFT JOIN LATERAL (SELECT pt.customer_name, pt.phone FROM payment_transactions pt
      WHERE pt.organization_id = d.organization_id AND pt.status = 'paid'
        AND REPLACE(UPPER(pt.client_mac), '-', ':') = se.client_mac
      ORDER BY pt.paid_at DESC NULLS LAST, pt.id DESC LIMIT 1) identity ON TRUE
    WHERE ${filter}`;
  const [totals, rows, days, sessions] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(d.download_bytes),0) AS download,
      COALESCE(SUM(d.upload_bytes),0) AS upload, COUNT(DISTINCT (d.site_id,se.client_mac)) AS devices,
      COALESCE(BOOL_OR(d.estimated OR se.has_gap),FALSE) AS estimated ${from}`, params),
    pool.query(`SELECT se.client_mac, d.site_id, s.name AS site_name,
      COALESCE(identity.customer_name, c.client_name, se.client_mac) AS name, identity.phone,
      SUM(d.download_bytes) AS download, SUM(d.upload_bytes) AS upload,
      COUNT(DISTINCT se.id) AS visits, BOOL_OR(d.estimated OR se.has_gap) AS estimated,
      BOOL_OR(NOT se.history_confirmed) AS provisional, MAX(c.last_seen_at) AS last_seen_at,
      BOOL_OR(c.is_online AND c.last_seen_at > NOW() - INTERVAL '3 minutes') AS is_online
      ${from} GROUP BY se.client_mac, d.site_id, s.name, identity.customer_name, c.client_name, identity.phone
      ORDER BY SUM(d.download_bytes + d.upload_bytes) DESC, d.site_id, se.client_mac LIMIT 100`, params),
    pool.query(`SELECT d.usage_date::text AS day, SUM(d.download_bytes) AS download,
      SUM(d.upload_bytes) AS upload, BOOL_OR(d.estimated OR se.has_gap) AS estimated
      ${from} GROUP BY d.usage_date ORDER BY d.usage_date DESC LIMIT 366`, params),
    cleanMac ? pool.query(`SELECT se.*, s.name AS site_name FROM usage_sessions se JOIN sites s ON s.id = se.site_id
      WHERE se.organization_id = $1 AND se.client_mac = $2 AND ($3::bigint IS NULL OR se.site_id = $3)
        AND se.started_at < (($5::date + 1)::timestamp AT TIME ZONE 'Africa/Dar_es_Salaam')
        AND se.last_counter_at >= ($4::date::timestamp AT TIME ZONE 'Africa/Dar_es_Salaam')
      ORDER BY se.started_at DESC, se.id DESC LIMIT 100`, [org, cleanMac, siteId || null, startDate, endDate]) : { rows: [] }
  ]);
  return { sites, totals: totals.rows[0], clients: rows.rows, days: days.rows, sessions: sessions.rows, mac: cleanMac };
};
module.exports = { scopeFor, isInstalled, setCollection, rememberClient, recordReading, getReport };
