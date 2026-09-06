/* Plain-node tests for the payload builder. Run: node lib/payload.test.js */

const assert = require('assert');
const { rowToPoint, buildBatch, batchId, courseToNextWaypoint, SCHEMA_VERSION } = require('./payload');

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

// --- next_waypoint (active-route snapshot) ---------------------------------

const WP_ALLOWED = new Set(['name', 'lat', 'lon', 'distance_m', 'time_to_go_s', 'observed_at']);
const NOW = 1718500120000;
function course(extra = {}) {
  return { latitude: 26.75, longitude: -77.25, changedOn: NOW - 30000, ...extra };
}

// Fresh snapshot -> next_waypoint present, exactly the expected keys, mapped units.
let b = buildBatch(rows, course({ name: 'Green Turtle', distance: 12345.6, timeToGo: 4200 }), NOW);
assert.deepStrictEqual(
  Object.keys(b.next_waypoint).sort(),
  ['distance_m', 'lat', 'lon', 'name', 'observed_at', 'time_to_go_s']
);
assert.strictEqual(b.next_waypoint.lat, 26.75);
assert.strictEqual(b.next_waypoint.lon, -77.25);
assert.strictEqual(b.next_waypoint.name, 'Green Turtle');
assert.strictEqual(b.next_waypoint.distance_m, 12345.6);
assert.strictEqual(b.next_waypoint.time_to_go_s, 4200);
assert.strictEqual(b.next_waypoint.observed_at, new Date(NOW - 30000).toISOString());
assert.ok(b.next_waypoint.observed_at.endsWith('Z'));

// Stale snapshot (6 min old) -> the key is absent entirely.
b = buildBatch(rows, course({ changedOn: NOW - 6 * 60 * 1000 }), NOW);
assert.ok(!('next_waypoint' in b), 'stale course snapshot must be omitted');
// ...and just inside the 5 min window it is kept.
b = buildBatch(rows, course({ changedOn: NOW - 4 * 60 * 1000 }), NOW);
assert.ok('next_waypoint' in b, 'course snapshot inside the window must be sent');

// Explicit null -> route cleared, emit next_waypoint: null.
b = buildBatch(rows, null, NOW);
assert.ok('next_waypoint' in b, 'cleared route must emit the key');
assert.strictEqual(b.next_waypoint, null);

// No course argument -> key absent (and not present-as-undefined).
b = buildBatch(rows);
assert.ok(!('next_waypoint' in b), 'no course -> no key');
assert.ok(!Object.keys(b).includes('next_waypoint'));
assert.deepStrictEqual(Object.keys(b).sort(), ['batch_id', 'points', 'schema_version']);

// Bad / missing coordinates -> key absent.
assert.ok(!('next_waypoint' in buildBatch(rows, course({ latitude: 91 }), NOW)), 'lat out of range');
assert.ok(!('next_waypoint' in buildBatch(rows, course({ longitude: -181 }), NOW)), 'lon out of range');
assert.ok(!('next_waypoint' in buildBatch(rows, course({ latitude: undefined }), NOW)), 'missing lat');

// courseToNextWaypoint is pure and leaks no extra keys.
assert.strictEqual(courseToNextWaypoint(undefined, NOW), undefined);
assert.strictEqual(courseToNextWaypoint(null, NOW), undefined);
let wp = courseToNextWaypoint(course({ href: '/resources/waypoints/abc', cleared: false, junk: 1 }), NOW);
for (const k of Object.keys(wp)) assert.ok(WP_ALLOWED.has(k), `leaked field: ${k}`);
assert.deepStrictEqual(Object.keys(wp).sort(), ['lat', 'lon', 'observed_at']);

// Name: truncated to 80 chars; absent when empty or not a string.
wp = courseToNextWaypoint(course({ name: 'W'.repeat(120) }), NOW);
assert.strictEqual(wp.name.length, 80);
assert.strictEqual(wp.name, 'W'.repeat(80));
assert.ok(!('name' in courseToNextWaypoint(course({ name: '' }), NOW)), 'empty name omitted');
assert.ok(!('name' in courseToNextWaypoint(course({ name: 42 }), NOW)), 'non-string name omitted');

// distance/timeToGo only when finite and >= 0.
wp = courseToNextWaypoint(course({ distance: -5, timeToGo: Infinity }), NOW);
assert.ok(!('distance_m' in wp) && !('time_to_go_s' in wp), 'invalid distance/timeToGo omitted');
wp = courseToNextWaypoint(course({ distance: 0, timeToGo: 0 }), NOW);
assert.strictEqual(wp.distance_m, 0);
assert.strictEqual(wp.time_to_go_s, 0);

console.log('payload.test.js: all assertions passed');
