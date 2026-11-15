# Public pilot demo deployment

- **Render** web service `ram-marketplace` (free plan, Ohio, Node 22), auto-deploys `main`: https://ram-marketplace.onrender.com
  - Build: `npm install --include=dev && npm run db:migrate:deploy && npm run db:seed:demo && npm run build`; start: `npm start`; health check `/api/health/ready` (database round-trip).
  - Free instances sleep when idle; the first request after idle takes ~30-60 s.
- **Neon** project `ram-marketplace` (PostgreSQL 17, aws-us-east-2, free plan). `DATABASE_URL` uses the pooled host (runtime); `DIRECT_DATABASE_URL` uses the direct host (migrations).
- Mode: **public pilot demo**. `RAM_DEMO_AUTH_ENABLED=true` with a site-wide "Demo — no real transactions" banner; synthetic demo identities seeded idempotently; no payment rail configured (no money can move); corridor enforcement off; in-process monitoring every 30 min while awake.
- Configuration reference: `render.yaml` and `.env.example`. Optional integrations: docs/IDENTITY_OIDC.md, docs/PAYMENTS_STRIPE.md, docs/PILOT_INTEGRATIONS.md, docs/MONITORING_SCHEDULER.md.

Turning the demo into a real pilot requires the Phase 0 decisions (docs/PHASE0_DECISION_REGISTER.md), disabling demo auth, configuring OIDC and a payment rail, enforcing corridors, and passing `/ops/pilot` readiness — see registry/prs.json `externalPrerequisites`.
