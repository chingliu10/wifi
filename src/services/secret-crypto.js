const crypto = require('crypto');

const getKey = () => {
  const raw = String(process.env.PLATFORM_ENCRYPTION_KEY || '').trim();

  if (!raw) {
    throw new Error('PLATFORM_ENCRYPTION_KEY is not configured');
  }

  let key;

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch (error) {
      key = null;
    }
  }

  if (!key || key.length !== 32) {
    throw new Error(
      'PLATFORM_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)'
    );
  }

  return key;
};

const encryptSecret = (value) => {
  const plaintext = String(value || '');

  if (!plaintext) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url')
  ].join('.');
};

const decryptSecret = (payload) => {
  if (!payload) {
    return null;
  }

  const [version, ivPart, tagPart, encryptedPart] = String(payload).split('.');

  if (version !== 'v1' || !ivPart || !tagPart || !encryptedPart) {
    throw new Error('Encrypted secret has an unsupported format');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(ivPart, 'base64url')
  );

  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
};

module.exports = {
  encryptSecret,
  decryptSecret
};
