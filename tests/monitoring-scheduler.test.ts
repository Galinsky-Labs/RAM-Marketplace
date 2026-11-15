import assert from "node:assert/strict";
import test from "node:test";
import { inProcessIntervalMinutes, startMonitoringScheduler } from "../lib/monitoring/scheduler";

test("scheduler is disabled unless monitoring and an interval are configured", () => {
  assert.equal(inProcessIntervalMinutes({}), null);
  assert.equal(inProcessIntervalMinutes({ RAM_MONITORING_INPROCESS_INTERVAL_MINUTES: "15" }), null);
  assert.equal(inProcessIntervalMinutes({ RAM_MONITORING_ENABLED: "true", RAM_MONITORING_INPROCESS_INTERVAL_MINUTES: "15" }), 15);
  assert.throws(() => inProcessIntervalMinutes({ RAM_MONITORING_ENABLED: "true", RAM_MONITORING_INPROCESS_INTERVAL_MINUTES: "1" }), /5 to 1440/);
  assert.throws(() => inProcessIntervalMinutes({ RAM_MONITORING_ENABLED: "true", RAM_MONITORING_INPROCESS_INTERVAL_MINUTES: "x" }), /integer/);
  assert.equal(startMonitoringScheduler(async () => undefined, null), null);
});

test("ticks never overlap and failures are logged, not thrown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logs: string[] = [];
  let calls = 0;
  let release!: () => void;
  const handle = startMonitoringScheduler(() => { calls++; return new Promise<void>((resolve) => { release = resolve; }); }, 5, (m) => logs.push(m));
  t.mock.timers.tick(5 * 60_000);
  t.mock.timers.tick(5 * 60_000);
  assert.equal(calls, 1, "second tick skipped while first run is in flight");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  handle?.stop();
  const failing = startMonitoringScheduler(async () => { throw new Error("db down"); }, 5, (m) => logs.push(m));
  t.mock.timers.tick(5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  failing?.stop();
  assert.ok(logs.some((m) => m.includes("cycle failed: db down")));
});
