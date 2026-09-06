/* Plain-node tests for the course snapshot state machine. Run: node lib/course.test.js */

const assert = require('assert');
const { createCourseTracker, isUsablePosition, GREAT_CIRCLE, RHUMBLINE } = require('./course');
const { courseToNextWaypoint } = require('./payload');

const MAX = 5 * 60 * 1000;
const MIN = 60 * 1000;
const T = 1718500000000;

const GC_POS = `${GREAT_CIRCLE}.nextPoint.position`;
const GC_DIST = `${GREAT_CIRCLE}.nextPoint.distance`;
const GC_TTG = `${GREAT_CIRCLE}.nextPoint.timeToGo`;
const GC_HREF = `${GREAT_CIRCLE}.nextPoint.href`;
const RL_POS = `${RHUMBLINE}.nextPoint.position`;
const RL_DIST = `${RHUMBLINE}.nextPoint.distance`;
const RL_HREF = `${RHUMBLINE}.nextPoint.href`;

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

// Next leg: a position delta starts a FRESH snapshot. The href is carried over
// (the mark's identity is independent of delta ordering — see R5), everything
// describing the OLD leg is not.
t.applyDelta(GC_POS, { latitude: 24.5, longitude: -110.3 }, T + MIN);
chosen = t.choose(T + MIN);
assert.deepStrictEqual(
  Object.keys(chosen).sort(),
  ['changedOn', 'href', 'latitude', 'longitude'],
  'a new leg carries no stale name/distance/timeToGo'
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

// A null coordinate is the plotter saying "no destination" -- a clear, not a crash.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(RL_DIST, 100, T);
t.applyDelta(RL_POS, { latitude: 'x', longitude: null }, T + 1000);
assert.strictEqual(t.pendingClear, true, 'a null coordinate is treated as a clear');


// --- R3: a garbage position is IGNORED, neither a new leg nor a clear --------

// NaN coordinates used to count as a fresh leg: they cancelled the pending
// clear, and the resulting snapshot was then dropped by the payload mapper, so
// the clear was never sent and the cancelled route stayed published.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + 1000);
assert.strictEqual(t.pendingClear, true);
t.applyDelta(GC_POS, { latitude: NaN, longitude: NaN }, T + 2000);
assert.strictEqual(t.pendingClear, true, 'a NaN position must not cancel a pending clear');
assert.strictEqual(t.choose(T + 2000), null, 'the clear is still what gets sent');

// ...but it must not DELETE a live leg either: a single glitched delta is not
// the plotter saying the route is over (only a null/absent coordinate is).
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_DIST, 4000, T);
t.applyDelta(GC_POS, { latitude: NaN, longitude: NaN }, T + 1000);
assert.strictEqual(t.pendingClear, false, 'a NaN position must not clear a live leg');
chosen = t.choose(T + 2000);
assert.strictEqual(chosen.latitude, 26.75, 'the live leg is still chosen');
assert.strictEqual(chosen.distance, 4000, 'the live leg is untouched');
assert.strictEqual(chosen.changedOn, T, 'a garbage position does not refresh the leg');

// Out-of-range coordinates and wrong types are ignored the same way.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(RL_POS, { latitude: 120, longitude: -70.1 }, T + 1000);
t.applyDelta(RL_POS, { latitude: '20.1', longitude: '-70.1' }, T + 2000);
assert.strictEqual(t.pendingClear, false, 'an out-of-range latitude is not a clear');
assert.strictEqual(t.choose(T + 3000).latitude, 20.1, 'the leg survives a glitched delta');

// The position predicate here and lib/payload.js's mapper must agree, or a leg
// this module accepts is silently unsendable (or vice versa).
for (const [value, usable] of [
  [{ latitude: 26.75, longitude: -77.25 }, true],
  [{ latitude: 90, longitude: 180 }, true],
  [{ latitude: -90, longitude: -180 }, true],
  [{ latitude: NaN, longitude: -77.25 }, false],
  [{ latitude: 26.75, longitude: NaN }, false],
  [{ latitude: 91, longitude: 0 }, false],
  [{ latitude: -91, longitude: 0 }, false],
  [{ latitude: 0, longitude: 181 }, false],
  [{ latitude: 0, longitude: -181 }, false],
  [{ latitude: '26.75', longitude: -77.25 }, false],
]) {
  const label = JSON.stringify(value);
  assert.strictEqual(isUsablePosition(value), usable, `isUsablePosition ${label}`);
  const mapped = courseToNextWaypoint({ ...value, changedOn: T }, T);
  assert.strictEqual(mapped !== undefined, usable, `payload mapper agrees on ${label}`);
}

// --- R4: an accepted clear outranks the other course type's fresh leg -------

// Both types track the same mark; only the great circle's null arrives. After
// the clear is accepted, choose() must NOT fall through to the rhumbline and
// republish the deleted route.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + 1000);
t.onBatchAccepted(true);
assert.strictEqual(t.pendingClear, false, 'the clear was accepted');
assert.strictEqual(t.choose(T + 2000), undefined, 'a cleared great circle must not fall back to the rhumbline');

// Once the clear itself is older than maxAge, a still-fresh rhumbline leg is
// eligible again (a new route the plotter only publishes as a rhumbline).
t.applyDelta(RL_DIST, 4000, T + 5 * MIN);
assert.strictEqual(
  t.choose(T + 1000 + MAX + 1).latitude,
  26.75,
  'after maxAge the rhumbline leg is eligible again'
);

// --- R6: after a clear, eligibility is by UPDATE ORDER, not a time window ---

// (a) Symmetric to R4 and not vacuous: the surviving great-circle snapshot is
// FRESH and is reached FIRST in preference order, but it was last updated
// before the rhumbline clear, so it is a leftover of the deleted route.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, null, T + 1000);
t.onBatchAccepted(true);
assert.strictEqual(t.choose(T + 2000), undefined, 'a fresh leftover of a cleared route is not republished');

