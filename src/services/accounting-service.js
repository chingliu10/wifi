const pool = require('../config/database');

const EXPENSE_CATEGORIES = new Set([
  'bandwidth',
  'electricity',
  'site_rent',
  'voucher_commission',
  'hosting',
  'transport',
  'maintenance',
  'marketing',
  'staff',
  'licenses',
  'other'
]);

const PAYMENT_METHODS = new Set([
  'cash',
  'mobile_money',
  'bank',
  'wallet',
  'other'
]);

const ASSET_TYPES = new Set([
  'access_point',
  'router',
  'switch',
  'ups',
  'mast',
  'cabling',
  'computer',
  'power_equipment',
  'other'
]);

const normalizeOptionalId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const requirePositiveInteger = (value, message) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(message);
  }

  return parsed;
};

const getAccountingOptions = async (organizationId) => {
  const [sitesResult, cashiersResult] = await Promise.all([
    pool.query(
      `
        SELECT id, name
        FROM sites
        WHERE organization_id = $1
          AND active = TRUE
        ORDER BY name
      `,
      [organizationId]
    ),
    pool.query(
      `
        SELECT
          u.id,
          u.full_name,
          u.username,
          s.name AS site_name
        FROM platform_users u
        JOIN sites s ON s.id = u.site_id
        WHERE u.organization_id = $1
          AND u.role = 'cashier'
          AND u.active = TRUE
        ORDER BY u.full_name, u.id
      `,
      [organizationId]
    )
  ]);

  return {
    sites: sitesResult.rows,
    cashiers: cashiersResult.rows
  };
};

