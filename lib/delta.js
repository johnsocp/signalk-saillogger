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

// Prefers the configured GPS; once it has gone GPS_FALLBACK_MS without a position,
// accepts whatever source Signal K passes through until the configured one is back.
// `startedAt` starts the clock, so a GPS that never appears still falls back.
function createGpsGate(gpsSource, startedAt = 0) {
  let lastPinnedFix = startedAt;
  return {
    accepts(path, source, now) {
      if (!gpsSource || !GPS_PATHS.has(path)) {
        return true;
      }
      if (source == gpsSource) {
        if (path === 'navigation.position') {
          lastPinnedFix = now;
        }
        return true;
      }
      return now - lastPinnedFix > GPS_FALLBACK_MS;
    }
  };
}

module.exports = { deltaValue, createGpsGate, GPS_FALLBACK_MS };
