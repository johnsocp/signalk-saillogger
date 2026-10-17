/* Plain-node test of the plugin's delta wiring against a stub Signal K app.
 * Run: node index.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { GPS_FALLBACK_MS } = require('./lib/delta');

const USB = 'venus.com.victronenergy.gps.ve_ttyUSB0';
const AIS = 'n2k-on-ve.can-socket.43';
const KNOTS = 1852 / 3600; // m/s per knot

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropysaillog-test-'));
const errors = [];
let onDelta;
const app = {
  debug() {},
  error: m => errors.push(String(m)),
  setPluginStatus() {},
  setPluginError: m => errors.push(`plugin error: ${m}`),
  getDataDirPath: () => dataDir,
  subscriptionmanager: { subscribe: (sub, unsubscribes, onError, cb) => { onDelta = cb; } }
};

// Drive the gate's clock directly instead of waiting out the fallback window.
let clock = 0;
performance.now = () => clock;

const plugin = require('./index.js')(app);
assert.strictEqual(plugin.id, 'signalk-entropy-saillog');
// An unreachable endpoint: flushes fail and the rows stay buffered, where we read them.
plugin.start({ endpoint: 'http://127.0.0.1:9/ingest', secret: 'test', source: USB });

function send(p, value, source) {
  onDelta({ updates: [{ $source: source, timestamp: new Date().toISOString(), values: [{ path: p, value }] }] });
}
function rows() {
  const f = path.join(dataDir, 'entropysaillog_buffer.ndjson');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

// Value-less deltas (sent on provider reconnect) and a null position do not throw.
onDelta({ updates: [{ $source: USB, meta: [{ path: 'navigation.position', value: {} }] }] });
send('navigation.position', null, USB);

// Pinned GPS live: the AIS's speed never reaches the row.
send('navigation.speedOverGround', 9 * KNOTS, AIS);
send('navigation.speedOverGround', 2 * KNOTS, USB);
send('navigation.courseOverGroundTrue', Math.PI / 2, USB);
send('navigation.position', { latitude: 26.70, longitude: -77.20 }, USB);
let r = rows();
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].latitude, 26.70);
assert.strictEqual(r[0].speedOverGround, 2, 'max SOG over the pinned GPS only');
assert.strictEqual(Math.round(r[0].courseOverGroundTrue), 90);

// The USB GPS loses its fix but keeps sending SOG; the AIS takes over after the
// window. The switch clears the USB's cached COG, and neither the USB's SOG nor its
// COG is mixed into the AIS row.
send('navigation.speedOverGround', 3 * KNOTS, USB);
clock += GPS_FALLBACK_MS + 1;
send('navigation.speedOverGround', 7 * KNOTS, USB);
send('navigation.position', { latitude: 26.80, longitude: -77.30 }, AIS);
send('navigation.speedOverGround', 5 * KNOTS, AIS);

// Next minute: the AIS row.
const realNow = Date.now;
Date.now = () => realNow() + 61 * 1000;
send('navigation.position', { latitude: 26.81, longitude: -77.31 }, AIS);
r = rows();
const aisRow = r[r.length - 1];
assert.strictEqual(aisRow.latitude, 26.81);
assert.strictEqual(aisRow.speedOverGround, 5, 'AIS speed only, no USB values carried across the switch');
assert.strictEqual(aisRow.courseOverGroundTrue, null, 'USB COG cleared at the switch');

// The pinned GPS comes back, then loses its fix but keeps publishing null
// positions: nulls are not fixes, so they must not hold off the fallback.
Date.now = () => realNow() + 2 * 61 * 1000;
send('navigation.position', { latitude: 26.82, longitude: -77.32 }, USB);
const before = rows().length;
for (let i = 0; i < 12; i++) {
  clock += 5000;
  send('navigation.position', null, USB);
  send('navigation.position', { latitude: 26.9, longitude: -77.4 }, AIS);
}
Date.now = () => realNow() + 3 * 61 * 1000;
send('navigation.position', { latitude: 26.91, longitude: -77.41 }, AIS);
r = rows();
assert.ok(r.length > before, 'AIS rows written while the pinned GPS sends only nulls');
assert.strictEqual(r[r.length - 1].latitude, 26.91);

plugin.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
assert.deepStrictEqual(errors, []);
console.log('index.test.js: all assertions passed');
process.exit(0);
