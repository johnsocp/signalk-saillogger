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
- **Course source** *(optional)* — which Signal K course path family to read for
  the active route: `navigation.courseGreatCircle` (the default) or
  `navigation.courseRhumbline`.
- **Course source device** *(optional)* — restrict the course paths to one
  `$source`. Left blank, the plugin locks onto the first source that reports a
  destination after start, so a second device publishing the same family cannot
  overwrite or delete the active route.

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
`observed_at`) built from one course path family's
`nextPoint.{position,distance,timeToGo,href}`. Which family is set by the
**Course source** option — `navigation.courseGreatCircle` (the default, what the
Signal K course API and most N2K plotters publish) or
`navigation.courseRhumbline` (for NMEA 0183 RMB-only setups). Only the chosen
family is subscribed and read; deltas on the other one are ignored. Tracking a
single family is what makes a route clear reliable: the deleted route's own path
goes `null`, so nothing can re-publish it, and any later non-null position is a
genuine (re)activation. The name is resolved best-effort from the
`href` via the Signal K resources API; if it doesn't resolve, the field is
simply absent. The name is sanitized before it is sent — control characters and
unpaired surrogates stripped, trimmed, and truncated to 80 code points (never
mid-character) — and omitted when nothing usable is left. Snapshots older than 5
minutes are not sent; any `nextPoint` update (position, distance, time to go, or
href) keeps the snapshot fresh, so a fixed mark doesn't age out mid-leg;
`distance_m` and `time_to_go_s` age out on their own clock, so a countdown whose
source has stopped is omitted rather than sent stale. Freshness is measured from
the delta's own source timestamp, not from arrival, so a disconnected plotter's
last route ages out instead of being kept alive by Signal K's periodic
re-emission of the unchanged value.

The three states are distinct on the wire: the key **absent** means "no news,
leave the stored course alone", an explicit **`null`** (sent once, when the
route is cleared on the plotter) tells the server to delete it, and an
**object** upserts it. A pending clear is persisted (`entropysaillog_course.json`
in the plugin's data directory) and resent until the server accepts the batch
that carried it, so a restart mid-clear does not lose the delete.

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
