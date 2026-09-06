/* Plain-node tests for the course snapshot state machine. Run: node lib/course.test.js */

const assert = require('assert');
const { createCourseTracker, GREAT_CIRCLE, RHUMBLINE } = require('./course');

const MAX = 5 * 60 * 1000;
const MIN = 60 * 1000;
const T = 1718500000000;

const GC_POS = `${GREAT_CIRCLE}.nextPoint.position`;
const GC_DIST = `${GREAT_CIRCLE}.nextPoint.distance`;
const GC_TTG = `${GREAT_CIRCLE}.nextPoint.timeToGo`;
const GC_HREF = `${GREAT_CIRCLE}.nextPoint.href`;
const RL_POS = `${RHUMBLINE}.nextPoint.position`;
const RL_DIST = `${RHUMBLINE}.nextPoint.distance`;

function tracker() {
  return createCourseTracker({ maxAgeMs: MAX });
}

// --- choose(): great circle preferred, rhumbline is the fallback -------------

// Both fresh -> great circle wins.
let t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
let chosen = t.choose(T + 1000);
assert.strictEqual(chosen.latitude, 26.75, 'great circle preferred when both are fresh');

// Great circle absent -> rhumbline used.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
assert.strictEqual(t.choose(T + 1000).latitude, 20.1, 'rhumbline used when great circle is absent');

// Great circle stale (> maxAge) -> rhumbline used.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T + 4 * MIN);
assert.strictEqual(t.choose(T + 6 * MIN).latitude, 20.1, 'stale great circle falls back to rhumbline');

// Stale great circle + cleared rhumbline -> undefined, NOT the stale object.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(RL_POS, null, T + 1000);
t.onBatchAccepted(true); // the clear reached the server
assert.strictEqual(t.choose(T + 6 * MIN), undefined, 'stale great circle must not be sent');

// Nothing ever seen -> undefined (say nothing about the route).
assert.strictEqual(tracker().choose(T), undefined, 'no snapshots -> undefined');

// --- F3: any nextPoint delta refreshes freshness ----------------------------

// A fixed mark emits position once, then only distance/timeToGo updates. The
// snapshot must stay fresh off those, not go stale 5 min into the leg.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_DIST, 4000, T + 4 * MIN);
chosen = t.choose(T + 8 * MIN);
assert.ok(chosen && typeof chosen === 'object', 'a distance delta must refresh the snapshot');
assert.strictEqual(chosen.changedOn, T + 4 * MIN);
assert.strictEqual(chosen.distance, 4000);

// timeToGo and href refresh it too.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_TTG, 900, T + 3 * MIN);
t.applyDelta(GC_HREF, '/resources/waypoints/abc', T + 4 * MIN);
assert.strictEqual(t.choose(T + 8 * MIN).changedOn, T + 4 * MIN, 'timeToGo/href refresh changedOn');

// Fields only land on an active snapshot (a cleared one is not resurrected).
t = tracker();
t.applyDelta(GC_DIST, 4000, T);
assert.strictEqual(t.choose(T), undefined, 'a distance delta alone creates nothing');

// --- F4: a new leg does not inherit the previous leg's fields ---------------

t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_HREF, '/resources/waypoints/isla', T);
t.applyResolvedName('/resources/waypoints/isla', 'Isla Partida');
t.applyDelta(GC_DIST, 5000, T);
chosen = t.choose(T);
assert.strictEqual(chosen.name, 'Isla Partida');
assert.strictEqual(chosen.distance, 5000);

// Next leg: a position delta starts a FRESH snapshot.
t.applyDelta(GC_POS, { latitude: 24.5, longitude: -110.3 }, T + MIN);
chosen = t.choose(T + MIN);
assert.deepStrictEqual(
  Object.keys(chosen).sort(),
  ['changedOn', 'latitude', 'longitude'],
  'a new leg carries no stale name/href/distance/timeToGo'
);
assert.strictEqual(chosen.latitude, 24.5);

