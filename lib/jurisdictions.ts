import { speciesActivatable, normalizeSpecies } from "./species";

/**
 * Multi-state activation. A state is opened for a species only by a two-person
 * decision (proposer != approver) with an evidence reference, and can be
 * suspended immediately by any RAM compliance reviewer. With corridor
 * enforcement on, both endpoints of a corridor must be ACTIVE for the species
 * in addition to a published permitting rule.
 */
export type ActivationStatus = "PROPOSED" | "ACTIVE" | "SUSPENDED";

export interface JurisdictionActivationRecord {
  stateCode: string;
  species: string;
  status: ActivationStatus;
}

const stateCode = /^[A-Z]{2}$/;

export function normalizeActivationInput(input: { stateCode?: unknown; species?: unknown; evidenceReference?: unknown }) {
  const code = typeof input.stateCode === "string" ? input.stateCode.trim().toUpperCase() : "";
  if (!stateCode.test(code)) throw new Error("State code must be two letters");
  const species = typeof input.species === "string" ? normalizeSpecies(input.species) : "";
  if (!species) throw new Error("Species is required");
  if (!speciesActivatable(species)) {
    throw new Error(`Species ${species} is not activatable (unknown or groundwork-only)`);
  }
  const evidence = typeof input.evidenceReference === "string" ? input.evidenceReference.trim() : "";
  if (evidence.length < 8 || evidence.length > 2000) {
    throw new Error("An evidence reference of 8 to 2000 characters is required");
  }
  return { stateCode: code, species, evidenceReference: evidence };
}

export function assertActivationApproval(record: { status: ActivationStatus; proposedById: string }, approverId: string) {
  if (record.status !== "PROPOSED") throw new Error("Only a proposed activation can be approved");
  if (record.proposedById === approverId) {
    throw new Error("Forbidden: the proposer cannot approve their own activation");
  }
}

/** Both corridor endpoints must be ACTIVE for the species. */
export function corridorJurisdictionsActive(
  activations: readonly JurisdictionActivationRecord[],
  originState: string,
  destinationState: string,
  species: string
): { active: true } | { active: false; reason: string } {
  const canonical = normalizeSpecies(species).toLowerCase();
  const isActive = (code: string) => activations.some((record) =>
    record.stateCode === code.toUpperCase() && record.species.toLowerCase() === canonical && record.status === "ACTIVE");
  for (const code of new Set([originState.toUpperCase(), destinationState.toUpperCase()])) {
    if (!isActive(code)) return { active: false, reason: `Jurisdiction ${code} is not activated for ${normalizeSpecies(species)}` };
  }
  return { active: true };
}
