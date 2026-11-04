# How the Observability Flow Works — End to End

This document explains, step by step, how every signal (traces, metrics, logs)
leaves the backend and ends up queryable in Grafana, backed by S3 object
storage. Read it top to bottom once and you should be able to trace any
datapoint back to the source file that produced it.

---

## 1. The big picture

```
                        ┌─────────────────────── apps/backend (Bun + Express) ───────────────────────┐
                        │                                                                            │
   HTTP request ───────▶│  otelRequestSpan()          tracedFetch() / withDbSpan()                  │
                        │  creates SERVER span        creates child CLIENT/DB spans                 │
                        │        │                           │                                     │
                        │        ▼                           ▼                                     │
                        │  ┌─────────────────────── spans in memory ───────────────────────┐        │
                        │  │  every log line carries trace_id/span_id (pino mixin)         │        │
                        │  └───────────────────────────────────────────────────────────────┘        │
                        │        │ OTLP (http/protobuf, every 5s batch)                             │
                        │        ▼                                                                  │
                        └────────────────────────────────────────────────────────────────────────────┘
                                 │ 3 wires: port 4318 (http) + 4317 (grpc)
                                 ▼
                   ┌────────── otel-collector (docker/otel-collector/collector.yml) ──────────┐
                   │                                                                          │
                   │  receivers: otlp            ← all 3 signals arrive here                  │
                   │       │                                                                     │
                   │       ├── traces ──▶ exporters: otlp/tempo   → Tempo        (port 4317)    │
                   │       │              exporters: spanmetrics → derives RED metrics          │
                   │       │                                                                     │
                   │       ├── metrics ──▶ exporters: prometheus   exposes :8889  (scraped)     │
                   │       │                                                                     │
                   │       └── logs    ──▶ exporters: otlphttp/loki → Loki       (port 3100)    │
                   └───────────────────────────────────────────────────────────────────────────┘
                                 │                                    │
               ┌─────────────────┴───────────┐              ┌─────────┴───────────────────────────┐
               ▼                             ▼              ▼                                     ▼
        Prometheus :9090                Tempo :3200     Loki :3100                        Thanos (sidecar)
        scrapes :8889                   traces          logs                              uploads finished
               │                             │              │                              2h metric blocks
               ▼                             ▼              ▼                              to S3 : metrics/
        Thanos sidecar              S3: traces/            S3: logs/                              │
        uploads finished                    │              │                                      ▼
        blocks → S3: metrics/              └──────┬───────┴─────── Thanos query :9092 ── store gateway
                                                   │                                      │
                                                   └──────────────▶ Grafana :3001 ◀───────┘
```

One collector, three pipelines. All three exporters/configs live in a single
file: `docker/otel-collector/collector.yml`.

---

## 2. Traces — from middleware to Tempo

### Who creates spans

| Span | Created by | File |
|---|---|---|
| `SERVER` span per request (`GET /api/v1/test/latency`) | `otelRequestSpan()` middleware | `apps/backend/src/otel.ts` |
| Child spans for self-fetch (`multi-hop`) | `tracedFetch()` | `apps/backend/src/otel.ts` |
| Child `DB` span for Neon Postgres | `withDbSpan()` | `apps/backend/src/otel.ts` |

HTTP/Express auto-instrumentation is intentionally **disabled** for
determinism under Bun. All spans are manual.

### Step by step

1. **Span registration.** On boot, `src/index.ts` calls `startOpenTelemetry()`
   which builds a `NodeSDK` with an OTLP **HTTP** exporter pointing at
   `OTEL_EXPORTER_OTLP_ENDPOINT` (`http://localhost:4318`). SDK activity is
   gated behind `OTEL_SDK_ENABLED` so the app still runs bare if the collector
   is down.

2. **Every request enters `otelRequestSpan`.** The middleware:
   - **extracts** an incoming `traceparent` header (W3C context) — this is what
     makes `multi-hop` chains share one trace across self-calls;
   - starts a `SERVER` span named `GET <path>`;
   - **injects** the context back out, so child HTTP calls inherit it, and
     returns the response header `traceparent: 00-<trace_id>-<span_id>-01`.

3. **Nested spans.** `tracedFetch` and `withDbSpan` start child spans on the
   currently active context. In a `multi-hop?depth=2` request you get one trace
   with three `SERVER` spans (depth 2 → 1 → 0).

4. **Batching.** Spans sit in a `BatchSpanProcessor` and are flushed roughly
   every **5 seconds**. This is why a trace is not instantly visible in Tempo
   (~10–15 s in practice). If the process is killed before the flush, its spans
   are lost — that is normal for in-memory batching.

5. **Collector hop.** The OTLP payload hits the collector on port 4318
   (`receivers.otlp.protocols.http`), a `batch` processor groups it, and the
   `traces` pipeline exports it twice:
   - `otlp/tempo` → Tempo's gRPC endpoint `tempo:4317` (in-container DNS),
   - the `spanmetrics` **connector** (see §3).

