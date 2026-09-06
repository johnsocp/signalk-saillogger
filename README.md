# signalk-entropy-saillog

A Signal K plugin that pushes position data to your **entropysaillog** tracker
ingest. A fork of [signalk-saillogger](https://github.com/Saillogger/signalk-saillogger)
repointed at your own `POST /ingest` endpoint: it collects position, SOG, and COG
from Signal K, buffers them through connectivity dropouts, and pushes batches.

The saillogger.com metadata / AIS / monitoring-config push paths are removed —
this fork only feeds the live tracker.

## Install

In the Signal K server **Appstore**, search for **`signalk-entropy-saillog`**,
install it, and restart the server. (It's published to npm with the
`signalk-node-server-plugin` keyword, so it appears in the Appstore like any
other plugin — no shell/SSH access needed.)

## Configure

In the Signal K plugin config:

- **Ingest URL** — your `POST /ingest` endpoint, e.g.
  `https://xxxxx.execute-api.us-west-2.amazonaws.com/ingest`
- **HMAC signing secret** *(recommended)* — signs each push with `x-timestamp` +
  `x-signature`. Set this and leave the API key empty.
- **API key** *(optional fallback)* — sent as `x-api-key`; only used when no
  secret is set. Provide a **secret OR an API key** (endpoint plus at least one
  credential is required).
- **GPS source** *(optional)* — restrict to one GPS `$source` if you have several.

## What it sends

Each push is one versioned-contract batch:

```json
{
  "schema_version": 1,
  "batch_id": "<firstTs>-<lastTs>-<count>",
  "points": [
    { "timestamp": "2026-06-16T03:00:00.000Z", "lat": 26.70, "lon": -77.20, "sog": 6.5, "cog": 110.0 }
  ]
}
```

### Next waypoint (v1.2.0)

When the plotter has an active route, each batch also carries a vessel-level
`next_waypoint` object (`name`, `lat`, `lon`, `distance_m`, `time_to_go_s`,
`observed_at`) built from `navigation.courseGreatCircle.nextPoint.{position,
distance,timeToGo,href}` — falling back to `navigation.courseRhumbline.*` when
the great-circle snapshot is missing or over 5 minutes old (but *not* while that
snapshot is still on the mark it was tracking when the route was cleared on the
other course type — a clear is never undone by the leftover leg it deleted, and
timestamps can't tell the two apart because Signal K re-sends an unchanged value
every period; the leftover is released as soon as its mark changes). The
trade-off: a leg on the other course type that was genuinely live at the moment
of the clear is hidden until its own mark changes — a plotter that emits a
one-time null at startup and then only rhumbline legs is unaffected, since legs
that start after that null are never suppressed. The name is resolved best-effort from the
`href` via the Signal K resources API; if it doesn't resolve, the field is
simply absent. The name is sanitized before it is sent — control characters and
unpaired surrogates stripped, trimmed, and truncated to 80 code points (never
mid-character) — and omitted when nothing usable is left. Snapshots older than 5
minutes are not sent; any `nextPoint` update (position, distance, time to go, or
href) keeps the snapshot fresh, so a fixed mark doesn't age out mid-leg;
`distance_m` and `time_to_go_s` age out on their own clock, so a countdown whose
source has stopped is omitted rather than sent stale.

The three states are distinct on the wire: the key **absent** means "no news,
leave the stored course alone", an explicit **`null`** (sent once, when the
route is cleared on the plotter) tells the server to delete it, and an
**object** upserts it.

- **Auth:** with a secret configured, each push is signed — HMAC-SHA256 over
  `"<x-timestamp>.<body>"` sent as `x-signature` (mirrors the server's
  `auth.py`); the server rejects stale timestamps and bad signatures. Without a
  secret it falls back to the `x-api-key` header.
- **Durable idempotency:** `batch_id` is derived from the buffered rows
  (timestamp range + count). The buffer is persisted on disk, so after a plugin
  restart the same rows produce the same id — a resend overwrites the same object
  server-side instead of duplicating track points.
- On HTTP 200 the sent rows are flushed from the buffer; on transient errors the
  buffer is kept and retried; an HTTP 400 (contract rejection) drops the batch so
  it can't wedge the queue.

## Develop

```bash
npm install          # no runtime dependencies (native http/https)
npm test             # unit tests: payload builder, signing, and the http POST
```

`lib/payload.js` builds the contract payload + the durable `batch_id`; it is pure
and unit-tested so the plugin's output provably matches the ingest contract.
`lib/auth.js` mirrors the server's HMAC signing byte-for-byte. `lib/http.js` is a
tiny native-`https` JSON POST (the plugin has zero runtime dependencies).

## License

Apache-2.0. Original work © Saillogger LLC and Ilker Temir; fork modifications for
entropysaillog.
