/**
 * In-process monitoring scheduler. Runs the same monitoring cycle as the
 * bearer-protected POST /api/monitoring/run, on an interval, while the web
 * instance is awake. On Render's free plan the instance sleeps when idle, so
 * this is best-effort; a Render cron job (paid) calling /api/monitoring/run is
 * the durable option (see docs/MONITORING_SCHEDULER.md).
 */
export function inProcessIntervalMinutes(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.RAM_MONITORING_INPROCESS_INTERVAL_MINUTES?.trim();
  if (!raw || env.RAM_MONITORING_ENABLED !== "true") return null;
  if (!/^\d{1,4}$/.test(raw)) throw new Error("RAM_MONITORING_INPROCESS_INTERVAL_MINUTES must be an integer");
  const minutes = Number(raw);
  if (minutes < 5 || minutes > 1440) throw new Error("RAM_MONITORING_INPROCESS_INTERVAL_MINUTES must be 5 to 1440");
  return minutes;
}

export interface SchedulerHandle {
  stop(): void;
}

/** Start a non-overlapping interval; returns null when disabled. */
export function startMonitoringScheduler(
  run: () => Promise<unknown>,
  minutes: number | null,
  log: (message: string) => void = (message) => console.log(message)
): SchedulerHandle | null {
  if (!minutes) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
      log("[monitoring] in-process cycle completed");
    } catch (error) {
      log("[monitoring] in-process cycle failed: " + (error instanceof Error ? error.message : "unknown error"));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, minutes * 60_000);
  timer.unref?.();
  log(`[monitoring] in-process scheduler every ${minutes} min`);
  return { stop: () => clearInterval(timer) };
}