// (b) A plotter with no great-circle destination emits that null on EVERY poll.
// That must not suppress the live rhumbline leg it is counting down -- for one
// poll or for the whole passage.
t = tracker();
t.applyDelta(RL_POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(GC_POS, { latitude: null, longitude: null }, T);
t.onBatchAccepted(true);
for (const minutes of [1, 5, 20]) {
  t.applyDelta(GC_POS, { latitude: null, longitude: null }, T + minutes * MIN);
  t.applyDelta(RL_DIST, 4000 - minutes * 100, T + minutes * MIN);
  assert.strictEqual(
    t.choose(T + minutes * MIN).latitude,
    20.1,
    `a repeated null must not suppress the live leg at t+${minutes} min`
  );
}

// (c) A new route that the plotter publishes only on the OTHER course type,
// right after a clear was accepted, goes out immediately -- no window to wait.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + MIN);
t.onBatchAccepted(true);
t.applyDelta(RL_POS, { latitude: 24.5, longitude: -110.3 }, T + MIN + 1000);
assert.strictEqual(
  t.choose(T + MIN + 2000).latitude,
  24.5,
  'a new route on the other course type is published at once'
);

// (d) A leftover that never receives another delta stays unpublished, both
// while it is still fresh and after it ages out.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(RL_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_POS, null, T + 1000);
t.onBatchAccepted(true);
assert.strictEqual(t.choose(T + 2 * MIN), undefined, 'a leftover is not published while fresh');
assert.strictEqual(t.choose(T + 10 * MIN), undefined, 'and is not republished once it ages out');

// --- R5: position deltas: re-emission vs. a real leg change -----------------

// The plotter re-emits the SAME position every period. That must refresh the
// leg, not wipe its countdown and name.
t = tracker();
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T);
t.applyDelta(GC_HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
t.applyDelta(GC_DIST, 4000, T);
t.applyDelta(GC_TTG, 1200, T);
t.applyDelta(GC_POS, { latitude: 26.75, longitude: -77.25 }, T + 4 * MIN);
chosen = t.choose(T + 4 * MIN);
assert.strictEqual(chosen.distance, 4000, 're-emitted position keeps distance');
assert.strictEqual(chosen.timeToGo, 1200, 're-emitted position keeps timeToGo');
assert.strictEqual(chosen.name, 'Green Turtle', 're-emitted position keeps the name');
assert.strictEqual(chosen.href, '/resources/waypoints/gt');
assert.strictEqual(chosen.changedOn, T + 4 * MIN, 're-emitted position refreshes freshness');

// href BEFORE position: the new mark's href arrives first, then its position.
// The leg must end up on the NEW href (and so pick up the NEW name), never
// unnamed for its whole duration.
t.applyDelta(GC_HREF, '/resources/waypoints/mp', T + 5 * MIN);
t.applyDelta(GC_POS, { latitude: 24.5, longitude: -110.3 }, T + 5 * MIN);
chosen = t.choose(T + 5 * MIN);
assert.strictEqual(chosen.latitude, 24.5, 'the new mark position is taken');
assert.strictEqual(chosen.href, '/resources/waypoints/mp', 'href survives the leg change');
assert.ok(!('distance' in chosen) && !('timeToGo' in chosen), "the old leg's countdown is dropped");
assert.strictEqual(chosen.name, undefined, "the old mark's name is dropped");
t.applyResolvedName('/resources/waypoints/mp', 'Los Muertos');
assert.strictEqual(t.choose(T + 5 * MIN).name, 'Los Muertos', 'the new name lands on the new leg');

// position BEFORE href: nothing but coordinates, freshness and the carried
// href — the resolved name of the previous mark must not survive.
t.applyDelta(GC_POS, { latitude: 20.1, longitude: -70.1 }, T + 6 * MIN);
chosen = t.choose(T + 6 * MIN);
assert.deepStrictEqual(
  Object.keys(chosen).sort(),
  ['changedOn', 'href', 'latitude', 'longitude'],
  'a leg change keeps only coordinates, freshness and the href'
);
assert.strictEqual(chosen.href, '/resources/waypoints/mp');

// --- R7: a stale countdown does not ride a refreshed position ---------------

// Position keeps re-emitting (which keeps the LEG fresh, see R5) but the
// distance/timeToGo source has stopped. Publishing the last values would slide
// the ETA forever, so they age out on their own clock.
t = tracker();
const fixedMark = { latitude: 26.75, longitude: -77.25 };
t.applyDelta(RL_POS, fixedMark, T);
t.applyDelta(RL_HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
t.applyDelta(RL_DIST, 4000, T);
t.applyDelta(`${RHUMBLINE}.nextPoint.timeToGo`, 1200, T);
for (let m = 1; m <= 20; m += 1) t.applyDelta(RL_POS, fixedMark, T + m * MIN);
chosen = t.choose(T + 20 * MIN);
assert.strictEqual(chosen.latitude, 26.75, 'the leg itself is still published');
assert.strictEqual(chosen.name, 'Green Turtle', 'the mark keeps its name');
assert.ok(!('distance' in chosen), 'a stale distance is not published');
assert.ok(!('timeToGo' in chosen), 'a stale timeToGo is not published');

// A fresh distance delta restores it (and only it).
t.applyDelta(RL_DIST, 1500, T + 20 * MIN);
chosen = t.choose(T + 20 * MIN);
assert.strictEqual(chosen.distance, 1500, 'a fresh distance delta restores the countdown');
assert.ok(!('timeToGo' in chosen), 'timeToGo stays absent until its own delta arrives');

console.log('course.test.js: all assertions passed');
