const crypto = require('crypto');
const pool = require('../../config/database');
const { normalizeMacAddress } = require('../../utils/mac-address');
const { encryptSecret, decryptSecret } = require('../secret-crypto');
const omada = require('./open-api-client');

const toOmadaMac = (value) => {
  const normalized = normalizeMacAddress(value);
  return normalized ? normalized.replace(/:/g, '-') : null;
};

const generateDevicePassword = () => {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!#$%&*@^';
  const all = upper + lower + digits + symbols;

  while (true) {
    const chars = [
      upper[crypto.randomInt(upper.length)],
      lower[crypto.randomInt(lower.length)],
      digits[crypto.randomInt(digits.length)],
      symbols[crypto.randomInt(symbols.length)]
    ];

    while (chars.length < 20) {
      chars.push(all[crypto.randomInt(all.length)]);
    }

    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    const password = chars.join('');

    if (!/(.)\1/.test(password)) {
      return password;
    }
  }
};

const generateDeviceUsername = (siteId) =>
  `solidus-${Number(siteId).toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

const makeOmadaSiteName = (organizationName, siteName) => {
  const name = `${organizationName} - ${siteName}`
    .replace(/[+=@]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return name.slice(0, 64);
};

const chooseScenario = async () => {
  const requested = String(
    process.env.OMADA_DEFAULT_SCENARIO || 'Hotel'
  ).trim();

  const scenarios = await omada.listScenarios();

  if (!scenarios.length) {
    return requested;
  }

  const names = scenarios
    .map((item) => ({
      name: typeof item === 'string' ? item : item.name,
      isDefault: Boolean(item?.isDefault)
    }))
    .filter((item) => item.name);

  return (
    names.find(
      (item) => item.name.toLowerCase() === requested.toLowerCase()
    )?.name ||
    names.find((item) => item.isDefault)?.name ||
    names[0]?.name ||
    requested
  );
};

const loadSite = async (siteId) => {
  const result = await pool.query(
    `
      SELECT
        s.*,
        o.name AS organization_name,
        o.active AS organization_active
      FROM sites s
      JOIN organizations o ON o.id = s.organization_id
      WHERE s.id = $1
        AND s.active = TRUE
        AND o.active = TRUE
      LIMIT 1
    `,
    [siteId]
  );

  return result.rows[0] || null;
};

const provisionSite = async (siteId) => {
  const site = await loadSite(siteId);

  if (!site) {
    throw new Error('Solidus site was not found');
  }

  if (!omada.configured()) {
    throw new Error('Omada Open API is not enabled');
  }

  if (site.external_portal_site_id) {
    return site;
  }

  let username = site.omada_device_username;
  let password = site.omada_device_password_enc
    ? decryptSecret(site.omada_device_password_enc)
    : null;

  if (!username) {
    username = generateDeviceUsername(site.id);
  }

  if (!password) {
    password = generateDevicePassword();
  }

  const omadaName = makeOmadaSiteName(site.organization_name, site.name);
  const existingSites = await omada.listSites();

  let remote = existingSites.find((item) => item.name === omadaName);

  if (!remote) {
    const scenario = await chooseScenario();

    const created = await omada.createSite({
      name: omadaName,
      region: String(process.env.OMADA_DEFAULT_REGION || 'Tanzania').trim(),
      timeZone: String(
        process.env.OMADA_DEFAULT_TIMEZONE || 'Africa/Dar_es_Salaam'
      ).trim(),
      scenario,
      username,
      password
    });

    const createdId =
      (typeof created === 'string' ? created : null) ||
      created?.siteId ||
      created?.id ||
      created?.siteID ||
      null;

    if (createdId) {
      remote = {
        siteId: createdId,
        name: omadaName
      };
    } else {
      const refreshed = await omada.listSites();
      remote = refreshed.find((item) => item.name === omadaName);
    }
  }

  const remoteSiteId = remote?.siteId || remote?.id;

  if (!remoteSiteId) {
    throw new Error('Omada site was created but no site ID was returned');
  }

  const result = await pool.query(
    `
      UPDATE sites
      SET
        external_portal_site_id = $2,
        omada_device_username = $3,
        omada_device_password_enc = $4,
        omada_provisioned_at = NOW(),
        omada_sync_error = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [site.id, remoteSiteId, username, encryptSecret(password)]
  );

  return result.rows[0];
};

