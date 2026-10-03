const normalizeMacAddress = (mac) => {
  if (!mac || typeof mac !== 'string') {
    return null;
  }

  const cleaned = mac
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();

  if (cleaned.length !== 12) {
    return null;
  }

  return cleaned.match(/.{2}/g).join(':');
};

module.exports = {
  normalizeMacAddress
};