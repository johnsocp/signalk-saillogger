/*
 * Minimal JSON POST over Node's built-in http/https — replaces the deprecated
 * `request` dependency so the plugin has ZERO runtime deps (lean on a
 * memory-constrained Cerbo).
 *
 * Semantics match the old request() call the caller relied on:
 *   - resolves { statusCode, body } for ANY HTTP response (a non-2xx status is
 *     NOT an error here — the caller branches on statusCode: 200 flushes, 400
 *     drops, anything else retries);
 *   - rejects only on a transport failure (DNS/connect error or timeout), which
 *     the caller treats as "retry next interval".
 *
 * The caller signs the exact `body` bytes, so this module must not mutate them.
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJson(endpoint, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = url.protocol === 'http:' ? http : https;
    const payload = Buffer.from(body, 'utf8');
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      // Content-Length from the byte length (body may contain multibyte chars).
      headers: Object.assign({ 'Content-Length': payload.length }, headers),
      timeout: timeoutMs,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson };
