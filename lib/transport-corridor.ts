import type { CorridorDecision } from "./compliance-rules";

export interface CorridorGateInput {
  enforced: boolean;
  originState?: string | null;
  destinationState?: string | null;
  decision: CorridorDecision | null;
}

export interface CorridorGateRecord {
  originState: string | null;
  destinationState: string | null;
  corridorDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  corridorEnforced: boolean;
  corridorRuleId: string | null;
  corridorRuleRevision: number | null;
  corridorRuleDigest: string | null;
}

export const stateCodePattern = /^[A-Z]{2}$/;

export function corridorEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return env.RAM_CORRIDOR_RULES_ENFORCED === "true";
}

/**
 * Transport assignment gate. When enforcement is on, a transport can only be
 * assigned with explicit origin/destination state codes and an ALLOW decision
 * from a published rule. When off (demo/prototype), the decision is still
 * recorded on the assignment for audit, but it does not block.
 */
export function applyCorridorGate(input: CorridorGateInput): CorridorGateRecord {
  const origin = input.originState?.trim().toUpperCase() || null;
  const destination = input.destinationState?.trim().toUpperCase() || null;
  if ((origin && !stateCodePattern.test(origin)) || (destination && !stateCodePattern.test(destination))) {
    throw new Error("Origin and destination must be two-letter state codes");
  }
  if (input.enforced) {
    if (!origin || !destination) {
      throw new Error("Corridor enforcement requires origin and destination state codes");
    }
    if (!input.decision || input.decision.decision !== "ALLOW") {
      const reason = input.decision?.decision === "DENY" ? input.decision.reason : "No corridor decision";
      throw new Error("Corridor denied: " + reason);
    }
  }
  const decision = input.decision;
  return {
    originState: origin,
    destinationState: destination,
    corridorDecision: decision ? decision.decision : "NOT_EVALUATED",
    corridorEnforced: input.enforced,
    corridorRuleId: decision?.ruleId ?? null,
    corridorRuleRevision: decision?.revision ?? null,
    corridorRuleDigest: decision?.digest ?? null
  };
}
