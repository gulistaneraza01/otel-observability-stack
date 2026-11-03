# API Reference — Observability Test Endpoints

Base URL: `http://localhost:8000/api/v1` (set by `PORT` in `apps/backend/.env`).

Every endpoint teaches a specific observability concept. Once the OTel SDK is wired, each call produces traces, metrics, and (via the logs endpoint) OTLP logs.

```sh
BASE=http://localhost:8000/api/v1
```

## Index

| Endpoint | Simulates | Learns |
|---|---|---|
| `GET /` | simple success | request span + 200 metrics |
| `GET /test/slow` | controlled latency | p50/p95/p99 latency panels |
| `GET /test/latency` | realistic traffic shape | latency distribution + error bursts |
| `GET /test/error` | guaranteed error | error traces, status-code metrics |
| `GET /test/random-error` | coin-flip errors | realistic error-rate wobble |
| `GET /test/cpu` | event-loop blocking | runtime CPU metrics |
| `GET /test/memory` | allocation / leak | memory growth curves, leak detection |
| `GET /test/status` | process snapshot | cross-checking metrics truth |
| `GET /test/logs` | log emission | Loki severity filtering, log search |
| `GET /test/multi-hop` | service-to-service calls | distributed tracing + context propagation |
| `GET /test/db` | real Postgres query | `db.*` spans, slow-query monitoring |
| `GET /test/background` | request-less work | logs emitted outside HTTP context |

---

## `GET /`

Simple success path.

```sh
curl -s "$BASE/"
# {"message":"Hello World","status":"success"}
```

## `GET /test/slow`

Responds after `ms` milliseconds (default `1000`, max `10000`).

```sh
curl -s "$BASE/test/slow"                # ~1s delay (default)
curl -s "$BASE/test/slow?ms=3000"        # ~3s delay
# {"endpoint":"slow","delayedMs":3000,"status":"success"}
```

## `GET /test/latency`

Randomized traffic profile engineered for percentile dashboards:
- ~fast for most calls (0–40ms base)
- `errorRate` portion returns HTTP 503 (default `0.1`)
- `tailRate` portion adds a long-tail delay up to `maxMs` (default `0.05`, max `800ms`)

```sh
curl -s "$BASE/test/latency"
curl -s "$BASE/test/latency?errorRate=0.25&tailRate=0.1&maxMs=800"
```

Tip: run the loadgen (bottom of this doc) for a few minutes, then open a Grafana panel with `quantile_over_time(0.5|0.95|0.99, ...)` — you should see p50 ≈ 30ms, p95 ≈ 200ms, p99 ≈ 800ms.

## `GET /test/error`

Always fails with the requested status code (`400`–`503`, default `500`).

```sh
curl -s -w "\n[%{http_code}]\n" "$BASE/test/error?code=503"
curl -s -w "\n[%{http_code}]\n" "$BASE/test/error?code=404"
# {"error":"internal server error","status":"error","code":503,"stack":"..."}
```

## `GET /test/random-error`

Fails with HTTP 500 with probability `rate` (default `0.3`, range `0`–`1`).

```sh
curl -s "$BASE/test/random-error?rate=0.5"     # succeeds/fails 50/50
curl -s "$BASE/test/random-error?rate=1"       # always fails
# fail: {"error":"internal server error","status":"error","code":500}
# ok:   {"endpoint":"random-error","rate":0.5,"status":"success"}
```

## `GET /test/cpu`

Blocks the event loop for `ms` milliseconds with a CPU burn (default `100`, max `1000`). Watch CPU metrics spike and other requests queue behind it.

```sh
curl -s "$BASE/test/cpu?ms=500"
# {"endpoint":"cpu","blockedMs":500,"iterations":106000000,"status":"success"}
```

Note: async-safe, but everything else on the server stalls during the burn — that IS the point.

## `GET /test/memory`

