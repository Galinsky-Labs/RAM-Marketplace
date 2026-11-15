// Next.js instrumentation hook: runs once per server process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { inProcessIntervalMinutes, startMonitoringScheduler } = await import("./lib/monitoring/scheduler");
  let minutes: number | null = null;
  try {
    minutes = inProcessIntervalMinutes();
  } catch (error) {
    console.error("[monitoring] " + (error instanceof Error ? error.message : "invalid scheduler configuration"));
    return;
  }
  if (!minutes) return;
  const flag = globalThis as unknown as { __ramMonitoringScheduler?: boolean };
  if (flag.__ramMonitoringScheduler) return;
  flag.__ramMonitoringScheduler = true;
  startMonitoringScheduler(async () => {
    const { runMonitoringCycle } = await import("./lib/server/monitoring");
    return runMonitoringCycle("SCHEDULED_IN_PROCESS");
  }, minutes);
}
