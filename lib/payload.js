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
  return point;
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
function buildBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const points = [];
  for (const row of rows) {
    const point = rowToPoint(row);
    if (point) points.push(point);
  }
  if (points.length === 0) return null;
  return { schema_version: SCHEMA_VERSION, batch_id: batchId(rows), points };
}

module.exports = { SCHEMA_VERSION, rowToPoint, batchId, buildBatch };
