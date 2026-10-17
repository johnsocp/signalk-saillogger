/* Plain-node tests for the delta helpers. Run: node lib/delta.test.js */

const assert = require('assert');
const { deltaValue, createGpsGate, GPS_FALLBACK_MS } = require('./delta');

const USB = 'venus.com.victronenergy.gps.ve_ttyUSB0';
const AIS = 'n2k-on-ve.can-socket.43';
const PLOTTER = 'n2k-on-ve.can-socket.2';
const POS = 'navigation.position';
const SOG = 'navigation.speedOverGround';
const COG = 'navigation.courseOverGroundTrue';

function delta(path, value, source) {
  return { updates: [{ $source: source, values: [{ path, value }] }] };
}

// A normal delta yields its one value and the update's $source.
assert.deepStrictEqual(
  deltaValue(delta(SOG, 2.5, USB)),
  { path: SOG, value: 2.5, source: USB }
);

// Deltas without values (Signal K sends meta-only updates on (re)connect) -> null,
// not a TypeError.
assert.strictEqual(deltaValue({ updates: [{ $source: USB, meta: [{ path: 'x', value: {} }] }] }), null);
assert.strictEqual(deltaValue({ updates: [{ $source: USB, values: [] }] }), null);
assert.strictEqual(deltaValue({ updates: [] }), null);
assert.strictEqual(deltaValue({}), null);
assert.strictEqual(deltaValue(undefined), null);

// No GPS source configured: everything is accepted.
let gate = createGpsGate(undefined);
assert.strictEqual(gate.accepts(POS, AIS, 0), true);
gate = createGpsGate('');
assert.strictEqual(gate.accepts(SOG, AIS, 0), true);

// Configured source, live: position, SOG and COG from any other source are skipped,
// so a row never mixes one device's fix with another's speed or course.
gate = createGpsGate(USB);
let t = 1000;
assert.strictEqual(gate.accepts(POS, USB, t), true);
assert.strictEqual(gate.source, USB);
for (const path of [POS, SOG, COG]) {
  assert.strictEqual(gate.accepts(path, AIS, t + 1000), false, `${path} from another source while pinned GPS is live`);
  assert.strictEqual(gate.accepts(path, USB, t + 1000), true, `${path} from the pinned source`);
}

// Non-GPS paths are never filtered by the GPS source.
assert.strictEqual(gate.accepts('environment.wind.speedTrue', 'derived-data', t), true);

// Pinned GPS silent for longer than the fallback window: the first other source to
// send a position is locked onto.
t = 1000 + 1000; // last pinned position
assert.strictEqual(gate.accepts(POS, AIS, t + GPS_FALLBACK_MS), false, 'not yet past the window');
const fb = t + GPS_FALLBACK_MS + 1;
assert.strictEqual(gate.accepts(POS, AIS, fb), true, 'past the window: fall back');
assert.strictEqual(gate.source, AIS);
assert.strictEqual(gate.accepts(SOG, AIS, fb + 1), true);
assert.strictEqual(gate.accepts(COG, AIS, fb + 1), true);

// While locked onto the fallback, nothing else is mixed in: not a third device,
// and not the pinned GPS's SOG/COG (it can keep sending those after losing its fix).
assert.strictEqual(gate.accepts(POS, PLOTTER, fb + 2), false, 'third device position');
assert.strictEqual(gate.accepts(SOG, PLOTTER, fb + 2), false, 'third device SOG');
assert.strictEqual(gate.accepts(SOG, USB, fb + 2), false, 'pinned SOG without a pinned fix');
assert.strictEqual(gate.accepts(COG, USB, fb + 2), false, 'pinned COG without a pinned fix');

// The fallback itself goes silent: the next source with a position takes over.
assert.strictEqual(gate.accepts(POS, PLOTTER, fb + GPS_FALLBACK_MS + 1), true);
assert.strictEqual(gate.source, PLOTTER);
assert.strictEqual(gate.accepts(SOG, AIS, fb + GPS_FALLBACK_MS + 2), false, 'old fallback no longer accepted');

// The pinned GPS comes back: it wins again immediately.
const back = fb + GPS_FALLBACK_MS + 5000;
assert.strictEqual(gate.accepts(POS, USB, back), true);
assert.strictEqual(gate.source, USB);
assert.strictEqual(gate.accepts(POS, PLOTTER, back + 1), false, 'pinned source back: others skipped again');
assert.strictEqual(gate.accepts(SOG, PLOTTER, back + 1), false);

// Only a POSITION keeps a source alive: the USB GPS drops COG when stationary, and
// its SOG/COG alone must not hold off a fallback for a GPS with no fix.
gate = createGpsGate(USB);
assert.strictEqual(gate.accepts(SOG, USB, 0), true);
assert.strictEqual(gate.accepts(POS, AIS, GPS_FALLBACK_MS + 1), true, 'no pinned fix ever seen: fall back');

// Never seen the pinned source at all (e.g. at start, or it is unplugged): fall back
// only once the window has passed since the gate was created, so a start-up race
// does not log the wrong device.
gate = createGpsGate(USB, 5000);
assert.strictEqual(gate.source, USB);
assert.strictEqual(gate.accepts(POS, AIS, 5000 + 10), false, 'within the window after start');
assert.strictEqual(gate.accepts(POS, AIS, 5000 + GPS_FALLBACK_MS + 1), true, 'pinned never appeared: fall back');

console.log('delta.test.js: all assertions passed');
