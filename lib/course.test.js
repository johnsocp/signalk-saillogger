/* Plain-node tests for the course snapshot state machine. Run: node lib/course.test.js */

const assert = require('assert');
const { createCourseTracker, isUsablePosition, GREAT_CIRCLE, RHUMBLINE } = require('./course');
const { courseToNextWaypoint } = require('./payload');

const MAX = 5 * 60 * 1000;
const MIN = 60 * 1000;
const T = 1718500000000;

const POS = `${GREAT_CIRCLE}.nextPoint.position`;
const DIST = `${GREAT_CIRCLE}.nextPoint.distance`;
const TTG = `${GREAT_CIRCLE}.nextPoint.timeToGo`;
const HREF = `${GREAT_CIRCLE}.nextPoint.href`;
const RL_POS = `${RHUMBLINE}.nextPoint.position`;
const RL_DIST = `${RHUMBLINE}.nextPoint.distance`;
const RL_TTG = `${RHUMBLINE}.nextPoint.timeToGo`;
const RL_HREF = `${RHUMBLINE}.nextPoint.href`;

const MARK = { latitude: 26.75, longitude: -77.25 };
const OTHER_MARK = { latitude: 24.5, longitude: -110.3 };

function tracker() {
  return createCourseTracker({ maxAgeMs: MAX });
}

// --- the configured prefix is the ONLY one read --------------------------

// Default prefix is the great circle.
let t = tracker();
t.applyDelta(POS, MARK, T);
assert.strictEqual(t.choose(T).latitude, 26.75, 'the default prefix is the great circle');

// A rhumbline delta does not create a snapshot on a great-circle tracker.
t = tracker();
t.applyDelta(RL_POS, OTHER_MARK, T);
t.applyDelta(RL_DIST, 4000, T);
t.applyDelta(RL_TTG, 1200, T);
t.applyDelta(RL_HREF, '/resources/waypoints/x', T);
assert.strictEqual(t.choose(T), undefined, 'the other prefix creates nothing');
assert.strictEqual(t.pendingClear, false, 'the other prefix arms no clear');

// ...nor clears a live leg, nor refreshes one, nor overwrites its fields.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(DIST, 4000, T);
t.applyDelta(RL_POS, null, T + MIN);
assert.strictEqual(t.pendingClear, false, "the other prefix's null is not a clear");
t.applyDelta(RL_POS, OTHER_MARK, T + 2 * MIN);
t.applyDelta(RL_DIST, 9999, T + 2 * MIN);
let chosen = t.choose(T + 2 * MIN);
assert.strictEqual(chosen.latitude, 26.75, 'the live leg is untouched by the other prefix');
assert.strictEqual(chosen.distance, 4000, "the other prefix's fields do not land");
assert.strictEqual(chosen.changedOn, T, 'the other prefix does not refresh freshness');

