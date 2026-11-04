import express from "express";
import helmet from "helmet";
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middleware/error.middleware";
import { otelRequestSpan, startOpenTelemetry } from "./otel";
import apiRoutes from "./routes/api.routes";
import { startBackgroundWorker } from "./utils/backgroundWorker";
import { logger } from "./utils/logger";

startOpenTelemetry();

const app = express();

const port = process.env.PORT || 3000;

app.use(otelRequestSpan);
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1", apiRoutes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

startBackgroundWorker();

app.listen(port, () => {
  logger.info(`server listening on port ${port}`);
});
