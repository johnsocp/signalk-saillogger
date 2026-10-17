/*
 * Subscription-delta helpers, kept pure so they can be tested without Signal K.
 */

// How long the configured GPS may go without a position before other sources
// are accepted. Twice Signal K's default source-priority fallback (15 s).
const GPS_FALLBACK_MS = 30 * 1000;

// Position, SOG and COG all come from the one GPS the `source` option names, so a
// stored row never mixes one device's fix with another's speed or course.
const GPS_PATHS = new Set([
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue'
]);

// The one value a subscription delta carries, or null for a delta without values
// (Signal K sends meta-only updates, e.g. when a provider (re)connects).
function deltaValue(data) {
  const update = data && data.updates && data.updates[0];
  const dict = update && update.values && update.values[0];
  if (!dict) {
    return null;
  }
  return { path: dict.path, value: dict.value, source: update['$source'] };
}

// Takes position, SOG and COG from one source at a time: the configured GPS while it
// sends positions; once the current source has gone GPS_FALLBACK_MS without one, the
// first other source to send a position, locked until it too goes quiet or the
// configured GPS is back. `source` is the source currently accepted. `startedAt`
// starts the clock, so a GPS that never appears still falls back. Times must come
// from a monotonic clock: a wall clock stepped backwards would hold off fallback.
function createGpsGate(gpsSource, startedAt = 0) {
  let current = gpsSource;
  let lastFix = startedAt;
  return {
    get source() {
      return current;
    },
    accepts(path, source, now) {
      if (!gpsSource || !GPS_PATHS.has(path)) {
        return true;
      }
      if (path !== 'navigation.position') {
        return source == current;
      }
      if (source == gpsSource || source == current || now - lastFix > GPS_FALLBACK_MS) {
        current = source;
        lastFix = now;
        return true;
      }
      return false;
    }
  };
}

module.exports = { deltaValue, createGpsGate, GPS_FALLBACK_MS };