// The rhumbline prefix works symmetrically when it is the one configured.
t = createCourseTracker({ maxAgeMs: MAX, prefix: RHUMBLINE });
t.applyDelta(POS, OTHER_MARK, T);
assert.strictEqual(t.choose(T), undefined, 'a great-circle delta is ignored on a rhumbline tracker');
t.applyDelta(RL_POS, MARK, T);
t.applyDelta(RL_DIST, 4000, T);
t.applyDelta(RL_HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
chosen = t.choose(T + 1000);
assert.strictEqual(chosen.latitude, 26.75, 'the configured rhumbline leg is published');
assert.strictEqual(chosen.distance, 4000);
assert.strictEqual(chosen.name, 'Green Turtle');
t.applyDelta(RL_POS, null, T + 2000);
assert.strictEqual(t.choose(T + 2000), null, 'the configured rhumbline clear is published');

// Nothing ever seen -> undefined (say nothing about the route).
assert.strictEqual(tracker().choose(T), undefined, 'no snapshot -> undefined');

// A snapshot older than maxAge is not sent.
t = tracker();
t.applyDelta(POS, MARK, T);
assert.strictEqual(t.choose(T + 6 * MIN), undefined, 'a stale snapshot is not sent');

// --- F3: any nextPoint delta refreshes freshness ----------------------------

// A fixed mark emits position once, then only distance/timeToGo updates. The
// snapshot must stay fresh off those, not go stale 5 min into the leg.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(DIST, 4000, T + 4 * MIN);
chosen = t.choose(T + 8 * MIN);
assert.ok(chosen && typeof chosen === 'object', 'a distance delta must refresh the snapshot');
assert.strictEqual(chosen.changedOn, T + 4 * MIN);
assert.strictEqual(chosen.distance, 4000);

// timeToGo and href refresh it too.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(TTG, 900, T + 3 * MIN);
t.applyDelta(HREF, '/resources/waypoints/abc', T + 4 * MIN);
assert.strictEqual(t.choose(T + 8 * MIN).changedOn, T + 4 * MIN, 'timeToGo/href refresh changedOn');

// Fields only land on an active snapshot (a cleared one is not resurrected).
t = tracker();
t.applyDelta(DIST, 4000, T);
assert.strictEqual(t.choose(T), undefined, 'a distance delta alone creates nothing');

// --- F4: a new leg does not inherit the previous leg's fields ---------------

t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(HREF, '/resources/waypoints/isla', T);
t.applyResolvedName('/resources/waypoints/isla', 'Isla Partida');
t.applyDelta(DIST, 5000, T);
chosen = t.choose(T);
assert.strictEqual(chosen.name, 'Isla Partida');
assert.strictEqual(chosen.distance, 5000);

// Next leg: a position delta starts a FRESH snapshot. The href is carried over
// (the mark's identity is independent of delta ordering — see R5), everything
// describing the OLD leg is not.
t.applyDelta(POS, OTHER_MARK, T + MIN);
chosen = t.choose(T + MIN);
assert.deepStrictEqual(
  Object.keys(chosen).sort(),
  ['changedOn', 'href', 'latitude', 'longitude'],
  'a new leg carries no stale name/distance/timeToGo'
);
assert.strictEqual(chosen.latitude, 24.5);

// The cached name is re-applied when an href delta names the same waypoint.
t.applyDelta(HREF, '/resources/waypoints/isla', T + MIN);
assert.strictEqual(t.choose(T + MIN).name, 'Isla Partida', 'cached name re-applied on a matching href');

// A different href gets no name until it resolves.
t.applyDelta(POS, { latitude: 23.0, longitude: -109.0 }, T + 2 * MIN);
t.applyDelta(HREF, '/resources/waypoints/other', T + 2 * MIN);
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
t.applyDelta(POS, null, T);
assert.strictEqual(t.pendingClear, true, 'a null with no prior snapshot must arm the clear');
assert.strictEqual(t.choose(T), null);

// A repeated null does not re-arm a clear that was already accepted.
t.onBatchAccepted(t.pendingClearSeq);
assert.strictEqual(t.pendingClear, false);
t.applyDelta(POS, null, T + MIN);
assert.strictEqual(t.pendingClear, false, 'a redundant null must not re-arm the clear');
assert.strictEqual(t.choose(T + MIN), undefined);
t.applyDelta(POS, { latitude: null, longitude: null }, T + 2 * MIN);
assert.strictEqual(t.pendingClear, false, 'a null-coordinate repeat is idempotent too');
assert.strictEqual(t.choose(T + 2 * MIN), undefined);

// (b) The clear survives a failed push and is cleared on a 2xx that carried it.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(POS, null, T + 1000);
assert.strictEqual(t.choose(T + 2000), null);
t.onBatchAccepted(0); // an accepted batch that did NOT carry the null
assert.strictEqual(t.pendingClear, true, 'only a batch that carried the null clears the flag');
assert.strictEqual(t.choose(T + 3000), null, 'the clear is resent after a failed push');
t.onBatchAccepted(t.pendingClearSeq);
assert.strictEqual(t.pendingClear, false);
assert.strictEqual(t.choose(T + 4000), undefined, 'once accepted, say nothing');

// (c) A new route supersedes a still-pending clear.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(POS, null, T + 1000);
assert.strictEqual(t.pendingClear, true);
t.applyDelta(POS, OTHER_MARK, T + 2000);
assert.strictEqual(t.pendingClear, false, 'a new route supersedes the pending clear');
assert.strictEqual(t.choose(T + 2000).latitude, 24.5);

// --- the core case: a cleared route stays cleared until it is re-activated --

// Route A, then a null that the server accepts. With only one prefix read, a
// re-emission of A cannot arrive from anywhere else: A's own path is the one
// that went null. So the wire stays silent — however long the subscription
// keeps polling — until a NEW non-null position lands, and when A itself is
// re-sent non-null that IS a re-activation and is published at once.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(DIST, 5000, T);
t.applyDelta(HREF, '/resources/waypoints/gt', T);
t.applyDelta(POS, null, T + 1000);
t.onBatchAccepted(t.pendingClearSeq);
assert.strictEqual(t.pendingClear, false, 'the clear was accepted');
for (let ms = 5000; ms <= 10 * MIN; ms += 5000) {
  // Exactly what the `ideal` policy sends for a path with no value: the null,
  // over and over, plus the cancellation's trailing field leaves.
  t.applyDelta(POS, null, T + ms);
  t.applyDelta(DIST, null, T + ms);
  t.applyDelta(TTG, null, T + ms);
  assert.strictEqual(t.choose(T + ms), undefined, `the cleared route stays silent at +${ms} ms`);
  assert.strictEqual(t.pendingClear, false, `and the clear is not re-armed at +${ms} ms`);
}
// The same mark, re-activated: a value after a null is never a leftover.
t.applyDelta(POS, MARK, T + 11 * MIN);
chosen = t.choose(T + 11 * MIN);
assert.strictEqual(chosen.latitude, 26.75, 'the same mark re-activates after a clear');
assert.ok(!('distance' in chosen), "the cleared leg's countdown does not come back");
assert.ok(!('name' in chosen), "the cleared leg's name does not come back");

// A DIFFERENT mark after an accepted clear is published at once — no window to
// wait out.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(POS, null, T + MIN);
t.onBatchAccepted(t.pendingClearSeq);
t.applyDelta(POS, OTHER_MARK, T + MIN + 1000);
assert.strictEqual(
  t.choose(T + MIN + 2000).latitude,
  24.5,
  'a new route after the clear is published at once'
);

// --- misc -------------------------------------------------------------------

// Unknown / malformed paths are ignored rather than throwing.
t = tracker();
t.applyDelta('navigation.speedOverGround', 3, T);
t.applyDelta(undefined, 3, T);
t.applyDelta(`${GREAT_CIRCLE}.nextPoint.bearingTrue`, 3, T);
assert.strictEqual(t.choose(T), undefined);
t.applyResolvedName('/resources/waypoints/x', null);
t.applyResolvedName(undefined, 'nope');

// Both coordinates null is the plotter saying "no destination" -- a clear, not a
// crash. A HALF-null object is a glitch (see the D section below) and is ignored.
t = tracker();
t.applyDelta(POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(DIST, 100, T);
t.applyDelta(POS, { latitude: null, longitude: null }, T + 1000);
assert.strictEqual(t.pendingClear, true, 'a null coordinate pair is treated as a clear');
t = tracker();
t.applyDelta(POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(POS, { latitude: 'x', longitude: null }, T + 1000);
assert.strictEqual(t.pendingClear, false, 'a half-null coordinate pair is a glitch, not a clear');

// --- R3: a garbage position is IGNORED, neither a new leg nor a clear --------

// NaN coordinates used to count as a fresh leg: they cancelled the pending
// clear, and the resulting snapshot was then dropped by the payload mapper, so
// the clear was never sent and the cancelled route stayed published.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(POS, null, T + 1000);
assert.strictEqual(t.pendingClear, true);
t.applyDelta(POS, { latitude: NaN, longitude: NaN }, T + 2000);
assert.strictEqual(t.pendingClear, true, 'a NaN position must not cancel a pending clear');
assert.strictEqual(t.choose(T + 2000), null, 'the clear is still what gets sent');

// ...but it must not DELETE a live leg either: a single glitched delta is not
// the plotter saying the route is over (only a null/absent coordinate is).
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(DIST, 4000, T);
t.applyDelta(POS, { latitude: NaN, longitude: NaN }, T + 1000);
assert.strictEqual(t.pendingClear, false, 'a NaN position must not clear a live leg');
chosen = t.choose(T + 2000);
assert.strictEqual(chosen.latitude, 26.75, 'the live leg is still chosen');
assert.strictEqual(chosen.distance, 4000, 'the live leg is untouched');
assert.strictEqual(chosen.changedOn, T, 'a garbage position does not refresh the leg');

// Out-of-range coordinates and wrong types are ignored the same way.
t = tracker();
t.applyDelta(POS, { latitude: 20.1, longitude: -70.1 }, T);
t.applyDelta(POS, { latitude: 120, longitude: -70.1 }, T + 1000);
t.applyDelta(POS, { latitude: '20.1', longitude: '-70.1' }, T + 2000);
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

// --- R5: position deltas: re-emission vs. a real leg change -----------------

// The plotter re-emits the SAME position every period. That must refresh the
// leg, not wipe its countdown and name.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
t.applyDelta(DIST, 4000, T);
t.applyDelta(TTG, 1200, T);
t.applyDelta(POS, { latitude: 26.75, longitude: -77.25 }, T + 4 * MIN);
chosen = t.choose(T + 4 * MIN);
assert.strictEqual(chosen.distance, 4000, 're-emitted position keeps distance');
assert.strictEqual(chosen.timeToGo, 1200, 're-emitted position keeps timeToGo');
assert.strictEqual(chosen.name, 'Green Turtle', 're-emitted position keeps the name');
assert.strictEqual(chosen.href, '/resources/waypoints/gt');
assert.strictEqual(chosen.changedOn, T + 4 * MIN, 're-emitted position refreshes freshness');

// href BEFORE position: the new mark's href arrives first, then its position.
// The leg must end up on the NEW href (and so pick up the NEW name), never
// unnamed for its whole duration.
t.applyDelta(HREF, '/resources/waypoints/mp', T + 5 * MIN);
t.applyDelta(POS, OTHER_MARK, T + 5 * MIN);
chosen = t.choose(T + 5 * MIN);
assert.strictEqual(chosen.latitude, 24.5, 'the new mark position is taken');
assert.strictEqual(chosen.href, '/resources/waypoints/mp', 'href survives the leg change');
assert.ok(!('distance' in chosen) && !('timeToGo' in chosen), "the old leg's countdown is dropped");
assert.strictEqual(chosen.name, undefined, "the old mark's name is dropped");
t.applyResolvedName('/resources/waypoints/mp', 'Los Muertos');
assert.strictEqual(t.choose(T + 5 * MIN).name, 'Los Muertos', 'the new name lands on the new leg');

// position BEFORE href: nothing but coordinates, freshness and the carried
// href — the resolved name of the previous mark must not survive.
t.applyDelta(POS, { latitude: 20.1, longitude: -70.1 }, T + 6 * MIN);
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
t.applyDelta(POS, MARK, T);
t.applyDelta(HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
t.applyDelta(DIST, 4000, T);
t.applyDelta(TTG, 1200, T);
for (let m = 1; m <= 20; m += 1) t.applyDelta(POS, MARK, T + m * MIN);
chosen = t.choose(T + 20 * MIN);
assert.strictEqual(chosen.latitude, 26.75, 'the leg itself is still published');
assert.strictEqual(chosen.name, 'Green Turtle', 'the mark keeps its name');
assert.ok(!('distance' in chosen), 'a stale distance is not published');
assert.ok(!('timeToGo' in chosen), 'a stale timeToGo is not published');

// A fresh distance delta restores it (and only it).
t.applyDelta(DIST, 1500, T + 20 * MIN);
chosen = t.choose(T + 20 * MIN);
assert.strictEqual(chosen.distance, 1500, 'a fresh distance delta restores the countdown');
assert.ok(!('timeToGo' in chosen), 'timeToGo stays absent until its own delta arrives');

// --- A: a pending clear survives a plugin/server restart --------------------

// The clear used to live only in a closure: a restart between the null delta
// and the accepted push forgot the delete forever.
let saved = [];
const persistOf = (loaded) => ({ load: () => loaded, save: (o) => saved.push({ ...o }) });

t = createCourseTracker({ maxAgeMs: MAX, persist: persistOf({ pendingClearSeq: 7 }) });
assert.strictEqual(t.pendingClear, true, 'a persisted pending clear is restored at construction');
assert.strictEqual(t.pendingClearSeq, 7, 'and keeps its sequence');
assert.strictEqual(t.choose(T), null, 'the restored clear is still what gets sent');
t.onBatchAccepted(7);
assert.strictEqual(t.pendingClear, false);
assert.deepStrictEqual(saved, [{ pendingClearSeq: 0 }], 'the ack is persisted');

// Nothing persisted -> a normal cold start, and arming/acking are both saved.
saved = [];
t = createCourseTracker({ maxAgeMs: MAX, persist: persistOf(undefined) });
assert.strictEqual(t.pendingClear, false, 'an empty store starts clean');
t.applyDelta(POS, MARK, T);
assert.deepStrictEqual(saved, [], 'a leg with no pending state to change saves nothing');
t.applyDelta(POS, null, T + 1000);
assert.deepStrictEqual(saved, [{ pendingClearSeq: 1 }], 'arming a clear is persisted');
t.applyDelta(POS, null, T + 2000);
assert.deepStrictEqual(saved, [{ pendingClearSeq: 1 }], 'a redundant null changes nothing to persist');
t.onBatchAccepted(1);
assert.deepStrictEqual(saved, [{ pendingClearSeq: 1 }, { pendingClearSeq: 0 }], 'the ack is persisted');

// A garbage store is ignored rather than fatal.
for (const junk of [null, {}, { pendingClearSeq: 'x' }, { pendingClearSeq: -1 }, { pendingClearSeq: 1.5 }]) {
  const j = createCourseTracker({ maxAgeMs: MAX, persist: { load: () => junk, save: () => {} } });
  assert.strictEqual(j.pendingClear, false, `a junk store (${JSON.stringify(junk)}) starts clean`);
}

// --- B: an ack names the clear it carried -----------------------------------

// A delayed 200 for an OLDER batch used to disarm a NEWER clear, deleting
// nothing and leaving a cancelled route published.
t = tracker();
assert.strictEqual(t.pendingClearSeq, 0, 'no clear pending -> sequence 0');
t.applyDelta(POS, MARK, T);
t.applyDelta(POS, null, T + 1000);
const seq1 = t.pendingClearSeq;
assert.strictEqual(seq1, 1, 'the first clear is sequence 1');
t.applyDelta(POS, OTHER_MARK, T + 2000);
assert.strictEqual(t.pendingClearSeq, 0, 'a re-activation drops the pending sequence');
t.applyDelta(POS, null, T + 3000);
assert.strictEqual(t.pendingClearSeq, 2, 'each arm gets a new sequence');
t.onBatchAccepted(seq1);
assert.strictEqual(t.pendingClear, true, 'a delayed ack for an older clear does not disarm the new one');
assert.strictEqual(t.choose(T + 3000), null);
t.onBatchAccepted(0);
assert.strictEqual(t.pendingClear, true, 'a batch that carried no null (0) never disarms');
t.onBatchAccepted(2);
assert.strictEqual(t.pendingClear, false, 'the ack for the pending sequence disarms it');
assert.strictEqual(t.choose(T + 4000), undefined);

// --- C: exactly one $source drives the course paths -------------------------

const SRC = 'GPS1.II';
const FOREIGN = 'plotter.2';

// No option: the first source with a USABLE position locks it.
t = tracker();
t.applyDelta(POS, MARK, T, SRC);
assert.strictEqual(t.lockedSource, SRC, 'the first usable position locks the source');
t.applyDelta(POS, OTHER_MARK, T + 1000, FOREIGN);
assert.strictEqual(t.choose(T + 1000).latitude, 26.75, "a foreign source's position is ignored");
t.applyDelta(DIST, 9999, T + 1000, FOREIGN);
assert.ok(!('distance' in t.choose(T + 1000)), "a foreign source's fields are ignored");
t.applyDelta(POS, null, T + 2000, FOREIGN);
assert.strictEqual(t.pendingClear, false, "a foreign source's null must not delete a live route");
assert.strictEqual(t.choose(T + 2000).latitude, 26.75);
t.applyDelta(POS, null, T + 3000, SRC);
assert.strictEqual(t.pendingClear, true, "the locked source's null clears");

// Before anything is locked, a clear still arms (restart mid-route, then the
// route is cancelled) and does not lock a source.
t = tracker();
t.applyDelta(POS, null, T, FOREIGN);
assert.strictEqual(t.pendingClear, true, 'a null with no lock yet still arms the clear');
assert.strictEqual(t.lockedSource, undefined, 'a clear does not lock the source');

// An explicit courseSource wins: it is the lock, from the first delta on.
t = createCourseTracker({ maxAgeMs: MAX, lockSource: SRC });
assert.strictEqual(t.lockedSource, SRC, 'an explicit source is locked at construction');
t.applyDelta(POS, OTHER_MARK, T, FOREIGN);
assert.strictEqual(t.choose(T), undefined, 'an explicit source ignores every other source');
t.applyDelta(POS, null, T, FOREIGN);
assert.strictEqual(t.pendingClear, false, "and a foreign null arms nothing");
t.applyDelta(POS, MARK, T + 1000, SRC);
assert.strictEqual(t.choose(T + 1000).latitude, 26.75, 'the configured source is published');
t.applyDelta(POS, null, T + 2000, SRC);
assert.strictEqual(t.pendingClear, true, 'the configured source clears');

// --- D: a partial position object is a glitch, not an authoritative clear ----

t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(DIST, 4000, T);
for (const partial of [{}, { longitude: -77.25 }, { latitude: 26.75 }, { latitude: null, longitude: -77.25 }]) {
  t.applyDelta(POS, partial, T + MIN);
  assert.strictEqual(t.pendingClear, false, `${JSON.stringify(partial)} is not a clear`);
}
chosen = t.choose(T + MIN);
assert.strictEqual(chosen.latitude, 26.75, 'the live leg survives a partial position');
assert.strictEqual(chosen.distance, 4000, 'and keeps its countdown');
assert.strictEqual(chosen.changedOn, T, 'and is not refreshed by one');

// A scalar position value ("no fix", 0) is a glitch too.
for (const scalar of [0, 'no fix', true]) {
  t.applyDelta(POS, scalar, T + 2 * MIN);
  assert.strictEqual(t.pendingClear, false, `${JSON.stringify(scalar)} is not a clear`);
}
assert.strictEqual(t.choose(T + 2 * MIN).latitude, 26.75, 'the live leg survives a scalar position');

// Only the documented shapes clear.
t.applyDelta(POS, { latitude: null, longitude: null }, T + 3 * MIN);
assert.strictEqual(t.pendingClear, true, 'a null coordinate PAIR is the clear');

// --- E: freshness follows the source's own timestamp ------------------------

// Signal K's `ideal` policy re-sends an unchanged value every period but keeps
// the source's original timestamp on the update. A disconnected plotter's last
// route must age out, not stay fresh forever.
t = tracker();
for (let m = 0; m <= 20; m += 1) t.applyDelta(POS, MARK, T);
assert.strictEqual(
  t.choose(T + 20 * MIN),
  undefined,
  'a value re-emitted with a frozen source timestamp ages out'
);
t = tracker();
for (let m = 0; m <= 20; m += 1) t.applyDelta(POS, MARK, T + m * MIN);
assert.ok(t.choose(T + 20 * MIN), 'advancing source timestamps keep the leg fresh');

// --- vacuous cases the review named -----------------------------------------

// Unknown nextPoint fields do nothing to a LIVE snapshot.
t = tracker();
t.applyDelta(POS, MARK, T);
t.applyDelta(HREF, '/resources/waypoints/gt', T);
t.applyResolvedName('/resources/waypoints/gt', 'Green Turtle');
t.applyDelta(`${GREAT_CIRCLE}.nextPoint.bearingTrue`, 1.2, T + MIN);
t.applyDelta(`${GREAT_CIRCLE}.nextPoint.velocityMadeGood`, 3, T + MIN);
chosen = t.choose(T + MIN);
assert.strictEqual(chosen.changedOn, T, 'an unknown nextPoint field does not refresh a live leg');
assert.ok(!('bearingTrue' in chosen) && !('velocityMadeGood' in chosen), 'nor lands on it');

// A failed name lookup leaves the name already on the leg intact.
t.applyResolvedName('/resources/waypoints/gt', null);
assert.strictEqual(t.choose(T + MIN).name, 'Green Turtle', 'a null name leaves the resolved one intact');

console.log('course.test.js: all assertions passed');
