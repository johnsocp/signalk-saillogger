/*
 * entropysaillog ingest payload builder.
 *
 * Maps buffered Signal K rows to the versioned /ingest wire contract and derives
 * a DURABLE batch idempotency id. The id is a pure function of the buffered
 * rows' timestamp range + count, and the buffer is persisted on disk, so after a
 * plugin restart the same rows produce the same id — a resend overwrites the
 * same object on the server instead of duplicating track points.
 */

const SCHEMA_VERSION = 1;

// A course snapshot older than this is not worth sending — the plotter may have
// been turned off. The contract documents the same 5 min bound.
const COURSE_MAX_AGE_MS = 5 * 60 * 1000;
const WAYPOINT_NAME_MAX = 80;

// Any UTF-16 code unit that is not part of a well-formed surrogate pair. A name
// can arrive ALREADY broken — a byte-truncated emoji in a GPX import — and
// JSON.stringify emits such a code unit verbatim, which makes the whole request
// body unparseable for the server (400 → the plugin purges its buffer). Not
// String.prototype.toWellFormed: the Cerbo's Node may predate it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Clean a plotter-supplied waypoint name for the wire: drop control characters
// (C0/DEL/C1 — a chartplotter export can carry NULs and newlines) and lone
// surrogates, trim, and truncate by CODE POINTS. Never String.prototype.slice:
// cutting mid-surrogate emits a lone surrogate that the server's JSON parser
// rejects, which would fail the whole batch. Returns '' when nothing usable is
// left.
function cleanWaypointName(name) {
  if (typeof name !== 'string') return '';
  const stripped = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(LONE_SURROGATE, '')
    .trim();
  if (stripped.length === 0) return '';
  const codePoints = Array.from(stripped);
  if (codePoints.length <= WAYPOINT_NAME_MAX) return stripped;
  return codePoints.slice(0, WAYPOINT_NAME_MAX).join('');
}

function round(value, places) {
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

// Map one buffered row to a contract point, or null if it isn't a usable fix.
// Only contract-allowed fields are emitted (the ingest schema is strict).
function rowToPoint(row) {
  if (!row || typeof row.ts !== 'number' || !Number.isFinite(row.ts)) return null;
  const { latitude: lat, longitude: lon } = row;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const point = {
    timestamp: new Date(row.ts).toISOString(),
    lat: round(lat, 6),
    lon: round(lon, 6),
  };
  const sog = row.speedOverGround;
  if (typeof sog === 'number' && Number.isFinite(sog) && sog >= 0) {
    point.sog = round(sog, 1);
  }
  const cog = row.courseOverGroundTrue;
  if (typeof cog === 'number' && Number.isFinite(cog) && cog >= 0 && cog <= 360) {
    point.cog = round(cog, 1);
  }
  const tws = row.windSpeedTrue;
  if (typeof tws === 'number' && Number.isFinite(tws) && tws >= 0) {
    point.tws = round(tws, 1);
  }
  const twd = row.windDirectionTrue;
  if (typeof twd === 'number' && Number.isFinite(twd) && twd >= 0 && twd <= 360) {
    point.twd = round(twd, 1);
  }
  return point;
}

// Map a plotter course snapshot ({ name?, latitude, longitude, distance?,
// timeToGo?, changedOn }) to the contract's next_waypoint object, or undefined
// when there is nothing worth saying: no snapshot, unusable coordinates, or a
// snapshot older than COURSE_MAX_AGE_MS. Pure; `now` is injectable for tests.
function courseToNextWaypoint(course, now = Date.now()) {
  if (!course || typeof course !== 'object') return undefined;
  const changedOn = course.changedOn;
  if (typeof changedOn !== 'number' || !Number.isFinite(changedOn)) return undefined;
  if (now - changedOn > COURSE_MAX_AGE_MS) return undefined;

  const { latitude: lat, longitude: lon } = course;
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;

  const waypoint = {
    lat: round(lat, 6),
    lon: round(lon, 6),
    observed_at: new Date(changedOn).toISOString(),
  };
  const name = cleanWaypointName(course.name);
  if (name.length > 0) {
    waypoint.name = name;
  }
  const distance = course.distance;
  if (typeof distance === 'number' && Number.isFinite(distance) && distance >= 0) {
    waypoint.distance_m = distance;
  }
  const timeToGo = course.timeToGo;
  if (typeof timeToGo === 'number' && Number.isFinite(timeToGo) && timeToGo >= 0) {
    waypoint.time_to_go_s = timeToGo;
  }
  return waypoint;
}

// Durable, deterministic id for the rows in this batch. Survives restarts
// because it depends only on the persisted rows, not on wall-clock or state.
function batchId(rows) {
  const first = rows[0].ts;
  const last = rows[rows.length - 1].ts;
  return `${first}-${last}-${rows.length}`;
}

// Build a contract-shaped batch from buffered rows, or null if there are no
// usable points (caller should then purge the unusable rows from the buffer).
//
// `course` carries the plotter's active route: undefined = nothing to say (the
// key is omitted and the server leaves its stored course untouched), null = the
// route was cleared (emit next_waypoint: null so the server deletes it), or a
// snapshot object to upsert.
function buildBatch(rows, course, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const points = [];
  for (const row of rows) {
    const point = rowToPoint(row);
    if (point) points.push(point);
  }
  if (points.length === 0) return null;
  const batch = { schema_version: SCHEMA_VERSION, batch_id: batchId(rows), points };
  if (course === null) {
    batch.next_waypoint = null;
  } else {
    const waypoint = courseToNextWaypoint(course, now);
    if (waypoint) batch.next_waypoint = waypoint;
  }
  return batch;
}

module.exports = { SCHEMA_VERSION, COURSE_MAX_AGE_MS, rowToPoint, batchId, cleanWaypointName, courseToNextWaypoint, buildBatch };
