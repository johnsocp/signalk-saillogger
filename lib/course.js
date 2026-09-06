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

function createCourseTracker({ maxAgeMs = COURSE_MAX_AGE_MS } = {}) {
  // prefix -> undefined (never seen) | null (cleared) | active snapshot object
  // ({ latitude, longitude, changedOn, name?, href?, distance?, timeToGo? }).
  const snapshots = {};
  // href -> resolved waypoint name, so a later href delta can re-name a leg
  // without a second resources lookup.
  const names = {};
  // prefix -> when its route was cleared, recorded only on the TRANSITION into
  // the cleared state; a repeated null is not a new clear. choose() compares it
  // against each snapshot's changedOn (see there).
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
    // Arm the clear (and record when) unless this prefix is already known to be
    // cleared: a repeat null is not a new clear — it must neither re-arm one the
    // server has already accepted nor keep pushing clearedAt forward, which
    // would hold off the other course type's live leg for as long as the nulls
    // keep coming. A null for a prefix we have NEVER seen does arm one (the
    // plugin can restart mid-route and then the route is cancelled — there is
    // no snapshot to compare to, and a redundant delete of a missing row is
    // harmless).
    if (snapshots[prefix] !== null) {
      pendingClear = true;
      clearedAt[prefix] = now;
    }
    snapshots[prefix] = null;
  }

  // A nextPoint delta for one course type. A no-destination position value means
  // the route was cleared; a usable one starts a FRESH leg; anything else is a
  // glitch and is dropped on the floor. distance/timeToGo/href fill in the
  // current leg — and, like position, refresh its changedOn: a fixed mark stops
  // re-emitting position, and the leg must not go stale while the plotter is
  // still counting it down.
  function applyDelta(path, value, now = Date.now()) {
    const parsed = parsePath(path);
    if (!parsed) return;
    const { prefix, field } = parsed;

    if (field === 'position') {
      if (isClearPosition(value)) {
        clear(prefix, now);
        return;
      }
      // A glitched position says nothing about the route: ignore the delta
      // outright — no leg change, no clear, no freshness bump.
      if (!isUsablePosition(value)) return;
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
      // until the next href delta on this prefix — which for a goto-position
      // with no href of its own may never come.
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
    for (const prefix of PREFIXES) {
      const snapshot = snapshots[prefix];
      if (snapshot && snapshot.href === href) {
        snapshot.name = name;
      }
    }
  }

  // The snapshot as it goes on the wire: bookkeeping stripped, and a distance or
  // timeToGo whose own delta has gone stale left out. Position re-emission keeps
  // the LEG fresh (a fixed mark still counts down), but it says nothing about a
  // countdown whose source has stopped, and publishing that would slide an ETA
  // forever.
  function present(snapshot, now) {
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
  // A pending clear outranks everything: losing it would leave a deleted route
  // showing on the tracker until the next one starts.
  //
  // After a clear, eligibility is decided by UPDATE ORDER, not by a time window.
  // Both course types track the same mark and only one of them need emit the
  // null, so the other type's snapshot is then a leftover of the deleted route
  // and must not be republished. A time window cannot express that: it is too
  // strong (a plotter with no great-circle destination emits that null on every
  // poll, which would suppress a LIVE rhumbline leg for as long as it runs, and
  // even one clear makes a genuinely new route on the other prefix wait out the
  // window) and too weak (whether it is consulted at all depends on where the
  // cleared prefix sits in PREFIXES). Update order is exact: a snapshot last
  // updated AFTER the most recent clear was refreshed by the plotter with the
  // deletion already in effect, so it is a live or a new leg; one last updated
  // before it is a leftover.
  function choose(now = Date.now()) {
    if (pendingClear) return null;
    let lastClear = -Infinity;
    for (const prefix of PREFIXES) {
      const at = clearedAt[prefix];
      if (typeof at === 'number' && at > lastClear) lastClear = at;
    }
    for (const prefix of PREFIXES) {
      const snapshot = snapshots[prefix];
      if (isUsable(snapshot, now) && snapshot.changedOn > lastClear) return present(snapshot, now);
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

module.exports = { createCourseTracker, isUsablePosition, GREAT_CIRCLE, RHUMBLINE };