6. **Tempo stores it.** Tempo ingests the trace into a WAL, builds blocks and
   periodically flushes them as objects into the bucket
   `S3_BUCKET_TRACES` (`traces/` in the Neon S3-compatible storage).
   Verification used earlier: `curl http://localhost:3200/api/traces/<trace_id>`
   returned `200` ~15 s after the request fired.

### The `trace_id` you see everywhere

`src/utils/logger.ts` adds a pino `mixin` that reads the *currently active*
span via `@opentelemetry/api`:

```ts
trace_id: spanContext.traceId,
span_id:  spanContext.spanId,
```

Because the server span is active for the whole request, **every log line
emitted inside a handler automatically carries the trace correlation** —
that is the glue between logs and traces.

---

## 3. Metrics — two sources, one endpoint

### Source A: runtime metrics from the SDK

The OTel SDK has a `PeriodicExportingMetricReader` exporting every
**10 s**. These are the built-in runtime instruments:
`process_resident_memory_bytes`, `process_cpu_seconds_total`,
`nodejs_eventloop_*`, `process_open_fds`, … They need no code — just the SDK
being started.

*(Note: HTTP request metrics are NOT in this set, because HTTP
auto-instrumentation is disabled — that's not an accident, see Source B.)*

### Source B: spanmetrics connector (traces → metrics)

This is the "modern OTel" trick, and the reason the dashboard charts work:

```yaml
connectors:
  spanmetrics:
    histogram:
      explicit:
        buckets: [10ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s]
```

Every span passing through the `traces` pipeline additionally becomes:

| Metric | Meaning |
|---|---|
| `traces_span_metrics_calls_total` | request counter, labelled by `span_name`, `span_kind`, `service_name`, `http_request_method` |
| `traces_span_metrics_duration_milliseconds_*` | latency histogram (`_bucket/_sum/_count`) for `histogram_quantile()` |

HTTP spans have `status_code` span attribute set by middleware (`STATUS_CODE_UNSET`
on 2xx/3xx, `STATUS_CODE_ERROR` on 4xx/5xx), which is what the "error rate %"
panel divides on. Route/latency changes in the backend need no disk metric
plumbing — spans are the metric source. This also means **no duplicated
HTTP auto-instrumentation** under Bun.

### Distribution path

```
SDK (10s) ── OTLP ──▶ collector :8889 ── 15s scrape ──▶ Prometheus :9090
Spanmetrics (per flush) ──┘
```

Prometheus internal flags force **2h min/max block duration**, because that is
the granularity Thanos sidecar can export (sidecar uploads *completed* blocks
only — so `S3 metrics/` is empty for the first ~2 h, this is by design; the
head block stays in Prometheus until then).

Thanos components (`docker/compose.yml`):
- **sidecar** — reads Prom's TSDB, uploads finished 2h blocks to `s3://metrics`, serves 1h lookups to query
- **query** — federated query frontend on `:9092`, `--endpoint=thanos-sidecar:10901` + `--endpoint=thanos-store:10901`
- **store** — reads all historical blocks from S3
- **compactor** — continuously compacts/downsamples blocks (kept with
  `--wait`, else it runs once and exits by design; sees `signature_version`
  removed since the Neon endpoint 404s on it)

Grafana's "Thanos" datasource points at `thanos-query:9092`; every series
carries the injected `external_labels {cluster="otel-lab", replica="prom0"}`.

---

## 4. Logs — pino, OTLP, JSON stdout

Three simultaneous log sinks, configured in `apps/backend/src/utils/logger.ts`:

| Mode | What happens |
|---|---|
| dev | `pino-pretty` prints colored JSON-ish lines to stdout |
| production | raw **newline-delimited JSON** printed to stdout (`pino/file` target) → any shipper can ingest it |
| always | `pino-opentelemetry-transport` ships each record as an **OTLP `LogRecord`** to the collector |

The pipeline for the OTLP branch:

```
pino record ──▶ worker thread (transport) ──▶ OTLP endpoint :4318 ──▶ collector
    ── (logs pipeline) ──▶ otlphttp/loki http://loki:3100/otlp ──▶ Loki
    ── ingester WAL ──▶ tsdb index + chunks ──▶ S3 shipper ──▶ s3://logs
```

### Why the Grafana panel doesn't "show JSON"

The Loki view is structured — the *body* of each record is only the `msg`
text, while every other field (`event`, `depth`, `requestedSlowMs`, `trace_id`
…) is stored as **structured metadata** + **labels**. Click any log line's
chevron → "Details" → you'll see every JSON field. To query with them:

```
{service_name="backend", deployment_environment_name="production"} != "background work" | level >= 40
```

Filter examples: `| level >= 40` (warn/error), `| trace_id != nil`,
`!= "background work"` (drops the 10s background-worker heartbeat noise).

Earlier debugging: the first Loki config used the embedded
`s3://user:pass@endpoint/bucket` URL form, which made Loki default to
**http on port 80** and get connection-refused on the Neon endpoint. Switched
to flat `storage_config.aws` keys with `endpoint: https://…`, and
`s3forcepathstyle: true / insecure: false`. The index/chunks shipper then
lands objects in `s3://logs`.

---

## 5. Cross-signal linking — the payoff

Every link was configured in `docker/grafana/provisioning/datasources/datasources.yml`:

| From | You click | You land on | Config provided by |
|---|---|---|---|
| **Metric point** (RED panels) | hover a series | (exemplars currently disabled in spanmetrics) | `exemplarTraceIdDestinations` to Tempo |
| **Log line** | the `trace_id` link chip | Tempo trace waterfall | `derivedFields` with `matcherRegex: 'trace_id":"([0-9a-f]{32})'` |
| **Span in Tempo** | "Logs for this span" | Loki filtered to that exact trace | `tracesToLogsV2 { filterByTraceID: true, datasourceUid: loki }` |
| **Tempo service map** | node graph | RED correlation | `serviceMap { datasourceUid: thanos }` |

Note the derived-field regex expects the pino JSON body — since pino ships
`{"trace_id":"abc…"}` text. **Empty line-filter in a Loki query
(`|= `` `) is harmless**: an empty string matches everything; remove it to
write real filters.

---

## 6. Ports & services cheat sheet

| Container | Port(s) published on host | Role |
|---|---|---|
| backend (bare `bun run src/index.ts`) | 8000 | the instrumented app |
| `otel-collector` | 4317 (grpc) + 4318 (http) | OTLP ingest |
| `otel-collector` *internal* :8889 | *not published* | Prometheus exporter that Prom scrapes |
| `prometheus` | 9090 | TSDB + head blocks |
| `thanos-sidecar` | (internal 10901) | block uploader + search |
| `thanos-query` | 9092 | federated PromQL UI |
| `thanos-store` | (internal 10902) | serve S3 blocks |
| `thanos-compactor` | (internal 10903) | continuous compaction (`--wait`) |
| `loki` | 3100 | log store (+ `/otlp` log ingest) |
| `tempo` | 3200 | trace query API (+ 4317 ingest) |
| `grafana` | 3001 | UI (anonymous Admin) |

---

## 7. Reproduce the whole flow in one minute

```sh
# 1. stack up (from repo root, Makefile shortcuts exist)
cd apps/backend && bun run ../../docker/render.ts  # renders secrets into docker/rendered/
cd ../../docker && docker compose up -d && cd ..

# 2. production-mode backend
cd apps/backend && PORT=8000 OTEL_SDK_ENABLED=true bun run src/index.ts &

# 3. traffic mix
./scripts/loadgen.sh 250     # latency + slow + random-error + multi-hop + db

# 4. verify each hop
curl -s localhost:9092/api/v1/query?query=up                        # Thanos query sees prom targets
curl -s localhost:9090/api/v1/query?query=traces_span_metrics_calls_total
curl -s "localhost:3100/loki/api/v1/query_range?limit=1&query={service_name=\"backend\"}"
curl -s localhost:3200/api/traces/<trace-id>                          # id comes from the /test/multi-hop response header
aws s3 ls s3://traces/ && aws s3 ls s3://logs/ && aws s3 ls s3://metrics/   # metrics/ empty < 2h is expected
```

Grafana — dashboards: **"OTel Lab — RED backend (spanmetrics)"** and
**"OTel Learning"**. Explore → Loki / Tempo for ad-hoc trace↔log chasing.

---

## 8. Where each secret/env matters

| Env var (from `apps/backend/.env`) | Used by |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `NodeSDK` spans/metrics/logs heartbeat URL (must be IP of container running the collector — `localhost` matches host mode) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`, matched by `receivers.otlp.protocols.http` |
| `OTEL_SERVICE_NAME` | `service.name`, Loki `service_name` label, spanmetrics `service_name` label |
| `OTEL_SDK_ENABLED` | hard on/off switch, independent of everything else |
| `PORT` | backend listener |
| `NODE_ENV` | log transport choice + error detail suppression; **Bun reads `.env` unless env var set explicitly** (`NODE_ENV=production bun run …` wins) |
| `AWS_*`, `S3_BUCKET_*`, `AWS_ENDPOINT_URL_S3` | only used by containers — rendered via `docker/render.ts` into `docker/rendered/*.yml` (git-ignored) |

## 9. Common confusions (all hit during this build)

1. **"Metric looked missing" → the pipeline is fine** — spanmetrics rides on
   traces, so a restart wipes its history. Wait 10 s + refresh.
2. **thanos-compactor exiting after "cleaner done" isn't a bug** — it's
   one-shot by default and needs `--wait` for watch-mode.
3. **`metrics/` bucket stays empty for first ~2 h** — sidecar uploads only
   *completed* 2h blocks; the head block lives in Prometheus until then.
4. **An empty Loki line filter (`|= `` `) matches everything** — it's a
   no-op; delete it and type the match you actually want.
5. **Local bare run at first** — `NODE_ENV` from `.env` is `development`,
   so you'll see `pino-pretty`; flip to production (shell variable wins) for
   the JSON-stdout sink.