Allocates `mb` MB (max `64`). Pass `leave=true` to leak it into a module-level array (capped at 500MB total).

```sh
curl -s "$BASE/test/memory?mb=10&leave=true"
curl -s "$BASE/test/memory?mb=10&leave=true"   # +10MB each call, RSS grows
curl -s "$BASE/test/memory?mb=5"               # transient allocation, GC reclaims
# {"endpoint":"memory","allocatedMb":10,"leakedMb":20,"leakCapMb":500,
#  "parsed":{"rssMb":99,"heapUsedMb":18}}
```

## `GET /test/status`

Snapshot of the real process state — compare against what your metrics backend reports.

```sh
curl -s "$BASE/test/status"
# {"endpoint":"status","pid":123,"uptimeSec":4,"leakedMb":20,"rssMb":99,"heapUsedMb":18}
```

## `GET /test/logs`

Emits one log record at the requested severity (`fatal|error|warn|info|debug`, default `info`).

```sh
curl -s "$BASE/test/logs?level=warn&message=quota-nearly-full"
curl -s "$BASE/test/logs?level=error&message=simulation-failure"
# {"endpoint":"logs","level":"warn","message":"quota-nearly-full","status":"success"}
```

Invalid level returns 400. Once Loki is up, filter by severity label: `{service="backend", severity=~"error|fatal"}`.

## `GET /test/multi-hop`

Calls **itself** over real HTTP `depth` levels deep (default `2`, max `5`), doing `workMs` of fake work per hop (default `10`, max `500`). Trace headers (`traceparent`, `tracestate`, `baggage`, `x-request-id`) are forwarded on every hop — this is where the distributed-trace waterfall appears once the OTel SDK is wired.

```sh
curl -s "$BASE/test/multi-hop?depth=3&workMs=20"
# {"endpoint":"multi-hop","depth":3,
#  "child":{"endpoint":"multi-hop","depth":2,"child":{"endpoint":"multi-hop",...}}}
```

Downstream failure surfaces as HTTP 502.

## `GET /test/db`

Real query to Neon Postgres (`DATABASE_URL` from `.env`, via `Bun.sql`), with optional DB-side delay via `pg_sleep` (`ms`, max `2000`). First call includes ~600ms Neon cold-connect overhead.

```sh
curl -s "$BASE/test/db"
curl -s "$BASE/test/db?ms=500"      # pg_sleep(0.5) — slow query simulation
# {"endpoint":"db","requestedSlowMs":500,"queryMs":540,"database":"neondb","status":"success"}
```

Connection failure returns HTTP 503.

## `GET /test/background`

Reports the background worker state (`BG_INTERVAL_MS` interval, tick counter). The worker logs a `background.tick` event outside any HTTP request every interval.

```sh
curl -s "$BASE/test/background"
# {"endpoint":"background","backgroundState":{"running":true,"intervalMs":10000,"ticks":4}}
# ... and in Loki: {service="backend", event="background.tick"}
```

Disable with `BG_ENABLED=false`.

---

## Other status codes

Unknown paths get a clean JSON 404:

```sh
curl -s -w "\n[%{http_code}]\n" "$BASE/nope"
# {"error":"not found: /api/v1/nope","status":"error","code":404}
```

Internal errors:
- 4xx: real error message in body (from `HttpError`)
- 5xx: generic `internal server error`, stack traces only included when `NODE_ENV != production`

---

## Continuous load

`apps/backend/scripts/loadgen.sh` keeps the dashboards fed with mixed traffic:

```sh
bun run src/index.ts &                      # terminal 1: server
./scripts/loadgen.sh 250                    # terminal 2: ~4 req/s

LOADGEN_URL=http://localhost:8000/api/v1/test ./scripts/loadgen.sh 100   # ~10 req/s
```

Mix: 60% `/latency`, 20% `/slow`, 13% `/random-error?rate=0.15`, 4% `/multi-hop`, 4% `/db`.
