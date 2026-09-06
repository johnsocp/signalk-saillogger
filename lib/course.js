/*
 * Active-route ("next waypoint") state machine.
 *
 * Signal K publishes the plotter's active leg as four independent deltas per
 * course type — nextPoint.{position,distance,timeToGo,href} — so what we send
 * has to be assembled from a stream of partial updates. This module owns that
 * assembly and nothing else: no Signal K, no HTTP, no clock of its own (every
 * entry point takes `now`), so the whole state machine is unit-testable.
 *
 * Great circle is preferred; rhumbline is the fallback when great circle is
 * missing or older than maxAgeMs. `choose()` speaks the three wire states of
 * lib/payload.js's `course` argument: undefined = say nothing, null = the route
 * was cleared (delete it), an object = upsert it.
 */

const { COURSE_MAX_AGE_MS } = require('./payload');

const GREAT_CIRCLE = 'navigation.courseGreatCircle';
const RHUMBLINE = 'navigation.courseRhumbline';
const PREFIXES = [GREAT_CIRCLE, RHUMBLINE];
const FIELDS = { distance: 'distance', timeToGo: 'timeToGo', href: 'href' };

// Split 'navigation.courseGreatCircle.nextPoint.distance' into its course
// prefix and its field; returns null for anything else.
function parsePath(path) {
  if (typeof path !== 'string') return null;
  const marker = path.indexOf('.nextPoint.');
  if (marker < 0) return null;
  const prefix = path.slice(0, marker);
  if (!PREFIXES.includes(prefix)) return null;
  return { prefix, field: path.slice(marker + '.nextPoint.'.length) };
}

function createCourseTracker({ maxAgeMs = COURSE_MAX_AGE_MS } = {}) {
  // prefix -> undefined (never seen) | null (cleared) | active snapshot object
  // ({ latitude, longitude, changedOn, name?, href?, distance?, timeToGo? }).
  const snapshots = {};
  // href -> resolved waypoint name, so a later href delta can re-name a leg
  // without a second resources lookup.
  const names = {};
  // Set when a route goes to null; stays set until the server has accepted a
  // batch that actually carried next_waypoint: null.
  let pendingClear = false;

  function isActive(prefix) {
    return !!snapshots[prefix];
  }

  function isUsable(snapshot, now) {
    return !!snapshot && now - snapshot.changedOn <= maxAgeMs;
  }

  function clear(prefix) {
    // Arm the clear unless this prefix is already known to be cleared: a repeat
    // null must not re-arm a clear the server has already accepted, but a null
    // for a prefix we have never seen must (the plugin can restart mid-route
    // and then the route is cancelled — there is no snapshot to compare to, and
    // a redundant delete of a missing row is harmless).
    if (snapshots[prefix] !== null) {
      pendingClear = true;
    }
    snapshots[prefix] = null;
  }

  // A nextPoint delta for one course type. A null/unusable position value means
  // the route was cleared; a usable one starts a FRESH leg. distance/timeToGo/
  // href fill in the current leg — and, like position, refresh its changedOn:
  // a fixed mark stops re-emitting position, and the leg must not go stale
  // while the plotter is still counting it down.
  function applyDelta(path, value, now = Date.now()) {
    const parsed = parsePath(path);
    if (!parsed) return;
    const { prefix, field } = parsed;

    if (field === 'position') {
      if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
        clear(prefix);
        return;
      }
      // A new route while a clear is still pending supersedes it — but only if
      // nothing else is under way; an unrelated active leg keeps the clear.
      if (pendingClear && !PREFIXES.some(isActive)) {
        pendingClear = false;
      }
      // Fresh object: the previous leg's name/href/distance/timeToGo must not
      // be attributed to the new mark.
      snapshots[prefix] = { latitude: value.latitude, longitude: value.longitude, changedOn: now };
      return;
    }

    if (!FIELDS[field]) return;
    const snapshot = snapshots[prefix];
    if (!snapshot) return;
    snapshot[field] = value;
    snapshot.changedOn = now;
    if (field === 'href' && typeof names[value] === 'string') {
      snapshot.name = names[value];
    }
  }

  // A waypoint name that resolved (or was already cached) for `href`. It is
  // only attached to a leg still pointing at that href.
  function applyResolvedName(href, name) {
    if (typeof href !== 'string' || typeof name !== 'string' || name.length === 0) return;
    names[href] = name;
    for (const prefix of PREFIXES) {
      const snapshot = snapshots[prefix];
      if (snapshot && snapshot.href === href) {
        snapshot.name = name;
      }
    }
  }

  // undefined = say nothing, null = the route was cleared, object = upsert.
  // A pending clear outranks everything: losing it would leave a deleted route
  // showing on the tracker until the next one starts.
  function choose(now = Date.now()) {
    if (pendingClear) return null;
    const greatCircle = snapshots[GREAT_CIRCLE];
    if (isUsable(greatCircle, now)) return greatCircle;
    const rhumbline = snapshots[RHUMBLINE];
    if (isUsable(rhumbline, now)) return rhumbline;
    return undefined;
  }

  // The server accepted a batch; `carriedNull` says whether that batch actually
  // carried next_waypoint: null. Anything else leaves the clear pending so the
  // next push resends it.
  function onBatchAccepted(carriedNull) {
    if (carriedNull) pendingClear = false;
  }

  return {
    applyDelta,
    applyResolvedName,
    choose,
    onBatchAccepted,
    get pendingClear() {
      return pendingClear;
    },
  };
}

module.exports = { createCourseTracker, GREAT_CIRCLE, RHUMBLINE };
