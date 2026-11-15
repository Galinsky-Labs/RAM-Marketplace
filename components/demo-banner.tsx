import { demoAuthEnabled } from "@/lib/auth/session";

/** Site-wide notice shown whenever demo sign-in is enabled on a deployment. */
export function DemoBanner() {
  if (!demoAuthEnabled()) return null;
  return (
    <div className="demoBanner" role="status">
      <strong>Demo — no real transactions.</strong>{" "}
      <span>This is a public pilot demonstration with synthetic data. No animals are moved and no payments are made.</span>
    </div>
  );
}
