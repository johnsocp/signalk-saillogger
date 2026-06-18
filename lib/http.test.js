/* Plain-node test for the native http POST. Run: node lib/http.test.js */

const assert = require('assert');
const http = require('http');
const { postJson } = require('./http');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${server.address().port}/ingest`;
      try {
        await fn(url);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function main() {
  // 1. 200: sends POST with our headers + exact body; resolves {statusCode, body}.
  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.headers['content-type'], 'application/json');
        assert.strictEqual(req.headers['x-signature'], 'sig123');
        assert.strictEqual(req.headers['content-length'], String(Buffer.byteLength(body)));
        assert.strictEqual(body, '{"batch_id":"b","mu":"é"}'); // body sent unmutated (multibyte)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    },
    async (url) => {
      const out = await postJson(
        url,
        { 'Content-Type': 'application/json', 'x-signature': 'sig123' },
        '{"batch_id":"b","mu":"é"}',
        5000
      );
      assert.strictEqual(out.statusCode, 200);
      assert.strictEqual(out.body, '{"ok":true}');
    }
  );

  // 2. 400: a non-2xx response RESOLVES (not rejects) so the caller can drop it.
  await withServer(
    (req, res) => {
      res.writeHead(400);
      res.end('{"error":"payload failed contract"}');
    },
    async (url) => {
      const out = await postJson(url, {}, '{}', 5000);
      assert.strictEqual(out.statusCode, 400);
      assert.match(out.body, /payload failed contract/);
    }
  );

  // 3. Transport failure (connection refused) REJECTS -> caller retries.
  let refused = false;
  try {
    // Port 1 is reserved/unused; connect is refused immediately.
    await postJson('http://127.0.0.1:1/ingest', {}, '{}', 2000);
  } catch (err) {
    refused = true;
  }
  assert.ok(refused, 'connection refused should reject');

  // 4. Timeout REJECTS -> caller retries.
  let timedOut = false;
  await withServer(
    (req, res) => {
      /* never responds */
    },
    async (url) => {
      try {
        await postJson(url, {}, '{}', 100);
      } catch (err) {
        timedOut = true;
      }
      assert.ok(timedOut, 'timeout should reject');
    }
  );

  // 5. Bad URL rejects rather than throwing synchronously.
  let badUrl = false;
  try {
    await postJson('not a url', {}, '{}', 1000);
  } catch (err) {
    badUrl = true;
  }
  assert.ok(badUrl, 'invalid endpoint should reject');

  console.log('http.test.js: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
