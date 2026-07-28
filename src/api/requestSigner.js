const crypto = require('crypto');

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const usedNonces = new Map();

function cleanupNonces(now = Date.now()) {
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(nonce);
  }
}

function canonicalize({ method, path, timestamp, nonce, body }) {
  return [method.toUpperCase(), path, String(timestamp), nonce, JSON.stringify(body ?? {})].join('\n');
}

function verifySignedRequest({ clientId, publicKey, signature, method, path, timestamp, nonce, body }) {
  if (!clientId || !publicKey || !signature || !timestamp || !nonce) return false;
  const now = Date.now();
  const requestTime = Number(timestamp);
  if (!Number.isSafeInteger(requestTime) || Math.abs(now - requestTime) > MAX_CLOCK_SKEW_MS) return false;
  cleanupNonces(now);
  if (usedNonces.has(`${clientId}:${nonce}`)) return false;

  try {
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalize({ method, path, timestamp, nonce, body })),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    if (valid) usedNonces.set(`${clientId}:${nonce}`, now + NONCE_TTL_MS);
    return valid;
  } catch {
    return false;
  }
}

module.exports = { canonicalize, verifySignedRequest };
