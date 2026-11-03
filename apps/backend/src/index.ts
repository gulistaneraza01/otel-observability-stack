import express from "express";
import helmet from "helmet";
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middleware/error.middleware";
import apiRoutes from "./routes/api.routes";
import { logger } from "./utils/logger";
import { startBackgroundWorker } from "./utils/backgroundWorker";

const app = express();

const port = process.env.PORT || 3000;

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
