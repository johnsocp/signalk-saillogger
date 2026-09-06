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

// The same validity test the payload mapper applies: a position it would drop
// must not be mistaken here for a new leg (the snapshot would then be silently
// unsendable). Anything else — NaN, out of range, wrong type — is a clear.
function isUsablePosition(value) {
  if (!value || typeof value !== 'object') return false;
  const { latitude: lat, longitude: lon } = value;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// Same mark, re-emitted. 1e-6 deg is the wire's rounding, ~0.1 m.
function samePosition(snapshot, value) {
  return (
    Math.abs(snapshot.latitude - value.latitude) < 1e-6 &&
    Math.abs(snapshot.longitude - value.longitude) < 1e-6
  );
}

function createCourseTracker({ maxAgeMs = COURSE_MAX_AGE_MS } = {}) {
  // prefix -> undefined (never seen) | null (cleared) | active snapshot object
  // ({ latitude, longitude, changedOn, name?, href?, distance?, timeToGo? }).
  const snapshots = {};
  // href -> resolved waypoint name, so a later href delta can re-name a leg
  // without a second resources lookup.
  const names = {};
  // prefix -> when its route was cleared. A clear younger than maxAgeMs outranks
  // the other course type's leg (see choose()).
  const clearedAt = {};
  // Set when a route goes to null; stays set until the server has accepted a
  // batch that actually carried next_waypoint: null.
  let pendingClear = false;

  function isActive(prefix) {
    return !!snapshots[prefix];
  }

  function isUsable(snapshot, now) {
    return !!snapshot && now - snapshot.changedOn <= maxAgeMs;
  }

  function clear(prefix, now) {
    // Arm the clear unless this prefix is already known to be cleared: a repeat
    // null must not re-arm a clear the server has already accepted, but a null
    // for a prefix we have never seen must (the plugin can restart mid-route
    // and then the route is cancelled — there is no snapshot to compare to, and
    // a redundant delete of a missing row is harmless).
    if (snapshots[prefix] !== null) {
      pendingClear = true;
    }
    snapshots[prefix] = null;
    clearedAt[prefix] = now;
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
      if (!isUsablePosition(value)) {
        clear(prefix, now);
        return;
      }
      const current = snapshots[prefix];
      // The plotter re-emits the position of an UNCHANGED mark every period.
      // That is not a new leg: only freshness changes, and wiping distance/
      // timeToGo/name here would blank them on every poll.
      if (current && samePosition(current, value)) {
        current.changedOn = now;
        return;
      }
      // A new route while a clear is still pending supersedes it — but only if
      // nothing else is under way; an unrelated active leg keeps the clear.
      if (pendingClear && !PREFIXES.some(isActive)) {
        pendingClear = false;
      }
      // A real leg change. The previous leg's name/distance/timeToGo must not
      // be attributed to the new mark, but the href is the mark's IDENTITY and
      // its delta may arrive either side of the position one, so it is carried
      // over: with href first the new leg is already correctly identified (and
      // the name lands on it as soon as it resolves). With position first the
      // carried href still points at the PREVIOUS mark until its own delta
      // arrives, so a name resolving in that window can mislabel the new mark
      // for at most one poll interval.
      const next = { latitude: value.latitude, longitude: value.longitude, changedOn: now };
      if (current && typeof current.href === 'string') {
        next.href = current.href;
      }
      snapshots[prefix] = next;
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
    for (const prefix of PREFIXES) {
      // A recent clear outranks the other course type's leg: both types track
      // the same mark, and only one of them need emit the null. Falling through
      // to the other one's still-fresh snapshot would republish the route the
      // plotter just deleted.
      if (snapshots[prefix] === null && now - clearedAt[prefix] <= maxAgeMs) return undefined;
      if (isUsable(snapshots[prefix], now)) return snapshots[prefix];
    }
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
