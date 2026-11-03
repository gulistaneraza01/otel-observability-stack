import { Router } from "express";
import {
  getBackground,
  getCpu,
  getDb,
  getError,
  getHelloWorld,
  getLatency,
  getLogs,
  getMemory,
  getMultiHop,
  getRandomError,
  getSlow,
  getStatus,
} from "../controller/api.controller";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

router.get("/", asyncHandler(getHelloWorld));

router.get("/test/slow", asyncHandler(getSlow));
router.get("/test/latency", asyncHandler(getLatency));
router.get("/test/error", asyncHandler(getError));
router.get("/test/random-error", asyncHandler(getRandomError));
router.get("/test/cpu", asyncHandler(getCpu));
router.get("/test/memory", asyncHandler(getMemory));
router.get("/test/status", asyncHandler(getStatus));
router.get("/test/logs", asyncHandler(getLogs));
router.get("/test/multi-hop", asyncHandler(getMultiHop));
router.get("/test/db", asyncHandler(getDb));
router.get("/test/background", asyncHandler(getBackground));

export default router;
