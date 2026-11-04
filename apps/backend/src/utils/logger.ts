import pino from "pino";
import { context, trace } from "@opentelemetry/api";

const serviceName = process.env.SERVICE_NAME ?? "backend";
const env = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";

const INVALID_TRACE_ID = "00000000000000000000000000000000";

/* Adds trace_id / span_id from the active OTel span to every log record.
 * Loki stores them as structured metadata -> enables trace-to-log queries. */
function traceContextMixin() {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  if (!spanContext || spanContext.traceId === INVALID_TRACE_ID) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

const targets: pino.TransportTargetOptions<Record<string, unknown>>[] = [];

if (env !== "production") {
  targets.push({
    target: "pino-pretty",
    level: logLevel,
    options: { colorize: true, ignore: "pid,hostname" },
  });
} else {
  /* newline-delimited JSON on stdout - the classic prod pattern, usable by any
     log shipper; the OTLP target below still carries the same records. */
  targets.push({
    target: "pino/file",
    level: logLevel,
    options: { destination: 1 },
  });
}

targets.push({
  target: "pino-opentelemetry-transport",
  level: logLevel,
  options: {
    loggerName: serviceName,
    resourceAttributes: {
      "service.name": serviceName,
      "deployment.environment.name": env,
    },
  },
});

export const logger = pino(
  {
    level: logLevel,
    base: { service: serviceName, env },
    mixin: traceContextMixin,
  },
  pino.transport({ targets }),
);
