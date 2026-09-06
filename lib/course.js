/*
 * Active-route ("next waypoint") state machine.
 *
 * Signal K publishes the plotter's active leg as four independent deltas —
 * nextPoint.{position,distance,timeToGo,href} — so what we send has to be
 * assembled from a stream of partial updates. This module owns that assembly
 * and nothing else: no Signal K, no HTTP, no clock of its own (every entry
 * point takes `now`), so the whole state machine is unit-testable.
 *
 * Exactly ONE course prefix is tracked, chosen by the plugin's `coursePrefix`
 * option (great circle by default). Signal K's two course families
 * (courseGreatCircle, courseRhumbline) emit independent, independently
 * throttled deltas, and the default `ideal` subscription policy re-sends an
 * unchanged value every period — so with both families subscribed, no rule
 * (time window, update order, mark suppression) can tell a leftover of a
 * deleted route on one family from a live leg on the other. With a single
 * family the question does not arise: the deleted route's own path goes null
 * here, re-emission cannot resurrect it, and any non-null position after a
 * null is a real (re)activation.
 *
 * `choose()` speaks the three wire states of lib/payload.js's `course`
 * argument: undefined = say nothing, null = the route was cleared (delete it),
 * an object = upsert it.
 */

const { COURSE_MAX_AGE_MS } = require('./payload');

const GREAT_CIRCLE = 'navigation.courseGreatCircle';
const RHUMBLINE = 'navigation.courseRhumbline';
const FIELDS = { distance: 'distance', timeToGo: 'timeToGo', href: 'href' };

