# signalk-saillogger (entropysaillog fork)

A fork of [signalk-saillogger](https://github.com/Saillogger/signalk-saillogger)
repointed at the **entropysaillog** tracker ingest. It collects position, SOG,
and COG from Signal K, buffers them through connectivity dropouts, and pushes
batches to your own `POST /ingest` endpoint.

The saillogger.com metadata / AIS / monitoring-config push paths are removed —
this fork only feeds the live tracker.

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

- Auth: the configured API key is sent as the `x-api-key` header.
- **Durable idempotency:** `batch_id` is derived from the buffered rows
  (timestamp range + count). The buffer is persisted on disk, so after a plugin
  restart the same rows produce the same id — a resend overwrites the same object
  server-side instead of duplicating track points.
- On HTTP 200 the sent rows are flushed from the buffer; on transient errors the
  buffer is kept and retried; an HTTP 400 (contract rejection) drops the batch so
  it can't wedge the queue.

## Configure

In the Signal K plugin config:

- **Ingest URL** — your `POST /ingest` endpoint, e.g.
  `https://xxxxx.execute-api.us-west-2.amazonaws.com/ingest`
- **API key** — sent as `x-api-key`
- **GPS source** (optional) — restrict to one GPS `$source` if you have several

## Develop

```bash
npm install          # request (only runtime dep)
npm test             # pure unit tests for the payload builder (lib/payload.test.js)
```

`lib/payload.js` builds the contract payload + the durable `batch_id`; it is pure
and unit-tested so the plugin's output provably matches the ingest contract.

## License

Apache-2.0. Original work © Saillogger LLC and Ilker Temir; fork modifications for
entropysaillog.