const recordProvisionError = async (siteId, error) => {
  await pool.query(
    `
      UPDATE sites
      SET
        omada_sync_error = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [siteId, String(error?.message || error || 'Unknown Omada error').slice(0, 1000)]
  );
};

const getDeviceCredentials = async (siteId) => {
  const site = await loadSite(siteId);

  if (
    !site ||
    !site.omada_device_username ||
    !site.omada_device_password_enc
  ) {
    return null;
  }

  return {
    username: site.omada_device_username,
    password: decryptSecret(site.omada_device_password_enc)
  };
};

const getInformHost = () =>
  String(process.env.OMADA_INFORM_HOST || '204.168.129.223').trim();

const createDeviceClaim = async ({
  siteId,
  apMac,
  localUsername,
  localPassword
}) => {
  const normalized = normalizeMacAddress(apMac);
  const overrideUsername = String(localUsername || '').trim();
  const overridePassword = String(localPassword || '');

  if (!normalized) {
    throw new Error('Enter a valid AP MAC address');
  }

  if (
    (overrideUsername && !overridePassword) ||
    (!overrideUsername && overridePassword)
  ) {
    throw new Error(
      'Enter both the existing EAP username and password, or leave both empty'
    );
  }

  const site = await loadSite(siteId);

  if (!site?.external_portal_site_id) {
    throw new Error('Provision the Omada site before claiming an AP');
  }

  const result = await pool.query(
    `
      INSERT INTO omada_device_claims (
        site_id,
        ap_mac,
        local_username,
        local_password_enc,
        status,
        expires_at,
        last_error,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'pending', NOW() + INTERVAL '24 hours', NULL, NOW())
      ON CONFLICT (site_id, ap_mac)
      DO UPDATE SET
        local_username = EXCLUDED.local_username,
        local_password_enc = EXCLUDED.local_password_enc,
        status = 'pending',
        expires_at = NOW() + INTERVAL '24 hours',
        last_error = NULL,
        updated_at = NOW()
      RETURNING *
    `,
    [
      site.id,
      normalized,
      overrideUsername || null,
      overridePassword ? encryptSecret(overridePassword) : null
    ]
  );

  return result.rows[0];
};

const getActiveClaims = async () => {
  const result = await pool.query(
    `
      SELECT
        c.*,
        s.external_portal_site_id,
        s.omada_device_username,
        s.omada_device_password_enc,
        s.omada_auto_adopt,
        s.organization_id,
        s.name AS site_name
      FROM omada_device_claims c
      JOIN sites s ON s.id = c.site_id
      JOIN organizations o ON o.id = s.organization_id
      WHERE c.status IN ('pending', 'discovered', 'adopting')
        AND c.expires_at > NOW()
        AND (
          c.last_checked_at IS NULL
          OR c.last_checked_at < NOW() - INTERVAL '10 seconds'
        )
        AND s.active = TRUE
        AND o.active = TRUE
        AND s.external_portal_site_id IS NOT NULL
        AND s.omada_auto_adopt = TRUE
      ORDER BY c.created_at
      LIMIT 50
    `
  );

  return result.rows;
};

const upsertDetectedDevice = async ({ claim, remoteDevice }) => {
  const normalized = normalizeMacAddress(claim.ap_mac);

  await pool.query(
    `
      INSERT INTO network_devices (
        site_id,
        name,
        nas_identifier,
        brand,
        model,
        management_ip,
        ap_mac,
        device_type,
        last_seen_at,
        active
      )
      VALUES (
        $1,
        $2,
        $3,
        'TP-Link Omada',
        $4,
        NULLIF($5, '')::inet,
        $6,
        'omada',
        NOW(),
        TRUE
      )
      ON CONFLICT (ap_mac) WHERE ap_mac IS NOT NULL
      DO UPDATE SET
        site_id = EXCLUDED.site_id,
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        model = EXCLUDED.model,
        management_ip = EXCLUDED.management_ip,
        device_type = EXCLUDED.device_type,
        last_seen_at = NOW(),
        active = TRUE,
        updated_at = NOW()
    `,
    [
      claim.site_id,
      remoteDevice?.name || `Omada AP ${normalized.slice(-8).replace(/:/g, '')}`,
      `omada-${normalized.replace(/:/g, '').toLowerCase()}`,
      remoteDevice?.model || null,
      remoteDevice?.ip || '',
      normalized
    ]
  );
};

const markExpiredClaims = async () => {
  await pool.query(
    `
      UPDATE omada_device_claims
      SET
        status = 'expired',
        updated_at = NOW()
      WHERE status IN ('pending', 'discovered', 'adopting', 'failed')
        AND expires_at <= NOW()
    `
  );
};

const processClaim = async (claim) => {
  const siteId = claim.external_portal_site_id;
  const omadaMac = toOmadaMac(claim.ap_mac);

  if (!siteId || !omadaMac) {
    return;
  }

  const managed = await omada.listDevices({ siteId });
  const connected = managed.find(
    (item) => normalizeMacAddress(item.mac) === normalizeMacAddress(claim.ap_mac)
  );

  if (connected && Number(connected.status) === 1) {
    await upsertDetectedDevice({ claim, remoteDevice: connected });

    await pool.query(
      `
        UPDATE omada_device_claims
        SET
          status = 'connected',
          adopted_at = COALESCE(adopted_at, NOW()),
          local_password_enc = NULL,
          last_error = NULL,
          last_checked_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [claim.id]
    );

    return;
  }

  if (claim.status === 'adopting') {
    const adoptResult = await omada.getDeviceAdoptResult({
      siteId,
      deviceMac: omadaMac
    });

    const envelopeCode = Number(adoptResult?.errorCode || 0);
    const adoptCode = adoptResult?.result?.adoptErrorCode;

    if (envelopeCode !== 0) {
      throw new Error(
        adoptResult?.msg || `Unable to read adoption result (${envelopeCode})`
      );
    }

    if (adoptCode !== undefined && Number(adoptCode) !== 0) {
      const descriptions = {
        '-39002': 'The AP did not respond to the adoption command.',
        '-39003': 'The local EAP username or password is incorrect.',
        '-39004': 'Omada could not adopt this device.',
        '-39005': 'The AP is not connected to the controller.',
        '-39329': 'The AP could not link to its uplink AP.'
      };

      const message =
        descriptions[String(adoptCode)] ||
        `Omada adoption failed with code ${adoptCode}`;

      await pool.query(
        `
          UPDATE omada_device_claims
          SET
            status = 'failed',
            last_error = $2,
            last_checked_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [claim.id, message]
      );

      return;
    }

    await pool.query(
      `
        UPDATE omada_device_claims
        SET
          last_checked_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $1
      `,
      [claim.id]
    );

    return;
  }

  const pending = await omada.listPendingDevices({
    siteId,
    searchKey: omadaMac
  });

  const found = pending.find(
    (item) => normalizeMacAddress(item.mac) === normalizeMacAddress(claim.ap_mac)
  );

  if (!found) {
    await pool.query(
      `
        UPDATE omada_device_claims
        SET
          status = 'pending',
          last_checked_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [claim.id]
    );

    return;
  }

  await pool.query(
    `
      UPDATE omada_device_claims
      SET
        status = 'discovered',
        last_checked_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [claim.id]
  );

  const siteCredentials = {
    username: claim.omada_device_username,
    password: claim.omada_device_password_enc
      ? decryptSecret(claim.omada_device_password_enc)
      : null
  };

  const username = claim.local_username || siteCredentials.username;
  const password = claim.local_password_enc
    ? decryptSecret(claim.local_password_enc)
    : siteCredentials.password;

  if (!username || !password) {
    throw new Error('No EAP local credentials are available for adoption');
  }

  const response = await omada.startAdoptDevice({
    siteId,
    deviceMac: omadaMac,
    username,
    password
  });

  if (Number(response?.errorCode || 0) !== 0) {
    const error = new Error(
      response?.msg || `Omada adoption failed with code ${response?.errorCode}`
    );
    error.omadaErrorCode = Number(response?.errorCode);
    throw error;
  }

  await pool.query(
    `
      UPDATE omada_device_claims
      SET
        status = 'adopting',
        last_error = NULL,
        last_checked_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [claim.id]
  );
};

const syncClaimsOnce = async () => {
  if (!omada.configured()) {
    return;
  }

  await markExpiredClaims();

  const claims = await getActiveClaims();

  for (const claim of claims) {
    try {
      await processClaim(claim);
    } catch (error) {
      await pool.query(
        `
          UPDATE omada_device_claims
          SET
            status = 'failed',
            last_error = $2,
            last_checked_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [claim.id, String(error.message || error).slice(0, 1000)]
      );

      console.error('OMADA CLAIM ERROR:', {
        claimId: claim.id,
        siteId: claim.site_id,
        error: error.message
      });
    }
  }
};

module.exports = {
  provisionSite,
  recordProvisionError,
  getDeviceCredentials,
  getInformHost,
  createDeviceClaim,
  syncClaimsOnce
};
