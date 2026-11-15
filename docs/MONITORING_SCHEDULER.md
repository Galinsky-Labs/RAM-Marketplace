# Monitoring scheduler

The monitoring cycle (stale payments, disputes, pickups, pending verifications; incident dedupe; signed alerts) runs in two ways:

1. **In-process interval (free)** — set `RAM_MONITORING_ENABLED=true` and `RAM_MONITORING_INPROCESS_INTERVAL_MINUTES` (5–1440). `instrumentation.ts` starts one non-overlapping interval per server process. On Render's free plan the instance sleeps after ~15 minutes without traffic, so this is best-effort: cycles run only while the service is awake.
2. **Render cron job (durable, paid — not created)** — a cron service calling the bearer-protected endpoint:
   ```yaml
   # render.yaml (add only after approving a paid cron job)
   - type: cron
     name: ram-marketplace-monitoring
     runtime: node
     plan: starter
     region: ohio
     schedule: "*/10 * * * *"
     buildCommand: "true"
     startCommand: >-
       curl -fsS -X POST -H "Authorization: Bearer $RAM_MONITORING_RUN_TOKEN"
       https://ram-marketplace.onrender.com/api/monitoring/run
     envVars:
       - key: RAM_MONITORING_RUN_TOKEN
         sync: false
   ```
   The web service needs `RAM_MONITORING_RUN_TOKEN` (strong, distinct). Any external scheduler (GitHub Actions schedule, UptimeRobot-style POST) can call the same endpoint.

Alerts are delivered only when `RAM_MONITORING_ALERT_WEBHOOK_URL` + `RAM_MONITORING_ALERT_WEBHOOK_SECRET` are set; otherwise failed deliveries are recorded and visible at `/ops/monitoring`.
