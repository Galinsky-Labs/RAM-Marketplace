/**
 * Species catalog. Swine is the pilot species. Bovine is second-species
 * groundwork: its validation profile, ID code and condition families exist so
 * data can be modeled and tested, but it cannot be jurisdiction-activated
 * (and therefore cannot move) until its status is promoted to PILOT through a
 * reviewed code change backed by veterinary/regulatory decisions.
 */
export type SpeciesStatus = "PILOT" | "GROUNDWORK";

export interface SpeciesProfile {
  name: string;
  code: string;
  status: SpeciesStatus;
  maxAgeMonths: number;
  maxWeightKg: number;
  conditionFamilies: readonly string[];
  welfareNotes: string;
}

export const SPECIES_CATALOG: readonly SpeciesProfile[] = [
  {
    name: "Swine",
    code: "SW",
    status: "PILOT",
    maxAgeMonths: 180,
    maxWeightKg: 450,
    conditionFamilies: ["Respiratory", "Musculoskeletal", "Gastrointestinal", "Reproductive", "Integumentary", "Cardiovascular", "Neurological"],
    welfareNotes: "Transport within pilot corridor durations; fitness-for-transport exam required."
  },
  {
    name: "Bovine",
    code: "BV",
    status: "GROUNDWORK",
    maxAgeMonths: 300,
    maxWeightKg: 1500,
    conditionFamilies: ["Respiratory", "Musculoskeletal", "Gastrointestinal", "Reproductive", "Mammary", "Integumentary", "Neurological"],
    welfareNotes: "Groundwork only: requires species-specific transport, TB/brucellosis movement rules and veterinary protocol before activation."
  }
];

const byName = new Map(SPECIES_CATALOG.map((profile) => [profile.name.toLowerCase(), profile]));

export function speciesProfile(name: string | null | undefined): SpeciesProfile | null {
  if (typeof name !== "string") return null;
  return byName.get(name.trim().toLowerCase()) ?? null;
}

/** Canonical spelling for known species; unknown species are passed through trimmed. */
export function normalizeSpecies(name: string): string {
  return speciesProfile(name)?.name ?? name.trim();
}

export function speciesActivatable(name: string): boolean {
  return speciesProfile(name)?.status === "PILOT";
}

/** Plausibility issues for a known species; unknown species get no profile checks. */
export function speciesProfileIssues(input: { species: string; ageMonths?: number; weightKg?: number }): string[] {
  const profile = speciesProfile(input.species);
  if (!profile) return [];
  const issues: string[] = [];
  if (input.ageMonths !== undefined && input.ageMonths > profile.maxAgeMonths) {
    issues.push(`ageMonths exceeds the ${profile.name} profile maximum of ${profile.maxAgeMonths}`);
  }
  if (input.weightKg !== undefined && input.weightKg > profile.maxWeightKg) {
    issues.push(`weightKg exceeds the ${profile.name} profile maximum of ${profile.maxWeightKg}`);
  }
  return issues;
}
