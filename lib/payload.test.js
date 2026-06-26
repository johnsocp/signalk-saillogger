/* Plain-node tests for the payload builder. Run: node lib/payload.test.js */

const assert = require('assert');
const { rowToPoint, buildBatch, batchId, SCHEMA_VERSION } = require('./payload');

const BATCH_ID_RE = /^[A-Za-z0-9_.-]{8,128}$/; // must match the ingest contract
const ALLOWED = new Set(['timestamp', 'lat', 'lon', 'sog', 'cog', 'tws', 'twd']);

function row(ts, lat, lon, extra = {}) {
  return { ts, latitude: lat, longitude: lon, ...extra };
}

// rowToPoint maps a fix and emits only contract-allowed fields.
let p = rowToPoint(row(1718500000000, 26.7, -77.2, { speedOverGround: 6.5, courseOverGroundTrue: 118.4 }));
assert.deepStrictEqual(Object.keys(p).sort(), ['cog', 'lat', 'lon', 'sog', 'timestamp']);
assert.strictEqual(p.timestamp, new Date(1718500000000).toISOString());
assert.ok(p.timestamp.endsWith('Z'));
assert.strictEqual(p.sog, 6.5);
assert.strictEqual(p.cog, 118.4);

// Optional fields are OMITTED (not null) when absent/invalid.
p = rowToPoint(row(1718500000000, 26.7, -77.2, { speedOverGround: null, courseOverGroundTrue: null }));
assert.ok(!('sog' in p) && !('cog' in p), 'null sog/cog must be omitted');

// Bad fixes -> null.
assert.strictEqual(rowToPoint(row(1718500000000, 200, -77)), null, 'lat out of range');
assert.strictEqual(rowToPoint(row(1718500000000, 26, -200)), null, 'lon out of range');
assert.strictEqual(rowToPoint(row('nope', 26, -77)), null, 'bad ts');
assert.strictEqual(rowToPoint(row(1718500000000, undefined, -77)), null, 'missing lat');

// cog out of range -> field dropped, point kept.
p = rowToPoint(row(1718500000000, 26.7, -77.2, { courseOverGroundTrue: 540 }));
assert.ok(p && !('cog' in p), 'out-of-range cog dropped');

// True wind: tws/twd mapped when present and in range.
p = rowToPoint(row(1718500000000, 26.7, -77.2, { windSpeedTrue: 14.2, windDirectionTrue: 230.4 }));
assert.strictEqual(p.tws, 14.2);
assert.strictEqual(p.twd, 230.4);

// Wind omitted (not null) when absent/invalid.
p = rowToPoint(row(1718500000000, 26.7, -77.2, { windSpeedTrue: null, windDirectionTrue: null }));
assert.ok(!('tws' in p) && !('twd' in p), 'null tws/twd must be omitted');

// twd out of range -> field dropped, point kept; negative tws dropped.
p = rowToPoint(row(1718500000000, 26.7, -77.2, { windSpeedTrue: -3, windDirectionTrue: 400 }));
assert.ok(p && !('tws' in p) && !('twd' in p), 'out-of-range tws/twd dropped');

// buildBatch: contract shape + allowlisted keys only.
const rows = [
  row(1718500000000, 26.70, -77.20, { speedOverGround: 6.6, courseOverGroundTrue: 119 }),
  row(1718500060000, 26.71, -77.21, { speedOverGround: 6.5, courseOverGroundTrue: 118 }),
];
const batch = buildBatch(rows);
assert.strictEqual(batch.schema_version, SCHEMA_VERSION);
assert.ok(BATCH_ID_RE.test(batch.batch_id), `batch_id "${batch.batch_id}" must match contract`);
assert.strictEqual(batch.points.length, 2);
for (const pt of batch.points) {
  for (const k of Object.keys(pt)) assert.ok(ALLOWED.has(k), `leaked field: ${k}`);
}

// Durable + deterministic: identical rows -> identical id (survives restart).
assert.strictEqual(batch.batch_id, '1718500000000-1718500060000-2');
assert.strictEqual(batchId(rows), batchId(rows.map((r) => ({ ...r }))));

// Bad points dropped but batch kept; id spans ALL rows (so a resend of the same
// peeked set is idempotent even when middle rows were unusable).
const mixed = [row(1718500000000, 26.7, -77.2), row(1718500030000, 999, 0), row(1718500060000, 26.8, -77.3)];
const b2 = buildBatch(mixed);
assert.strictEqual(b2.points.length, 2);
assert.strictEqual(b2.batch_id, '1718500000000-1718500060000-3');

// Nothing usable -> null (caller purges the poison rows).
assert.strictEqual(buildBatch([row(1718500000000, 999, 0)]), null);
assert.strictEqual(buildBatch([]), null);

console.log('payload.test.js: all assertions passed');
