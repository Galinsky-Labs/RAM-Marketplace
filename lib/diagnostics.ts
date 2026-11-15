import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

/**
 * Provider-neutral diagnostic laboratory integration. A lab (or an integration
 * gateway in front of it) POSTs signed result reports. Reports are attached to
 * an animal case as evidence for veterinary review; they never change
 * eligibility, clearance or marketplace status by themselves.
 */
export interface DiagnosticsConfig {
  provider: string;
  secret: string;
}

export function diagnosticsConfig(env: Record<string, string | undefined> = process.env): DiagnosticsConfig | null {
  const provider = env.RAM_DIAGNOSTICS_PROVIDER_NAME?.trim();
  const secret = env.RAM_DIAGNOSTICS_WEBHOOK_SECRET?.trim();
  if (!provider || !secret) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(provider)) throw new Error("RAM_DIAGNOSTICS_PROVIDER_NAME is invalid");
  if (secret.length < 32 || /replace|changeme|example/i.test(secret)) {
    throw new Error("RAM_DIAGNOSTICS_WEBHOOK_SECRET must be a strong secret");
  }
  if (secret === env.AUTH_SECRET || secret === env.RAM_PAYMENT_GATEWAY_SECRET) {
    throw new Error("RAM_DIAGNOSTICS_WEBHOOK_SECRET must be distinct from other RAM secrets");
  }
  return { provider, secret };
}

export function signDiagnosticsPayload(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyDiagnosticsSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowMs = Date.now(),
  maxSkewSeconds = 300
): void {
  if (!timestamp || !signature) throw new Error("Diagnostics signature headers are required");
  if (!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)) throw new Error("Invalid diagnostics signature timestamp");
  if (Math.abs(nowMs - Number(timestamp) * 1000) > maxSkewSeconds * 1000) {
    throw new Error("Diagnostics signature timestamp is outside allowed skew");
  }
  if (!/^[a-f0-9]{64}$/i.test(signature)) throw new Error("Invalid diagnostics signature");
  const expected = Buffer.from(signDiagnosticsPayload(rawBody, timestamp, secret), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("Invalid diagnostics signature");
  }
}

const isoInstant = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");

export const diagnosticReportSchema = z.object({
  externalReportId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  animalCaseId: z.string().regex(/^[A-Za-z0-9._:-]{3,120}$/),
  accessionNumber: z.string().max(120).optional(),
  testCode: z.string().min(1).max(60),
  testName: z.string().min(2).max(200),
  specimenType: z.string().max(120).optional(),
  specimenCollectedAt: isoInstant.optional(),
  reportedAt: isoInstant,
  resultStatus: z.enum(["PRELIMINARY", "FINAL", "CORRECTED", "CANCELLED"]),
  interpretation: z.enum(["DETECTED", "NOT_DETECTED", "INCONCLUSIVE", "ABNORMAL", "NORMAL", "SEE_NARRATIVE"]),
  narrative: z.string().max(8000).optional(),
  reportable: z.boolean().default(false),
  observations: z.array(z.object({
    code: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    value: z.string().max(200),
    unit: z.string().max(40).optional(),
    referenceRange: z.string().max(120).optional(),
    flag: z.enum(["H", "L", "A", "N"]).optional()
  }).strict()).max(200).default([])
}).strict();

export type DiagnosticReportInput = z.infer<typeof diagnosticReportSchema>;

export function parseDiagnosticReport(rawBody: string): { report: DiagnosticReportInput; payloadHash: string } {
  if (rawBody.length > 131_072) throw new Error("Diagnostic report exceeds size limit");
  let value: unknown;
  try { value = JSON.parse(rawBody); } catch { throw new Error("Diagnostic report must be JSON"); }
  const parsed = diagnosticReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid diagnostic report: " + parsed.error.issues.map((issue) => issue.path.join(".") || "report").slice(0, 10).join(", "));
  }
  return { report: parsed.data, payloadHash: createHash("sha256").update(rawBody).digest("hex") };
}

/**
 * Escalation hint shown to the veterinarian. A reportable or DETECTED result
 * places a welfare/biosecurity review flag; it never clears anything.
 */
export function diagnosticReviewFlag(report: Pick<DiagnosticReportInput, "reportable" | "interpretation" | "resultStatus">) {
  if (report.reportable) return "REPORTABLE_CONDITION_STOP" as const;
  if (report.resultStatus === "CANCELLED") return "CANCELLED" as const;
  if (report.interpretation === "DETECTED" || report.interpretation === "ABNORMAL") return "VET_REVIEW_REQUIRED" as const;
  return "INFORMATIONAL" as const;
}
