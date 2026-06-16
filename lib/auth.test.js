/* Plain-node test for the signer. Run: node lib/auth.test.js */

const assert = require('assert');
const { sign } = require('./auth');

// Known-answer vector — identical to the server's tests/test_auth.py. If either
// side changes the scheme, one of the two tests fails.
assert.strictEqual(
  sign('test-secret', '1700000000', '{"batch_id":"x"}'),
  'a68d544b19b8316408f9d1d1831e2a2aae10b9fd0661b349f234a43eec491595'
);

// Deterministic + sensitive to every input.
const a = sign('s', '100', 'body');
assert.strictEqual(sign('s', '100', 'body'), a);
assert.notStrictEqual(sign('s', '100', 'body2'), a);
assert.notStrictEqual(sign('s', '101', 'body'), a);
assert.notStrictEqual(sign('s2', '100', 'body'), a);

console.log('auth.test.js: all assertions passed');