// The same validity test the payload mapper applies: a position it would drop
// must not be mistaken here for a new leg (the snapshot would then be silently
// unsendable). lib/course.test.js pins this predicate against the mapper's.
function isUsablePosition(value) {
  if (!value || typeof value !== 'object') return false;
  const { latitude: lat, longitude: lon } = value;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// The plotter's documented "no destination" shapes: a null (or absent) value,
// or an object whose latitude/longitude is null or absent. Any OTHER value that
// fails isUsablePosition — NaN, out of range, wrong type — is a glitch and is
// ignored, never a clear: one bad delta must not delete a live course.
function isClearPosition(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  const { latitude: lat, longitude: lon } = value;
  return lat === null || lat === undefined || lon === null || lon === undefined;
}

// Same mark, re-emitted. 1e-6 deg is the wire's rounding, ~0.1 m.
function samePosition(snapshot, value) {
  return (
    Math.abs(snapshot.latitude - value.latitude) < 1e-6 &&
    Math.abs(snapshot.longitude - value.longitude) < 1e-6
  );
}

function createCourseTracker({ maxAgeMs = COURSE_MAX_AGE_MS, prefix = GREAT_CIRCLE } = {}) {
  const marker = `${prefix}.nextPoint.`;
  // undefined (never seen) | null (cleared) | active snapshot object
  // ({ latitude, longitude, changedOn, name?, href?, distance?, timeToGo? }).
  let snapshot;
  // href -> resolved waypoint name, so a later href delta can re-name a leg
  // without a second resources lookup.
  const names = {};
  // Set when the route goes to null; stays set until the server has accepted a
  // batch that actually carried next_waypoint: null.
  let pendingClear = false;

  // The field of a nextPoint delta under the configured prefix; null for any
  // other path, including the other course family's — those are not subscribed
  // and are not this tracker's business either way.
  function fieldOf(path) {
    if (typeof path !== 'string') return null;
    if (!path.startsWith(marker)) return null;
    return path.slice(marker.length);
  }

  function isUsable(now) {
    return !!snapshot && now - snapshot.changedOn <= maxAgeMs;
  }

  // A nextPoint delta. A no-destination position value means the route was
  // cleared; a usable one starts a FRESH leg; anything else is a glitch and is
  // dropped on the floor. distance/timeToGo/href fill in the current leg — and,
  // like position, refresh its changedOn: a fixed mark stops re-emitting
  // position, and the leg must not go stale while the plotter is still counting
  // it down.
  function applyDelta(path, value, now = Date.now()) {
    const field = fieldOf(path);
    if (field === null) return;

    if (field === 'position') {
      if (isClearPosition(value)) {
        // Arm the clear unless the route is already known to be cleared: a
        // repeat null is not a new clear and must not re-arm one the server has
        // already accepted. A null for a route we have NEVER seen does arm one
        // (the plugin can restart mid-route and then the route is cancelled —
        // there is no snapshot to compare to, and a redundant delete of a
        // missing row is harmless).
        if (snapshot !== null) pendingClear = true;
        snapshot = null;
        return;
      }
      // A glitched position says nothing about the route: ignore the delta
      // outright — no leg change, no clear, no freshness bump.
      if (!isUsablePosition(value)) return;
      const current = snapshot;
      // The plotter re-emits the position of an UNCHANGED mark every period.
      // That is not a new leg: only freshness changes, and wiping distance/
      // timeToGo/name here would blank them on every poll.
      if (current && samePosition(current, value)) {
        current.changedOn = now;
        return;
      }
      // A usable position after a null is a (re)activation — of the same mark
      // or a new one — and supersedes the pending clear: the upsert overwrites
      // the delete anyway. Re-emission of the deleted route cannot reach here,
      // because that route's own path is the one that went null.
      pendingClear = false;
      // A real leg change. The previous leg's name/distance/timeToGo must not
      // be attributed to the new mark, but the href is the mark's IDENTITY and
      // its delta may arrive either side of the position one, so it is carried
      // over: with href first the new leg is already correctly identified (and
      // the name lands on it as soon as it resolves). With position first the
      // carried href still points at the PREVIOUS mark until its own delta
      // arrives, so a name resolving in that window can mislabel the new mark
      // until the next href delta — which for a goto-position with no href of
      // its own may never come.
      const next = { latitude: value.latitude, longitude: value.longitude, changedOn: now };
      if (current && typeof current.href === 'string') {
        next.href = current.href;
      }
      snapshot = next;
      return;
    }

    if (!FIELDS[field]) return;
    if (!snapshot) return;
    snapshot[field] = value;
    snapshot.changedOn = now;
    if (field === 'distance') snapshot.distanceAt = now;
    if (field === 'timeToGo') snapshot.timeToGoAt = now;
    if (field === 'href' && typeof names[value] === 'string') {
      snapshot.name = names[value];
    }
  }

  // A waypoint name that resolved (or was already cached) for `href`. It is
  // only attached to a leg still pointing at that href.
  function applyResolvedName(href, name) {
    if (typeof href !== 'string' || typeof name !== 'string' || name.length === 0) return;
    names[href] = name;
    if (snapshot && snapshot.href === href) {
      snapshot.name = name;
    }
  }

  // The snapshot as it goes on the wire: bookkeeping stripped, and a distance or
  // timeToGo whose own delta has gone stale left out. Position re-emission keeps
  // the LEG fresh (a fixed mark still counts down), but it says nothing about a
  // countdown whose source has stopped, and publishing that would slide an ETA
  // forever.
  function present(now) {
    const out = {
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      changedOn: snapshot.changedOn,
    };
    if ('href' in snapshot) out.href = snapshot.href;
    if ('name' in snapshot) out.name = snapshot.name;
    if ('distance' in snapshot && now - snapshot.distanceAt <= maxAgeMs) {
      out.distance = snapshot.distance;
    }
    if ('timeToGo' in snapshot && now - snapshot.timeToGoAt <= maxAgeMs) {
      out.timeToGo = snapshot.timeToGo;
    }
    return out;
  }

  // undefined = say nothing, null = the route was cleared, object = upsert.
  // A pending clear outranks the snapshot: losing it would leave a deleted
  // route showing on the tracker until the next one starts.
  function choose(now = Date.now()) {
    if (pendingClear) return null;
    if (isUsable(now)) return present(now);
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

module.exports = { createCourseTracker, isUsablePosition, GREAT_CIRCLE, RHUMBLINE };
