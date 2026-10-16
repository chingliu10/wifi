require('dotenv').config();

const pool = require('../config/database');

const money = (value) =>
  Number(value || 0).toLocaleString('en-TZ', {
    maximumFractionDigits: 2
  });

const run = async () => {
  const summary = await pool.query(
    `
      WITH wallet AS (
        SELECT
          organization_id,
          COALESCE(
            SUM(
              CASE
                WHEN entry_type = 'adjustment' AND amount_tzs > 0 THEN 0
                ELSE amount_tzs
              END
            ),
            0
          )::NUMERIC(18,2) AS ledger_balance,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'payout_debit'),
            0
          )::NUMERIC(18,2) AS paid_out,
          COALESCE(
            -SUM(amount_tzs) FILTER (WHERE entry_type = 'payout_fee'),
            0
          )::NUMERIC(18,2) AS payout_fees
        FROM wallet_entries
        GROUP BY organization_id
      ),
      reserved AS (
        SELECT
          organization_id,
          COALESCE(SUM(total_amount_tzs), 0)::NUMERIC(18,2) AS reserved_balance
        FROM payout_transactions
        WHERE status IN ('pending', 'processing')
        GROUP BY organization_id
      ),
      payments AS (
        SELECT
          organization_id,
          COALESCE(
            SUM(amount_tzs) FILTER (WHERE status = 'paid'),
            0
          )::NUMERIC(18,2) AS gross_collected,
          COALESCE(
            SUM(net_amount_tzs) FILTER (
              WHERE status = 'paid'
                AND net_amount_tzs IS NOT NULL
            ),
            0
          )::NUMERIC(18,2) AS net_collected,
          COUNT(*) FILTER (
            WHERE status = 'paid'
              AND (
                gateway_fee_tzs IS NULL
                OR net_amount_tzs IS NULL
              )
          )::INTEGER AS unreconciled_paid
        FROM payment_transactions
        GROUP BY organization_id
      )
      SELECT
        o.id,
        o.name,
        COALESCE(p.gross_collected, 0)::NUMERIC(18,2) AS gross_collected,
        COALESCE(p.net_collected, 0)::NUMERIC(18,2) AS net_collected,
        COALESCE(p.unreconciled_paid, 0)::INTEGER AS unreconciled_paid,
        COALESCE(w.ledger_balance, 0)::NUMERIC(18,2) AS ledger_balance,
        COALESCE(r.reserved_balance, 0)::NUMERIC(18,2) AS reserved_balance,
        (
          COALESCE(w.ledger_balance, 0) -
          COALESCE(r.reserved_balance, 0)
        )::NUMERIC(18,2) AS available_balance,
        COALESCE(w.paid_out, 0)::NUMERIC(18,2) AS paid_out,
        COALESCE(w.payout_fees, 0)::NUMERIC(18,2) AS payout_fees
      FROM organizations o
      LEFT JOIN payments p ON p.organization_id = o.id
      LEFT JOIN wallet w ON w.organization_id = o.id
      LEFT JOIN reserved r ON r.organization_id = o.id
      WHERE o.active = TRUE
      ORDER BY o.id
    `
  );

  const violations = await pool.query(
    `
      SELECT 'payment_scope' AS kind, pt.id::TEXT AS record_id
      FROM payment_transactions pt
      JOIN packages p ON p.id = pt.package_id
      JOIN sites s ON s.id = p.site_id
      WHERE pt.organization_id IS DISTINCT FROM s.organization_id
         OR pt.site_id IS DISTINCT FROM p.site_id

      UNION ALL

      SELECT 'wallet_payment_scope', we.id::TEXT
      FROM wallet_entries we
      JOIN payment_transactions pt
        ON pt.id = we.payment_transaction_id
      WHERE we.organization_id <> pt.organization_id

      UNION ALL

      SELECT 'wallet_payout_scope', we.id::TEXT
      FROM wallet_entries we
      JOIN payout_transactions po
        ON po.id = we.payout_transaction_id
      WHERE we.organization_id <> po.organization_id

      UNION ALL

      SELECT 'payout_requester_scope', po.id::TEXT
      FROM payout_transactions po
      JOIN platform_users pu
        ON pu.id = po.requested_by_user_id
      WHERE pu.role = 'client_owner'
        AND pu.organization_id <> po.organization_id

      UNION ALL

      SELECT 'payout_total_mismatch', po.id::TEXT
      FROM payout_transactions po
      WHERE ABS(po.total_amount_tzs - (po.amount_tzs + po.fee_tzs)) >= 0.01
    `
  );

  console.log('');
  console.log('=== Tenant wallet audit ===');

  let aggregateAvailable = 0;
  let aggregateReserved = 0;

  for (const row of summary.rows) {
    aggregateAvailable += Number(row.available_balance || 0);
    aggregateReserved += Number(row.reserved_balance || 0);

    console.log('');
    console.log('Tenant:', row.name, '(org ' + row.id + ')');
    console.log('  Gross collected:', money(row.gross_collected), 'TZS');
    console.log('  Net collected:', money(row.net_collected), 'TZS');
    console.log('  Ledger balance:', money(row.ledger_balance), 'TZS');
    console.log('  Reserved:', money(row.reserved_balance), 'TZS');
    console.log('  Available:', money(row.available_balance), 'TZS');
    console.log('  Paid out:', money(row.paid_out), 'TZS');
    console.log('  Payout fees:', money(row.payout_fees), 'TZS');
    console.log('  Unreconciled paid payments:', row.unreconciled_paid);
  }

  console.log('');
  console.log('=== Aggregate tenant liability ===');
  console.log('Available across tenants:', money(aggregateAvailable), 'TZS');
  console.log('Reserved across tenants:', money(aggregateReserved), 'TZS');
  console.log(
    'Total tenant funds represented internally:',
    money(aggregateAvailable + aggregateReserved),
    'TZS'
  );

  console.log('');
  console.log('=== Isolation checks ===');

  if (!violations.rowCount) {
    console.log('PASS: no tenant-scope or payout-total violations found.');
  } else {
    console.log('FAIL:', violations.rowCount, 'violation(s) found.');
    for (const row of violations.rows) {
      console.log(' ', row.kind, 'record', row.record_id);
    }
    process.exitCode = 2;
  }
};

run()
  .catch((error) => {
    console.error('Tenant wallet audit failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
