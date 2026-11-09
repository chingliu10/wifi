const pool = require('../config/database');

const REPORT_TIMEZONE = 'Africa/Dar_es_Salaam';
// Reporting only: issuing/redeeming/voiding vouchers never calls this query.
// Keep the same first-use rule in the sales list, dashboard and P&L.
// Admin batches have no cashier sale row, so use their saved package terms.
const REDEEMED_VOUCHER_SALES_SQL = `(
  SELECT vs.id, v.id AS voucher_id, v.organization_id, v.site_id, vb.package_id,
    vs.cashier_user_id,
    COALESCE(vs.cashier_user_id, vb.created_by_user_id) AS issued_by_user_id,
    CASE WHEN vs.id IS NULL THEN 'AV-' || v.id::text ELSE 'V-' || vs.id::text END AS sale_reference,
    COALESCE(vs.package_name_snapshot, vb.package_name_snapshot) AS package_name_snapshot,
    COALESCE(vs.package_duration_seconds_snapshot, vb.package_duration_seconds_snapshot) AS package_duration_seconds_snapshot,
    COALESCE(vs.sale_price_tzs, vb.package_price_tzs_snapshot) AS sale_price_tzs,
    COALESCE(vs.sale_status, 'issued') AS sale_status,
    COALESCE(vs.issued_at, v.created_at) AS issued_at,
    v.redeemed_at AS sold_at, v.code_last4
  FROM vouchers v
  JOIN voucher_batches vb ON vb.id = v.batch_id
  LEFT JOIN voucher_sales vs ON vs.voucher_id = v.id
  WHERE v.status = 'redeemed' AND v.redeemed_at IS NOT NULL
    AND (vs.sale_status = 'issued' OR (vs.id IS NULL AND vb.batch_type = 'admin'))
)`;
const ROLE_PERMISSIONS = Object.freeze({
  cashier: ['sales.view_own', 'vouchers.view_own'],
  client_owner: ['sales.view_organization'],
  super_admin: ['sales.view_organization']
});

const hasSalesPermission = (user, permission) =>
  Boolean(user && user.active !== false && ROLE_PERMISSIONS[user.role]?.includes(permission));

const accessError = () => Object.assign(new Error('Sales access is not permitted.'), { statusCode: 403 });

const positiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The authenticated user supplies the scope. Filters can only narrow it.
const getSalesScope = (user, organizationId) => {
  if (hasSalesPermission(user, 'sales.view_own')) {
    const scope = {
      organizationId: positiveId(user.organization_id),
      cashierUserId: positiveId(user.id)
    };
    if (!scope.organizationId || !scope.cashierUserId) throw accessError();
    return scope;
  }
  if (!hasSalesPermission(user, 'sales.view_organization')) throw accessError();
  const scopedOrganizationId = user.role === 'super_admin'
    ? positiveId(organizationId)
    : positiveId(user.organization_id);
  if (!scopedOrganizationId) throw accessError();
  return { organizationId: scopedOrganizationId, cashierUserId: null };
};

const validDate = (value) => {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date : null;
};

const normalizePage = (value) => Math.max(1, Math.min(1000000, Math.floor(Number(value) || 1)));
const normalizePageSize = (value) => Math.max(1, Math.min(100, Math.floor(Number(value) || 25)));

const pageResult = (row, page, pageSize, key) => {
  const total = Number(row.total || 0);
  return {
    ...row,
    total,
    page: Math.min(page, Math.max(1, Math.ceil(total / pageSize))),
    pageSize,
    [key]: row[key] || []
  };
};

