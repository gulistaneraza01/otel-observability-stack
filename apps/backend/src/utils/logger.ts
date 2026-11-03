import pino from "pino";

const serviceName = process.env.SERVICE_NAME ?? "backend";
const env = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";

const targets: pino.TransportTargetOptions<Record<string, unknown>>[] = [];

if (env !== "production") {
  targets.push({
    target: "pino-pretty",
    level: logLevel,
    options: { colorize: true, ignore: "pid,hostname" },
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
  },
  pino.transport({ targets }),
);