// The cached name is re-applied when an href delta names the same waypoint.
t.applyDelta(GC_HREF, '/resources/waypoints/isla', T + MIN);
assert.strictEqual(t.choose(T + MIN).name, 'Isla Partida', 'cached name re-applied on a matching href');

// A different href gets no name until it resolves.
t.applyDelta(GC_POS, { latitude: 23.0, longitude: -109.0 }, T + 2 * MIN);
t.applyDelta(GC_HREF, '/resources/waypoints/other', T + 2 * MIN);
assert.ok(!('name' in t.choose(T + 2 * MIN)), 'an unresolved href carries no name');

// applyResolvedName only names the snapshot whose href matches.
t.applyResolvedName('/resources/waypoints/isla', 'Isla Partida');
assert.ok(!('name' in t.choose(T + 2 * MIN)), 'a name for another href must not be applied');
t.applyResolvedName('/resources/waypoints/other', 'Los Frailes');
assert.strictEqual(t.choose(T + 2 * MIN).name, 'Los Frailes');

// --- F5: the route-clear null is never lost ---------------------------------

// (a) A null position with NO prior snapshot (plugin restarted mid-route, then
// the route was cancelled) still arms the clear.
t = tracker();
t.applyDelta(GC_POS, null, T);
assert.strictEqual(t.pendingClear, true, 'a null with no prior snapshot must arm the clear');
assert.strictEqual(t.choose(T), null);

// A repeated null does not re-arm a clear that was already accepted.
t.onBatchAccepted(true);
assert.strictEqual(t.pendingClear, false);
t.applyDelta(GC_POS, null, T + MIN);
assert.strictEqual(t.pendingClear, false, 'a redundant null must not re-arm the clear');
assert.strictEqual(t.choose(T + MIN), undefined);

// (b) A pending clear outranks any non-cleared fallback snapshot.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(GC_POS, null, T + 1000);
assert.strictEqual(t.pendingClear, true);
assert.strictEqual(t.choose(T + 2000), null, 'a pending clear outranks the rhumbline fallback');

// (c) The clear survives a failed push and is cleared on a 2xx that carried it.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + 1000);
assert.strictEqual(t.choose(T + 2000), null);
t.onBatchAccepted(false); // an accepted batch that did NOT carry the null
assert.strictEqual(t.pendingClear, true, 'only a batch that carried the null clears the flag');
assert.strictEqual(t.choose(T + 3000), null, 'the clear is resent after a failed push');
t.onBatchAccepted(true);
assert.strictEqual(t.pendingClear, false);
assert.strictEqual(t.choose(T + 4000), undefined, 'once accepted, say nothing');

// A new route supersedes a still-pending clear.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + 1000);
assert.strictEqual(t.pendingClear, true);
t.applyDelta(GC_POS, { latitude: 24.5, longitude: -110.3 }, T + 2000);
assert.strictEqual(t.pendingClear, false, 'a new route supersedes the pending clear');
assert.strictEqual(t.choose(T + 2000).latitude, 24.5);

// ...but a new leg on the great circle does NOT cancel a clear that is still
// pending for the rhumbline while the great circle was already active.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, null, T + 1000);
t.applyDelta(GC_POS, { latitude: 26.8, longitude: -77.3 }, T + 2000);
assert.strictEqual(t.pendingClear, true, 'an unrelated active leg does not cancel the clear');

// --- misc -------------------------------------------------------------------

// Unknown / malformed paths are ignored rather than throwing.
t = tracker();
t.applyDelta('navigation.speedOverGround', 3, T);
assert.strictEqual(t.choose(T), undefined);
t.applyResolvedName('/resources/waypoints/x', null);
t.applyResolvedName(undefined, 'nope');

// A malformed position value is a clear, not a crash.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(RL_DIST, 100, T);
t.applyDelta(RL_POS, { latitude: 'x', longitude: null }, T + 1000);
assert.strictEqual(t.pendingClear, true, 'an unusable position is treated as a clear');

console.log('course.test.js: all assertions passed');
