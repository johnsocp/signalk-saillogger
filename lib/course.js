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

// The plotter's documented "no destination" shapes, and ONLY those: a null (or
// absent) value, or an object whose latitude AND longitude are both explicitly
// null. Any other value that fails isUsablePosition — a partial object ({},
// {longitude}), a scalar (0, "no fix"), NaN, out of range, the wrong type — is a
// glitch and is ignored, never a clear: one bad delta must not delete a live
// course, and half an object is not the plotter saying the route is over.
function isClearPosition(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  return value.latitude === null && value.longitude === null;
}

// Same mark, re-emitted. 1e-6 deg is the wire's rounding, ~0.1 m.
function samePosition(snapshot, value) {
  return (
    Math.abs(snapshot.latitude - value.latitude) < 1e-6 &&
    Math.abs(snapshot.longitude - value.longitude) < 1e-6
  );
}

// A persisted pending clear, if the store has a sane one. Anything else (no
// store, an unreadable one, a junk shape) is a clean start.
function loadPendingSeq(persist) {
  if (!persist || typeof persist.load !== 'function') return 0;
  const state = persist.load();
  if (!state || typeof state !== 'object') return 0;
  const seq = state.pendingClearSeq;
  if (!Number.isInteger(seq) || seq <= 0) return 0;
  return seq;
}

function createCourseTracker({
  maxAgeMs = COURSE_MAX_AGE_MS,
  prefix = GREAT_CIRCLE,
  persist,
  lockSource,
} = {}) {
  const marker = `${prefix}.nextPoint.`;
  // undefined (never seen) | null (cleared) | active snapshot object
  // ({ latitude, longitude, changedOn, name?, href?, distance?, timeToGo? }).
  let snapshot;
  // href -> resolved waypoint name, so a later href delta can re-name a leg
  // without a second resources lookup.
  const names = {};
  // The sequence of the clear awaiting acknowledgement; 0 = none. It is a
  // sequence and not a flag for two reasons: it is PERSISTED (a plugin or server
  // restart between the null delta and the accepted push would otherwise forget
  // the delete forever), and a 200 for an older, slower batch must not disarm a
  // newer clear it never carried — the ack names the clear it sent.
  let pendingClearSeq = loadPendingSeq(persist);
  // Monotonic within a process; restored so a restart does not reissue a
  // sequence still in flight.
  let lastSeq = pendingClearSeq;

  // The $source the course paths are read from. Configured (`lockSource`) it is
  // fixed from the start; unconfigured, the first source to report a usable
  // destination takes the lock. Two devices publishing the same course family
  // otherwise alternate marks, and one's null deletes the other's live route.
  const configuredSource = typeof lockSource === 'string' && lockSource.length > 0
    ? lockSource
    : undefined;
  let lockedSource = configuredSource;
  let sourceLocked = configuredSource !== undefined;

  function setPendingSeq(seq) {
    if (seq === pendingClearSeq) return;
    pendingClearSeq = seq;
    if (persist && typeof persist.save === 'function') {
      persist.save({ pendingClearSeq });
    }
  }

  // Which deltas this tracker listens to. Until a source is locked nothing can
  // be judged foreign, so everything is accepted (a clear arriving before any
  // leg — restarted mid-route, then cancelled — must still arm); the lock is
  // taken by the first USABLE position, which is the only delta that identifies
  // a device actually driving a route.
  function acceptSource(field, value, source) {
    if (sourceLocked) return source === lockedSource;
    if (field === 'position' && isUsablePosition(value)) {
      lockedSource = source;
      sourceLocked = true;
    }
    return true;
  }

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
  function applyDelta(path, value, now = Date.now(), source = undefined) {
    const field = fieldOf(path);
    if (field === null) return;
    if (!acceptSource(field, value, source)) return;

    if (field === 'position') {
      if (isClearPosition(value)) {
        // Arm the clear unless the route is already known to be cleared: a
        // repeat null is not a new clear and must not re-arm one the server has
        // already accepted. A null for a route we have NEVER seen does arm one
        // (the plugin can restart mid-route and then the route is cancelled —
        // there is no snapshot to compare to, and a redundant delete of a
        // missing row is harmless).
        if (snapshot !== null) {
          lastSeq += 1;
          setPendingSeq(lastSeq);
        }
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
      setPendingSeq(0);
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
    if (pendingClearSeq !== 0) return null;
    if (isUsable(now)) return present(now);
    return undefined;
  }

  // The server accepted a batch; `seq` is the pendingClearSeq that batch was
  // BUILT with (0 when it carried no next_waypoint: null). Only an ack for the
  // clear still pending disarms it — a 200 arriving late for an older batch
  // carried the older null, not this one, and leaves the clear pending so the
  // next push resends it.
  function onBatchAccepted(seq) {
    if (seq !== 0 && seq === pendingClearSeq) setPendingSeq(0);
  }

  return {
    applyDelta,
    applyResolvedName,
    choose,
    onBatchAccepted,
    get pendingClear() {
      return pendingClearSeq !== 0;
    },
    get pendingClearSeq() {
      return pendingClearSeq;
    },
    get lockedSource() {
      return lockedSource;
    },
  };
}

module.exports = { createCourseTracker, isUsablePosition, GREAT_CIRCLE, RHUMBLINE };