const createExpense = async ({
  organizationId,
  siteId,
  category,
  description,
  amountTzs,
  expenseDate,
  vendor,
  paymentMethod,
  reference,
  cashierUserId,
  notes,
  createdByUserId
}) => {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  const normalizedPaymentMethod = String(paymentMethod || 'cash')
    .trim()
    .toLowerCase();
  const amount = requirePositiveInteger(
    amountTzs,
    'Expense amount must be greater than zero.'
  );
  const safeDescription = String(description || '').trim().slice(0, 180);

  if (!EXPENSE_CATEGORIES.has(normalizedCategory)) {
    throw new Error('Invalid expense category.');
  }

  if (!PAYMENT_METHODS.has(normalizedPaymentMethod)) {
    throw new Error('Invalid payment method.');
  }

  if (!safeDescription) {
    throw new Error('Expense description is required.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expenseDate || ''))) {
    throw new Error('A valid expense date is required.');
  }

  const result = await pool.query(
    `
      INSERT INTO accounting_expenses (
        organization_id,
        site_id,
        category,
        description,
        amount_tzs,
        expense_date,
        vendor,
        payment_method,
        reference,
        cashier_user_id,
        notes,
        created_by_user_id
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12
      )
      RETURNING *
    `,
    [
      organizationId,
      normalizeOptionalId(siteId),
      normalizedCategory,
      safeDescription,
      amount,
      expenseDate,
      String(vendor || '').trim().slice(0, 160) || null,
      normalizedPaymentMethod,
      String(reference || '').trim().slice(0, 160) || null,
      normalizeOptionalId(cashierUserId),
      String(notes || '').trim().slice(0, 2000) || null,
      createdByUserId
    ]
  );

  return result.rows[0];
};

const voidExpense = async ({
  organizationId,
  expenseId,
  voidedByUserId,
  reason
}) => {
  const safeReason = String(reason || '').trim().slice(0, 250);

  if (!safeReason) {
    throw new Error('A reason is required to void an expense.');
  }

  const result = await pool.query(
    `
      UPDATE accounting_expenses
      SET
        status = 'voided',
        voided_at = NOW(),
        voided_by_user_id = $3,
        void_reason = $4,
        updated_at = NOW()
      WHERE id = $1
        AND organization_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [expenseId, organizationId, voidedByUserId, safeReason]
  );

  return result.rows[0] || null;
};

const listExpenses = async ({
  organizationId,
  siteId = null,
  category = '',
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = 25
}) => {
  const safeCategory = EXPENSE_CATEGORIES.has(String(category || '').toLowerCase())
    ? String(category).toLowerCase()
    : '';
  const safeSiteId = normalizeOptionalId(siteId);
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (safePage - 1) * safePageSize;

  const result = await pool.query(
    `
      SELECT
        e.*,
        s.name AS site_name,
        cashier.full_name AS cashier_name,
        cashier.username AS cashier_username,
        creator.full_name AS created_by_name,
        COUNT(*) OVER()::INTEGER AS filtered_total
      FROM accounting_expenses e
      LEFT JOIN sites s ON s.id = e.site_id
      LEFT JOIN platform_users cashier ON cashier.id = e.cashier_user_id
      JOIN platform_users creator ON creator.id = e.created_by_user_id
      WHERE e.organization_id = $1
        AND ($2::bigint IS NULL OR e.site_id = $2)
        AND ($3::text = '' OR e.category = $3)
        AND ($4::date IS NULL OR e.expense_date >= $4::date)
        AND ($5::date IS NULL OR e.expense_date <= $5::date)
      ORDER BY e.expense_date DESC, e.id DESC
      LIMIT $6 OFFSET $7
    `,
    [
      organizationId,
      safeSiteId,
      safeCategory,
      startDate,
      endDate,
      safePageSize,
      offset
    ]
  );

  return {
    expenses: result.rows,
    total: result.rows[0]?.filtered_total || 0,
    filters: {
      siteId: safeSiteId,
      category: safeCategory,
      startDate,
      endDate
    }
  };
};

const createAsset = async ({
  organizationId,
  siteId,
  assetType,
  name,
  purchasePriceTzs,
  purchaseDate,
  vendor,
  reference,
  usefulLifeMonths,
  notes,
  createdByUserId
}) => {
  const normalizedType = String(assetType || '').trim().toLowerCase();
  const purchasePrice = requirePositiveInteger(
    purchasePriceTzs,
    'Purchase price must be greater than zero.'
  );
  const safeName = String(name || '').trim().slice(0, 180);
  const usefulLife = normalizeOptionalId(usefulLifeMonths);

  if (!ASSET_TYPES.has(normalizedType)) {
    throw new Error('Invalid asset type.');
  }

  if (!safeName) {
    throw new Error('Asset name is required.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(purchaseDate || ''))) {
    throw new Error('A valid purchase date is required.');
  }

  const result = await pool.query(
    `
      INSERT INTO accounting_assets (
        organization_id,
        site_id,
        asset_type,
        name,
        purchase_price_tzs,
        purchase_date,
        vendor,
        reference,
        useful_life_months,
        notes,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      organizationId,
      normalizeOptionalId(siteId),
      normalizedType,
      safeName,
      purchasePrice,
      purchaseDate,
      String(vendor || '').trim().slice(0, 160) || null,
      String(reference || '').trim().slice(0, 160) || null,
      usefulLife,
      String(notes || '').trim().slice(0, 2000) || null,
      createdByUserId
    ]
  );

  return result.rows[0];
};

const disposeAsset = async ({
  organizationId,
  assetId,
  disposedByUserId,
  note
}) => {
  const safeNote = String(note || '').trim().slice(0, 250);

  if (!safeNote) {
    throw new Error('A disposal note is required.');
  }

  const result = await pool.query(
    `
      UPDATE accounting_assets
      SET
        status = 'disposed',
        disposed_at = NOW(),
        disposed_by_user_id = $3,
        disposal_note = $4,
        updated_at = NOW()
      WHERE id = $1
        AND organization_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [assetId, organizationId, disposedByUserId, safeNote]
  );

  return result.rows[0] || null;
};

const listAssets = async ({
  organizationId,
  siteId = null,
  assetType = '',
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = 25
}) => {
  const safeAssetType = ASSET_TYPES.has(String(assetType || '').toLowerCase())
    ? String(assetType).toLowerCase()
    : '';
  const safeSiteId = normalizeOptionalId(siteId);
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (safePage - 1) * safePageSize;

  const result = await pool.query(
    `
      SELECT
        a.*,
        s.name AS site_name,
        creator.full_name AS created_by_name,
        COUNT(*) OVER()::INTEGER AS filtered_total
      FROM accounting_assets a
      LEFT JOIN sites s ON s.id = a.site_id
      JOIN platform_users creator ON creator.id = a.created_by_user_id
      WHERE a.organization_id = $1
        AND ($2::bigint IS NULL OR a.site_id = $2)
        AND ($3::text = '' OR a.asset_type = $3)
        AND ($4::date IS NULL OR a.purchase_date >= $4::date)
        AND ($5::date IS NULL OR a.purchase_date <= $5::date)
      ORDER BY a.purchase_date DESC, a.id DESC
      LIMIT $6 OFFSET $7
    `,
    [
      organizationId,
      safeSiteId,
      safeAssetType,
      startDate,
      endDate,
      safePageSize,
      offset
    ]
  );

  return {
    assets: result.rows,
    total: result.rows[0]?.filtered_total || 0,
    filters: {
      siteId: safeSiteId,
      assetType: safeAssetType,
      startDate,
      endDate
    }
  };
};

const getAccountingReport = async ({
  organizationId,
  siteId = null,
  startDate = null,
  endDate = null
}) => {
  const safeSiteId = normalizeOptionalId(siteId);

  const [
    summaryResult,
    expenseCategoryResult,
    trendResult,
    siteResult
  ] = await Promise.all([
    pool.query(
      `
        WITH gateway AS (
          SELECT
            COUNT(*)::INTEGER AS transactions,
            COALESCE(SUM(amount_tzs), 0)::BIGINT AS gross,
            COALESCE(
              SUM(
                COALESCE(
                  gateway_fee_tzs,
                  CASE
                    WHEN net_amount_tzs IS NOT NULL
                    THEN GREATEST(amount_tzs - net_amount_tzs, 0)
                    ELSE 0
                  END
                )
              ),
              0
            )::BIGINT AS fees,
            COALESCE(
              SUM(
                COALESCE(
                  net_amount_tzs,
                  amount_tzs - COALESCE(gateway_fee_tzs, 0)
                )
              ),
              0
            )::BIGINT AS net
          FROM payment_transactions
          WHERE organization_id = $1
            AND status = 'paid'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (
              $3::date IS NULL
              OR (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $3::date
            )
            AND (
              $4::date IS NULL
              OR (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $4::date
            )
        ),
        voucher AS (
          SELECT
            COUNT(*)::INTEGER AS sales,
            COALESCE(SUM(sale_price_tzs), 0)::BIGINT AS gross
          FROM voucher_sales
          WHERE organization_id = $1
            AND sale_status = 'issued'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (
              $3::date IS NULL
              OR (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $3::date
            )
            AND (
              $4::date IS NULL
              OR (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $4::date
            )
        ),
        expense AS (
          SELECT
            COALESCE(SUM(amount_tzs), 0)::BIGINT AS total,
            COALESCE(SUM(amount_tzs) FILTER (
              WHERE category = 'bandwidth'
            ), 0)::BIGINT AS bandwidth,
            COALESCE(SUM(amount_tzs) FILTER (
              WHERE category = 'voucher_commission'
            ), 0)::BIGINT AS voucher_commission,
            COALESCE(SUM(amount_tzs) FILTER (
              WHERE category NOT IN ('bandwidth', 'voucher_commission')
            ), 0)::BIGINT AS operating
          FROM accounting_expenses
          WHERE organization_id = $1
            AND status = 'active'
            AND (
              $2::bigint IS NULL
              OR site_id = $2
            )
            AND ($3::date IS NULL OR expense_date >= $3::date)
            AND ($4::date IS NULL OR expense_date <= $4::date)
        ),
        asset AS (
          SELECT
            COUNT(*)::INTEGER AS purchases,
            COALESCE(SUM(purchase_price_tzs), 0)::BIGINT AS investment
          FROM accounting_assets
          WHERE organization_id = $1
            AND ($2::bigint IS NULL OR site_id = $2)
            AND ($3::date IS NULL OR purchase_date >= $3::date)
            AND ($4::date IS NULL OR purchase_date <= $4::date)
        )
        SELECT
          gateway.transactions AS gateway_transactions,
          gateway.gross AS gateway_gross,
          gateway.fees AS gateway_fees,
          gateway.net AS gateway_net,
          voucher.sales AS voucher_sales,
          voucher.gross AS voucher_gross,
          expense.total AS manual_expenses,
          expense.bandwidth AS bandwidth_expense,
          expense.voucher_commission AS voucher_commission,
          expense.operating AS operating_expenses,
          asset.purchases AS asset_purchases,
          asset.investment AS capital_investment
        FROM gateway, voucher, expense, asset
      `,
      [organizationId, safeSiteId, startDate, endDate]
    ),
    pool.query(
      `
        SELECT
          category,
          COUNT(*)::INTEGER AS entries,
          SUM(amount_tzs)::BIGINT AS amount
        FROM accounting_expenses
        WHERE organization_id = $1
          AND status = 'active'
          AND ($2::bigint IS NULL OR site_id = $2)
          AND ($3::date IS NULL OR expense_date >= $3::date)
          AND ($4::date IS NULL OR expense_date <= $4::date)
        GROUP BY category
        ORDER BY amount DESC, category
      `,
      [organizationId, safeSiteId, startDate, endDate]
    ),
    pool.query(
      `
        WITH bounds AS (
          SELECT
            COALESCE($3::date, (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date - 29) AS start_day,
            COALESCE($4::date, (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date) AS end_day
        ),
        days AS (
          SELECT generate_series(
            (SELECT start_day FROM bounds),
            (SELECT end_day FROM bounds),
            INTERVAL '1 day'
          )::date AS day
        ),
        gateway AS (
          SELECT
            (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date AS day,
            SUM(amount_tzs)::BIGINT AS amount
          FROM payment_transactions
          WHERE organization_id = $1
            AND status = 'paid'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
              BETWEEN (SELECT start_day FROM bounds)
                  AND (SELECT end_day FROM bounds)
          GROUP BY 1
        ),
        voucher AS (
          SELECT
            (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date AS day,
            SUM(sale_price_tzs)::BIGINT AS amount
          FROM voucher_sales
          WHERE organization_id = $1
            AND sale_status = 'issued'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
              BETWEEN (SELECT start_day FROM bounds)
                  AND (SELECT end_day FROM bounds)
          GROUP BY 1
        ),
        expenses AS (
          SELECT
            expense_date AS day,
            SUM(amount_tzs)::BIGINT AS amount
          FROM accounting_expenses
          WHERE organization_id = $1
            AND status = 'active'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND expense_date
              BETWEEN (SELECT start_day FROM bounds)
                  AND (SELECT end_day FROM bounds)
          GROUP BY expense_date
        )
        SELECT
          days.day,
          COALESCE(gateway.amount, 0)::BIGINT AS gateway,
          COALESCE(voucher.amount, 0)::BIGINT AS voucher,
          COALESCE(expenses.amount, 0)::BIGINT AS expenses
        FROM days
        LEFT JOIN gateway ON gateway.day = days.day
        LEFT JOIN voucher ON voucher.day = days.day
        LEFT JOIN expenses ON expenses.day = days.day
        ORDER BY days.day
        LIMIT 366
      `,
      [organizationId, safeSiteId, startDate, endDate]
    ),
    pool.query(
      `
        WITH site_base AS (
          SELECT id, name
          FROM sites
          WHERE organization_id = $1
            AND ($2::bigint IS NULL OR id = $2)
        ),
        gateway AS (
          SELECT
            site_id,
            SUM(amount_tzs)::BIGINT AS amount
          FROM payment_transactions
          WHERE organization_id = $1
            AND status = 'paid'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (
              $3::date IS NULL
              OR (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $3::date
            )
            AND (
              $4::date IS NULL
              OR (paid_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $4::date
            )
          GROUP BY site_id
        ),
        voucher AS (
          SELECT
            site_id,
            SUM(sale_price_tzs)::BIGINT AS amount
          FROM voucher_sales
          WHERE organization_id = $1
            AND sale_status = 'issued'
            AND ($2::bigint IS NULL OR site_id = $2)
            AND (
              $3::date IS NULL
              OR (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date >= $3::date
            )
            AND (
              $4::date IS NULL
              OR (issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date <= $4::date
            )
          GROUP BY site_id
        ),
        expense AS (
          SELECT
            site_id,
            SUM(amount_tzs)::BIGINT AS amount
          FROM accounting_expenses
          WHERE organization_id = $1
            AND status = 'active'
            AND site_id IS NOT NULL
            AND ($2::bigint IS NULL OR site_id = $2)
            AND ($3::date IS NULL OR expense_date >= $3::date)
            AND ($4::date IS NULL OR expense_date <= $4::date)
          GROUP BY site_id
        )
        SELECT
          site_base.id,
          site_base.name,
          COALESCE(gateway.amount, 0)::BIGINT AS gateway,
          COALESCE(voucher.amount, 0)::BIGINT AS voucher,
          COALESCE(expense.amount, 0)::BIGINT AS expenses
        FROM site_base
        LEFT JOIN gateway ON gateway.site_id = site_base.id
        LEFT JOIN voucher ON voucher.site_id = site_base.id
        LEFT JOIN expense ON expense.site_id = site_base.id
        ORDER BY (
          COALESCE(gateway.amount, 0) +
          COALESCE(voucher.amount, 0)
        ) DESC,
        site_base.name
      `,
      [organizationId, safeSiteId, startDate, endDate]
    )
  ]);

  const base = summaryResult.rows[0] || {};
  const gatewayGross = Number(base.gateway_gross || 0);
  const gatewayFees = Number(base.gateway_fees || 0);
  const voucherGross = Number(base.voucher_gross || 0);
  const bandwidth = Number(base.bandwidth_expense || 0);
  const voucherCommission = Number(base.voucher_commission || 0);
  const operatingExpenses = Number(base.operating_expenses || 0);
  const totalRevenue = gatewayGross + voucherGross;
  const grossProfit = totalRevenue - bandwidth;
  const sellingCosts = gatewayFees + voucherCommission;
  const totalPeriodCosts =
    Number(base.manual_expenses || 0) +
    gatewayFees;
  const operatingProfit =
    totalRevenue -
    bandwidth -
    sellingCosts -
    operatingExpenses;

  const unallocatedExpenseResult = safeSiteId
    ? await pool.query(
        `
          SELECT COALESCE(SUM(amount_tzs), 0)::BIGINT AS amount
          FROM accounting_expenses
          WHERE organization_id = $1
            AND status = 'active'
            AND site_id IS NULL
            AND ($2::date IS NULL OR expense_date >= $2::date)
            AND ($3::date IS NULL OR expense_date <= $3::date)
        `,
        [organizationId, startDate, endDate]
      )
    : { rows: [{ amount: 0 }] };

  return {
    summary: {
      ...base,
      gateway_gross: gatewayGross,
      gateway_fees: gatewayFees,
      gateway_net: Number(base.gateway_net || 0),
      voucher_gross: voucherGross,
      manual_expenses: Number(base.manual_expenses || 0),
      bandwidth_expense: bandwidth,
      voucher_commission: voucherCommission,
      operating_expenses: operatingExpenses,
      capital_investment: Number(base.capital_investment || 0),
      total_revenue: totalRevenue,
      total_period_costs: totalPeriodCosts,
      gross_profit: grossProfit,
      selling_costs: sellingCosts,
      operating_profit: operatingProfit,
      profit_margin:
        totalRevenue > 0
          ? Math.round((operatingProfit / totalRevenue) * 1000) / 10
          : 0,
      unallocated_org_expenses: Number(
        unallocatedExpenseResult.rows[0]?.amount || 0
      )
    },
    expenseCategories: expenseCategoryResult.rows.map((row) => ({
      ...row,
      entries: Number(row.entries || 0),
      amount: Number(row.amount || 0)
    })),
    trend: trendResult.rows.map((row) => ({
      day: row.day,
      gateway: Number(row.gateway || 0),
      voucher: Number(row.voucher || 0),
      expenses: Number(row.expenses || 0)
    })),
    sites: siteResult.rows.map((row) => ({
      ...row,
      gateway: Number(row.gateway || 0),
      voucher: Number(row.voucher || 0),
      expenses: Number(row.expenses || 0),
      revenue:
        Number(row.gateway || 0) +
        Number(row.voucher || 0),
      operating_before_gateway_fees:
        Number(row.gateway || 0) +
        Number(row.voucher || 0) -
        Number(row.expenses || 0)
    }))
  };
};

module.exports = {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  ASSET_TYPES,
  getAccountingOptions,
  createExpense,
  voidExpense,
  listExpenses,
  createAsset,
  disposeAsset,
  listAssets,
  getAccountingReport
};