const listSales = async ({ user, organizationId, source = '', siteId, cashierUserId, issuerUserId,
  search = '', startDate, endDate, page = 1, pageSize = 25 }) => {
  const scope = getSalesScope(user, organizationId);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const safeSource = scope.cashierUserId ? 'voucher' : ['gateway', 'voucher'].includes(source) ? source : '';
  // Cashier reports never query gateway records; owners retain the combined report.
  const result = await pool.query(`
    WITH sales AS (
      ${scope.cashierUserId ? '' : `
      SELECT 'gateway'::text AS source, pt.id, pt.reference,
        pt.site_id, COALESCE(pt.site_name_snapshot, s.name) AS site_name,
        NULL::bigint AS cashier_user_id, NULL::text AS cashier_name,
        COALESCE(pt.package_name_snapshot, p.name) AS package_name,
        pt.amount_tzs::numeric AS amount_tzs, pt.gateway_fee_tzs, pt.net_amount_tzs,
        pt.customer_name, pt.phone, pt.paid_at AS sold_at, pt.created_at AS issued_at,
        NULL::text AS code_last4, pt.provisioning_status AS access_status,
        NULL::bigint AS voucher_id, NULL::bigint AS issued_by_user_id, NULL::text AS issued_by_name
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      JOIN sites s ON s.id = pt.site_id
      WHERE pt.organization_id = $1 AND pt.status = 'paid'
        AND $2::bigint IS NULL

      UNION ALL
      `}

      SELECT 'voucher'::text AS source, COALESCE(vs.id, vs.voucher_id) AS id, vs.sale_reference AS reference,
        vs.site_id, s.name AS site_name, vs.cashier_user_id,
        CASE WHEN vs.cashier_user_id IS NOT NULL THEN u.full_name END AS cashier_name,
        vs.package_name_snapshot AS package_name, vs.sale_price_tzs::numeric AS amount_tzs,
        NULL::numeric AS gateway_fee_tzs, NULL::numeric AS net_amount_tzs,
        NULL::text AS customer_name, NULL::text AS phone, vs.sold_at, vs.issued_at,
        vs.code_last4::text AS code_last4, 'redeemed'::text AS access_status,
        vs.voucher_id, vs.issued_by_user_id, u.full_name AS issued_by_name
      FROM ${REDEEMED_VOUCHER_SALES_SQL} vs
      JOIN sites s ON s.id = vs.site_id
      LEFT JOIN platform_users u ON u.id = vs.issued_by_user_id
      WHERE vs.organization_id = $1 AND vs.sale_status = 'issued'
        AND ($2::bigint IS NULL OR vs.cashier_user_id = $2)
    ), filtered AS (
      SELECT * FROM sales
      WHERE ($3::text = '' OR source = $3)
        AND ($4::bigint IS NULL OR site_id = $4)
        AND ($5::bigint IS NULL OR issued_by_user_id = $5)
        AND ($6::text = '' OR reference ILIKE '%' || $6 || '%'
          OR package_name ILIKE '%' || $6 || '%'
          OR COALESCE(issued_by_name, '') ILIKE '%' || $6 || '%'
          OR COALESCE(customer_name, '') ILIKE '%' || $6 || '%'
          OR COALESCE(phone, '') ILIKE '%' || $6 || '%'
          OR COALESCE(code_last4, '') ILIKE '%' || $6 || '%')
        AND ($7::date IS NULL OR sold_at >= ($7::date::timestamp AT TIME ZONE '${REPORT_TIMEZONE}'))
        AND ($8::date IS NULL OR sold_at < (($8::date + 1)::timestamp AT TIME ZONE '${REPORT_TIMEZONE}'))
    ), summary AS (
      SELECT COUNT(*)::integer AS total, COALESCE(SUM(amount_tzs), 0) AS total_sales_tzs,
        COALESCE(SUM(amount_tzs) FILTER (WHERE source = 'voucher'), 0) AS voucher_sales_tzs,
        COALESCE(SUM(amount_tzs) FILTER (WHERE source = 'gateway'), 0) AS gateway_sales_tzs,
        SUM(gateway_fee_tzs) AS gateway_fees_tzs,
        SUM(net_amount_tzs) AS gateway_net_tzs,
        COUNT(*) FILTER (WHERE source = 'gateway' AND
          (gateway_fee_tzs IS NULL OR net_amount_tzs IS NULL))::integer AS unreconciled_count
      FROM filtered
    ), paged AS (
      SELECT * FROM filtered ORDER BY sold_at DESC NULLS LAST, source, id DESC, voucher_id DESC NULLS LAST
      LIMIT $9::integer OFFSET (
        LEAST($10::integer, GREATEST(1, CEIL((SELECT total FROM summary)::numeric / $9)::integer)) - 1
      ) * $9
    )
    SELECT summary.*, COALESCE((SELECT json_agg(paged ORDER BY sold_at DESC NULLS LAST, source, id DESC, voucher_id DESC NULLS LAST)
      FROM paged), '[]'::json) AS sales FROM summary
  `, [scope.organizationId, scope.cashierUserId, safeSource, positiveId(siteId),
    scope.cashierUserId || positiveId(issuerUserId) || positiveId(cashierUserId), String(search || '').trim().slice(0, 100),
    validDate(startDate), validDate(endDate), safePageSize, safePage]);
  return pageResult(result.rows[0], safePage, safePageSize, 'sales');
};

const listVoucherIssuers = async ({ user, organizationId }) => {
  if (!hasSalesPermission(user, 'sales.view_organization')) throw accessError();
  const scope = getSalesScope(user, organizationId);
  const result = await pool.query(`
    SELECT id, full_name FROM platform_users
    WHERE id IN (
      SELECT cashier_user_id FROM voucher_sales WHERE organization_id = $1
      UNION
      SELECT created_by_user_id FROM voucher_batches WHERE organization_id = $1
    )
    ORDER BY full_name, id
  `, [scope.organizationId]);
  return result.rows;
};

