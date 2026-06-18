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
npm install          # request (only runtime dep)
npm test             # pure unit tests for the payload builder + signing
```

`lib/payload.js` builds the contract payload + the durable `batch_id`; it is pure
and unit-tested so the plugin's output provably matches the ingest contract.
`lib/auth.js` mirrors the server's HMAC signing byte-for-byte.

## License

Apache-2.0. Original work © Saillogger LLC and Ilker Temir; fork modifications for
entropysaillog.
