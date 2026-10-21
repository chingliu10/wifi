const crypto = require('crypto');
const pool = require('../config/database');

const SESSION_COOKIE = 'solidus_session';
const SESSION_DAYS = 7;

const normalizeUsername = (value) =>
  String(value || '').trim().toLowerCase();

const hashPassword = (password) => {
  const plain = String(password || '');

  if (plain.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }

  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, 64);

  return [
    'scrypt',
    salt.toString('hex'),
    derived.toString('hex')
  ].join('$');
};

const verifyPassword = (password, storedHash) => {
  try {
    const [scheme, saltHex, hashHex] = String(storedHash || '').split('$');

    if (scheme !== 'scrypt' || !saltHex || !hashHex) {
      return false;
    }

    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(
      String(password || ''),
      Buffer.from(saltHex, 'hex'),
      expected.length
    );

    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch (error) {
    return false;
  }
};

const parseCookies = (header) => {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');

      if (separator === -1) {
        return cookies;
      }

      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      cookies[key] = decodeURIComponent(value);

      return cookies;
    }, {});
};

const hashSessionToken = (token) =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex');

const createSession = async (userId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);

  await pool.query(
    `
      DELETE FROM platform_sessions
      WHERE expires_at <= NOW()
    `
  );

  await pool.query(
    `
      INSERT INTO platform_sessions (
        user_id,
        token_hash,
        expires_at
      )
      VALUES (
        $1,
        $2,
        NOW() + ($3 * INTERVAL '1 day')
      )
    `,
    [userId, tokenHash, SESSION_DAYS]
  );

  return token;
};

const destroySession = async (token) => {
  if (!token) {
    return;
  }

  await pool.query(
    `
      DELETE FROM platform_sessions
      WHERE token_hash = $1
    `,
    [hashSessionToken(token)]
  );
};

const authenticateUser = async ({ username, password }) => {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername || !password) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        id,
        organization_id,
        role,
        full_name,
        username,
        password_hash,
        active
      FROM platform_users
      WHERE username = $1
      LIMIT 1
    `,
    [normalizedUsername]
  );

  const user = result.rows[0];

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return null;
  }

  await pool.query(
    `
      UPDATE platform_users
      SET
        last_login_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [user.id]
  );

  return user;
};

const getUserFromRequest = async (req) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        u.id,
        u.organization_id,
        u.site_id,
        u.role,
        u.full_name,
        u.username,
        u.active,
        o.name AS organization_name,
        st.name AS site_name
      FROM platform_sessions s
      JOIN platform_users u ON u.id = s.user_id
      LEFT JOIN organizations o ON o.id = u.organization_id
      LEFT JOIN sites st ON st.id = u.site_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND u.active = TRUE
      LIMIT 1
    `,
    [hashSessionToken(token)]
  );

  const user = result.rows[0] || null;

  if (user) {
    await pool.query(
      `
        UPDATE platform_sessions
        SET last_seen_at = NOW()
        WHERE token_hash = $1
      `,
      [hashSessionToken(token)]
    );
  }

  return user;
};

const setSessionCookie = (req, res, token) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = req.secure || forwardedProto === 'https';
  const maxAge = SESSION_DAYS * 24 * 60 * 60;

  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      secure ? 'Secure' : null
    ].filter(Boolean).join('; ')
  );
};

const clearSessionCookie = (req, res) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = req.secure || forwardedProto === 'https';

  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      secure ? 'Secure' : null
    ].filter(Boolean).join('; ')
  );
};

const changePassword = async ({
  userId,
  currentPassword,
  newPassword
}) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        SELECT id, password_hash
        FROM platform_users
        WHERE id = $1
          AND active = TRUE
        LIMIT 1
        FOR UPDATE
      `,
      [userId]
    );

    const user = result.rows[0];

    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      const error = new Error('Current password is incorrect');
      error.code = 'INVALID_CURRENT_PASSWORD';
      throw error;
    }

    if (verifyPassword(newPassword, user.password_hash)) {
      const error = new Error('New password must be different from the current password');
      error.code = 'PASSWORD_UNCHANGED';
      throw error;
    }

    const passwordHash = hashPassword(newPassword);

    await client.query(
      `
        UPDATE platform_users
        SET
          password_hash = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
      [userId, passwordHash]
    );

    // Revoke every existing session for this user. The route creates a fresh
    // session immediately after the password change succeeds.
    await client.query(
      `
        DELETE FROM platform_sessions
        WHERE user_id = $1
      `,
      [userId]
    );

    await client.query('COMMIT');

    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const createCashier = async ({
  db,
  organizationId,
  siteId,
  fullName,
  username,
  password
}) => {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error('Cashier username is required');
  }

  const passwordHash = hashPassword(password);

  const result = await (db || pool).query(
    `
      INSERT INTO platform_users (
        organization_id,
        site_id,
        role,
        full_name,
        username,
        password_hash
      )
      VALUES ($1, $2, 'cashier', $3, $4, $5)
      RETURNING
        id,
        organization_id,
        site_id,
        role,
        full_name,
        username,
        active,
        created_at
    `,
    [
      organizationId,
      siteId,
      String(fullName || '').trim() || normalizedUsername,
      normalizedUsername,
      passwordHash
    ]
  );

  return result.rows[0];
};

const createClientOwner = async ({
  db,
  organizationId,
  fullName,
  username,
  password
}) => {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error('Client owner username is required');
  }

  const passwordHash = hashPassword(password);

  const result = await (db || pool).query(
    `
      INSERT INTO platform_users (
        organization_id,
        role,
        full_name,
        username,
        password_hash
      )
      VALUES ($1, 'client_owner', $2, $3, $4)
      RETURNING
        id,
        organization_id,
        role,
        full_name,
        username,
        active,
        created_at
    `,
    [
      organizationId,
      String(fullName || '').trim() || normalizedUsername,
      normalizedUsername,
      passwordHash
    ]
  );

  return result.rows[0];
};

module.exports = {
  SESSION_COOKIE,
  normalizeUsername,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  authenticateUser,
  getUserFromRequest,
  setSessionCookie,
  clearSessionCookie,
  changePassword,
  createClientOwner,
  createCashier
};
