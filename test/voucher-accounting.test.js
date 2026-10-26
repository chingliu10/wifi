const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env')
});

const testDatabaseUrl = String(
  process.env.TEST_DATABASE_URL || ''
).trim();

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
}

const pool = require('../src/config/database');
const {
  createExpense,
  voidExpense,
  createAsset,
  disposeAsset,
  getAccountingReport
} = require('../src/services/accounting-service');
const { createClientOwner } = require('../src/services/auth-service');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const createTenant = async (label) => {
  const suffix = unique();

  const org = (
    await pool.query(
      `
        INSERT INTO organizations (
          name,
          slug,
          active
        )
        VALUES ($1, $2, TRUE)
        RETURNING *
      `,
      [label + ' ' + suffix, label.toLowerCase() + '-' + suffix]
    )
  ).rows[0];

  const site = (
    await pool.query(
      `
        INSERT INTO sites (
          organization_id,
          name,
          slug,
          brand_name,
          active
        )
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING *
      `,
      [
        org.id,
        label + ' Site',
        label.toLowerCase() + '-site-' + suffix,
        label + ' WiFi'
      ]
    )
  ).rows[0];

  const owner = await createClientOwner({
    organizationId: org.id,
    fullName: label + ' Owner',
    username: label.toLowerCase() + '-' + suffix,
    password: 'Accounting123!'
  });

  return { org, site, owner };
};

test(
  'accounting records are isolated by tenant at service and database levels',
  {
    skip: testDatabaseUrl
      ? false
      : 'TEST_DATABASE_URL is not configured; production DATABASE_URL is never used for accounting integration tests'
  },
  async () => {
    const tenantA = await createTenant('TenantA');
    const tenantB = await createTenant('TenantB');

    const expense = await createExpense({
      organizationId: tenantA.org.id,
      siteId: tenantA.site.id,
      category: 'bandwidth',
      description: 'Monthly internet bundle',
      amountTzs: 1000,
      expenseDate: '2026-10-26',
      vendor: 'ISP',
      paymentMethod: 'mobile_money',
      reference: 'TEST-EXP-A',
      cashierUserId: null,
      notes: null,
      createdByUserId: tenantA.owner.id
    });

    assert.equal(Number(expense.organization_id), Number(tenantA.org.id));
    assert.equal(Number(expense.site_id), Number(tenantA.site.id));

    await assert.rejects(
      () =>
        createExpense({
          organizationId: tenantA.org.id,
          siteId: tenantB.site.id,
          category: 'electricity',
          description: 'Cross tenant attempt',
          amountTzs: 500,
          expenseDate: '2026-10-26',
          vendor: null,
          paymentMethod: 'cash',
          reference: null,
          cashierUserId: null,
          notes: null,
          createdByUserId: tenantA.owner.id
        }),
      /does not belong to organization/
    );

    await assert.rejects(
      () =>
        createExpense({
          organizationId: tenantA.org.id,
          siteId: tenantA.site.id,
          category: 'electricity',
          description: 'Wrong actor attempt',
          amountTzs: 500,
          expenseDate: '2026-10-26',
          vendor: null,
          paymentMethod: 'cash',
          reference: null,
          cashierUserId: null,
          notes: null,
          createdByUserId: tenantB.owner.id
        }),
      /creator .* outside organization/
    );

    const asset = await createAsset({
      organizationId: tenantA.org.id,
      siteId: tenantA.site.id,
      assetType: 'access_point',
      name: 'Test AP',
      purchasePriceTzs: 5000,
      purchaseDate: '2026-10-26',
      vendor: 'Network Shop',
      reference: 'TEST-ASSET-A',
      usefulLifeMonths: 36,
      notes: null,
      createdByUserId: tenantA.owner.id
    });

    assert.equal(Number(asset.organization_id), Number(tenantA.org.id));

    await assert.rejects(
      () =>
        createAsset({
          organizationId: tenantA.org.id,
          siteId: tenantB.site.id,
          assetType: 'router',
          name: 'Cross tenant router',
          purchasePriceTzs: 3000,
          purchaseDate: '2026-10-26',
          vendor: null,
          reference: null,
          usefulLifeMonths: null,
          notes: null,
          createdByUserId: tenantA.owner.id
        }),
      /does not belong to organization/
    );

    const reportA = await getAccountingReport({
      organizationId: tenantA.org.id,
      startDate: '2026-10-01',
      endDate: '2026-10-31'
    });
    const reportB = await getAccountingReport({
      organizationId: tenantB.org.id,
      startDate: '2026-10-01',
      endDate: '2026-10-31'
    });

    assert.equal(Number(reportA.summary.manual_expenses), 1000);
    assert.equal(Number(reportA.summary.bandwidth_expense), 1000);
    assert.equal(Number(reportA.summary.capital_investment), 5000);
    assert.equal(Number(reportB.summary.manual_expenses), 0);
    assert.equal(Number(reportB.summary.capital_investment), 0);

    const wrongTenantVoid = await voidExpense({
      organizationId: tenantB.org.id,
      expenseId: expense.id,
      voidedByUserId: tenantB.owner.id,
      reason: 'Should not find another tenant record'
    });

    assert.equal(wrongTenantVoid, null);

    const voided = await voidExpense({
      organizationId: tenantA.org.id,
      expenseId: expense.id,
      voidedByUserId: tenantA.owner.id,
      reason: 'Test correction'
    });

    assert.equal(voided.status, 'voided');

    await assert.rejects(
      () =>
        pool.query(
          'DELETE FROM accounting_expenses WHERE id = $1',
          [expense.id]
        ),
      /Hard delete blocked/
    );

    const wrongTenantDispose = await disposeAsset({
      organizationId: tenantB.org.id,
      assetId: asset.id,
      disposedByUserId: tenantB.owner.id,
      note: 'Should not find another tenant asset'
    });

    assert.equal(wrongTenantDispose, null);

    const disposed = await disposeAsset({
      organizationId: tenantA.org.id,
      assetId: asset.id,
      disposedByUserId: tenantA.owner.id,
      note: 'Test disposal'
    });

    assert.equal(disposed.status, 'disposed');

    const correctedReportA = await getAccountingReport({
      organizationId: tenantA.org.id,
      startDate: '2026-10-01',
      endDate: '2026-10-31'
    });

    assert.equal(Number(correctedReportA.summary.manual_expenses), 0);
    assert.equal(Number(correctedReportA.summary.capital_investment), 5000);
  }
);

test.after(async () => {
  await pool.end();
});
