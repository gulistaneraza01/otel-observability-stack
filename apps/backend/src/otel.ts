import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type {
  Response as ExpressResponse,
  NextFunction,
  Request,
} from "express";

const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
const SDK_ENABLED = process.env.OTEL_SDK_ENABLED === "true";

/* If OTEL_SDK_ENABLED != "true" every helper is a no-op, so the app still
 * runs correctly before `docker compose up` starts the collector. */
let sdk: NodeSDK | null = null;

export function startOpenTelemetry(): NodeSDK | null {
  if (!SDK_ENABLED || sdk) return sdk;

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${OTLP_ENDPOINT}/v1/traces`,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${OTLP_ENDPOINT}/v1/metrics`,
        }),
        exportIntervalMillis: 10_000,
      }),
    ],
    /*
     * Manual server/client spans below cover http+databases (deterministic
     * under Bun); auto-instrumentation stays on top for anything else.
     */
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": { enabled: false },
        "@opentelemetry/instrumentation-express": { enabled: false },
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();
  return sdk;
}

const tracer = trace.getTracer("backend");

/* Server span per request. traceparent/tracestate/baggage headers are
 * extracted as remote parent context so distributed traces chain (multi-hop),
 * and the active span id is injected into every pino log line and into the
 * response `traceparent` header so callers can see the trace id. */
export const otelRequestSpan = (
  req: Request,
  res: ExpressResponse,
  next: NextFunction,
) => {
  const parent = propagation.extract(
    context.active(),
    req.headers as Record<string, string>,
  );
  const span = tracer.startSpan(
    `${req.method} ${req.baseUrl || req.path}`,
    { kind: SpanKind.SERVER },
    parent,
  );
  const ctx = trace.setSpan(parent, span);

  span.setAttributes({
    "http.request.method": req.method,
    "url.full": req.originalUrl,
  });

  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (carrier.traceparent) res.setHeader("traceparent", carrier.traceparent);

  res.on("finish", () => {
    span.setAttribute("http.response.status_code", res.statusCode);
    span.end();
  });

  context.with(ctx, () => next());
};

/* Outbound (client) span for fetch calls, with W3C traceparent injection. */
export async function tracedFetch(
  url: string,
  init: RequestInit & { passthroughHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const attrs: Record<string, unknown> = {
    "http.request.method": "GET",
    "url.full": url,
    "server.address": new URL(url).host,
  };

  const span = tracer.startSpan("fetch", {
    kind: SpanKind.CLIENT,
    attributes: attrs,
  });
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const [key, value] of Object.entries(init.passthroughHeaders ?? {})) {
    carrier[key] = value;
  }
  const headers = { ...(init.headers ?? {}), ...carrier };

  try {
    const response = await fetch(url, { ...init, headers });
    span.setAttribute("http.response.status_code", response.status);
    return response;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/* Client span wrapper for DB operations. */
export async function withDbSpan<T>(
  name: string,
  query: string,
  fn: () => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text": query,
      "server.address": process.env.DATABASE_URL?.length ? "neon" : "unknown",
    },
  });
  const start = Date.now();
  try {
    const result = await context.with(
      trace.setSpan(context.active(), span),
      fn,
    );
    span.setAttribute("db.client.operation.duration_ms", Date.now() - start);
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
