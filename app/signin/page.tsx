import { demoAuthEnabled } from "@/lib/auth/session";
import { identityBoundaryConfig } from "@/lib/auth/identity-config";
import { oidcConfig } from "@/lib/auth/oidc";

function ssoEnabled() {
  try {
    return Boolean(oidcConfig());
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

const demos = [
  { id: "farmer", label: "Demo farm owner", note: "Submit and manage anonymous animal cases" },
  { id: "scientist", label: "Demo researcher", note: "Browse models, create research needs and reserve matched animals" },
  { id: "procurement", label: "Demo research procurement", note: "Approve buyer quotes and commit the research organization" },
  { id: "receiver", label: "Demo research receiving", note: "Inspect delivered animals and accept or reject institutional intake" },
  { id: "veterinarian", label: "Demo veterinarian", note: "Review and characterize candidate animals" },
  { id: "ram", label: "Demo RAM operations", note: "Operate internal queues and restricted workflows" },
  { id: "finance", label: "Demo RAM finance", note: "Set independent supplier policies and commit acquisitions" },
  { id: "compliance", label: "Demo RAM compliance", note: "Review restricted source data and clear orders for pickup" },
  { id: "transporter", label: "Demo transport provider", note: "Receive assigned transport packets and record chain-of-custody events" }
];

export default function SignInPage() {
  const demoEnabled = demoAuthEnabled();
  const identity = identityBoundaryConfig();
  const sso = ssoEnabled();

  return (
    <section className="page narrow">
      <div className="pageHeader">
        <div>
          <div className="eyebrow">RAM access</div>
          <h1>Sign in to your workspace</h1>
          <p>
            Production access uses a verified external identity assertion. RAM
            then revalidates membership and organization status on every protected
            request.
          </p>
        </div>
      </div>

      <div className="detailGrid">
        <article className="panel">
          <h2>Verified sign in</h2>
          <p>
            Use the configured identity provider for both existing accounts and
            new organization onboarding.
          </p>
          {sso ? (
            <a className="primaryButton" href="/api/session/oidc/start">
              Sign in with organization SSO
            </a>
          ) : identity.loginUrl ? (
            <a className="primaryButton" href={identity.loginUrl}>
              Continue with verified identity
            </a>
          ) : (
            <span className="subtle">
              No production identity login URL is configured on this deployment.
            </span>
          )}
        </article>

        <article className="panel">
          <h2>New organization</h2>
          <p>
            After identity verification, RAM collects organization details and
            creates a pending workspace. Operational access starts only after RAM
            verifies the organization.
          </p>
          {sso ? (
            <a className="secondaryButton" href="/api/session/oidc/start?next=/onboarding">
              Verify identity & start onboarding
            </a>
          ) : identity.loginUrl ? (
            <a className="secondaryButton" href={identity.loginUrl}>
              Verify identity & start onboarding
            </a>
          ) : (
            <a className="secondaryButton" href="/onboarding">
              View onboarding requirements
            </a>
          )}
        </article>
      </div>

      {demoEnabled && (
        <div className="panel">
          <h2>Demo identities</h2>
          <p>
            Public pilot demo: pick a role to explore with synthetic data. Demo
            sessions cannot move real animals or money.
          </p>
          <div className="demoGrid">
            {demos.map((demo) => (
              <form action="/api/session/demo" method="post" key={demo.id} className="demoCard">
                <input type="hidden" name="actor" value={demo.id} />
                <strong>{demo.label}</strong>
                <span>{demo.note}</span>
                <button className="secondaryButton" type="submit">
                  Enter workspace
                </button>
              </form>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
