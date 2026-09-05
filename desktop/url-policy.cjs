function isOwnPage(url, address) {
  try {
    return new URL(url).origin === new URL(address).origin;
  } catch {
    return false;
  }
}

function isExternalWeb(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

module.exports = { isOwnPage, isExternalWeb };