const getCashierActivity = async ({ user, startDate, endDate }) => {
  if (!hasSalesPermission(user, 'sales.view_own')) throw accessError();
  const scope = getSalesScope(user);
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE (vs.issued_at AT TIME ZONE '${REPORT_TIMEZONE}')::date =
        (NOW() AT TIME ZONE '${REPORT_TIMEZONE}')::date)::integer AS issued_today,
      COALESCE(SUM(vs.sale_price_tzs) FILTER (WHERE (vs.issued_at AT TIME ZONE '${REPORT_TIMEZONE}')::date =
        (NOW() AT TIME ZONE '${REPORT_TIMEZONE}')::date), 0) AS expected_cash_today,
      COUNT(*) FILTER (WHERE v.status = 'redeemed' AND (v.redeemed_at AT TIME ZONE '${REPORT_TIMEZONE}')::date =
        (NOW() AT TIME ZONE '${REPORT_TIMEZONE}')::date)::integer AS redeemed_today,
      COALESCE(SUM(vs.sale_price_tzs) FILTER (WHERE v.status = 'redeemed'
        AND (v.redeemed_at AT TIME ZONE '${REPORT_TIMEZONE}')::date =
        (NOW() AT TIME ZONE '${REPORT_TIMEZONE}')::date), 0) AS used_sales_today_tzs,
      COUNT(*) FILTER (WHERE v.status = 'unused' AND vb.active
        AND (vb.redeemable_until IS NULL OR vb.redeemable_until >= NOW()))::integer AS waiting_today,
      COALESCE(SUM(vs.sale_price_tzs) FILTER (WHERE v.status = 'unused' AND vb.active
        AND (vb.redeemable_until IS NULL OR vb.redeemable_until >= NOW())), 0) AS unused_value_tzs,
      COUNT(*) FILTER (WHERE ($3::date IS NULL OR vs.issued_at >=
        ($3::date::timestamp AT TIME ZONE '${REPORT_TIMEZONE}'))
        AND ($4::date IS NULL OR vs.issued_at <
        (($4::date + 1)::timestamp AT TIME ZONE '${REPORT_TIMEZONE}')))::integer AS issued_period,
      COALESCE(SUM(vs.sale_price_tzs) FILTER (WHERE ($3::date IS NULL OR vs.issued_at >=
        ($3::date::timestamp AT TIME ZONE '${REPORT_TIMEZONE}'))
        AND ($4::date IS NULL OR vs.issued_at <
        (($4::date + 1)::timestamp AT TIME ZONE '${REPORT_TIMEZONE}'))), 0) AS expected_cash_period
    FROM voucher_sales vs JOIN vouchers v ON v.id = vs.voucher_id
    JOIN voucher_batches vb ON vb.id = v.batch_id
    WHERE vs.organization_id = $1 AND vs.cashier_user_id = $2 AND vs.sale_status = 'issued'
  `, [scope.organizationId, scope.cashierUserId, validDate(startDate), validDate(endDate)]);
  return result.rows[0];
};

const listCashierVouchers = async ({ user, status = '', search = '', page = 1, pageSize = 25 }) => {
  if (!hasSalesPermission(user, 'vouchers.view_own')) throw accessError();
  const scope = getSalesScope(user);
  const safeStatus = ['unused', 'redeemed', 'voided', 'cancelled', 'expired'].includes(status) ? status : '';
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const result = await pool.query(`
    WITH activity AS (
      SELECT vs.id, vs.package_name_snapshot AS package_name, vs.sale_price_tzs AS amount_tzs,
        vs.issued_at, v.redeemed_at, v.code_last4,
        CASE WHEN vs.sale_status = 'voided' THEN 'voided'
          WHEN v.status = 'unused' AND vb.redeemable_until < NOW() THEN 'expired'
          ELSE v.status END AS status
      FROM voucher_sales vs JOIN vouchers v ON v.id = vs.voucher_id
      JOIN voucher_batches vb ON vb.id = v.batch_id
      WHERE vs.organization_id = $1 AND vs.cashier_user_id = $2
    ), filtered AS (
      SELECT * FROM activity WHERE ($3::text = '' OR status = $3)
        AND ($4::text = '' OR code_last4 ILIKE '%' || $4 || '%'
          OR package_name ILIKE '%' || $4 || '%' OR id::text = $4)
    ), summary AS (SELECT COUNT(*)::integer AS total FROM filtered), paged AS (
      SELECT * FROM filtered ORDER BY issued_at DESC, id DESC
      LIMIT $5::integer OFFSET (
        LEAST($6::integer, GREATEST(1, CEIL((SELECT total FROM summary)::numeric / $5)::integer)) - 1
      ) * $5
    )
    SELECT summary.*, COALESCE((SELECT json_agg(paged ORDER BY issued_at DESC, id DESC)
      FROM paged), '[]'::json) AS vouchers FROM summary
  `, [scope.organizationId, scope.cashierUserId, safeStatus,
    String(search || '').trim().slice(0, 100), safePageSize, safePage]);
  return pageResult(result.rows[0], safePage, safePageSize, 'vouchers');
};

module.exports = { REDEEMED_VOUCHER_SALES_SQL, hasSalesPermission, getSalesScope, listSales, listVoucherIssuers, getCashierActivity, listCashierVouchers };
