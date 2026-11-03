import { logger } from "./logger";

interface BackgroundState {
  running: boolean;
  intervalMs: number;
  ticks: number;
}

const state: BackgroundState = {
  running: false,
  intervalMs: Number(process.env.BG_INTERVAL_MS ?? 10_000),
  ticks: 0,
};

export const startBackgroundWorker = () => {
  if (state.running || process.env.BG_ENABLED === "false") return;
  const intervalMs = state.intervalMs;
  state.running = true;

  const timer = setInterval(() => {
    state.ticks += 1;
    logger.info(
      { event: "background.tick", tick: state.ticks },
      `background work tick ${state.ticks}`,
    );
  }, intervalMs);

  timer.unref?.();
  logger.info({ event: "background.start", intervalMs }, "background worker started");
};

export const getBackgroundState = (): BackgroundState => ({ ...state });
