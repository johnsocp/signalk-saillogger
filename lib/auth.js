/*
 * Request signing for the entropysaillog ingest, mirrored byte-for-byte from the
 * server (src/entropy_ingest/auth.py): HMAC-SHA256 over "<timestamp>.<body>"
 * with the shared secret, hex-encoded. The plugin sends x-timestamp + x-signature
 * and the ingest rejects stale timestamps + bad signatures.
 */

const crypto = require('crypto');

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

module.exports = { sign };
