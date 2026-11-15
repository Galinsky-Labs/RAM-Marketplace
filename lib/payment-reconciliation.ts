import { z } from "zod";

/**
 * Payment reconciliation: compare RAM payment executions with a provider
 * statement for a period. Pure function; persistence and incident creation are
 * handled server-side. Any discrepancy means the period is NOT reconciled.
 */
export const statementLineSchema = z.object({
  providerReference: z.string().min(1).max(200),
  idempotencyKey: z.string().max(200).optional(),
  amountCents: z.number().int().nonnegative().max(1_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(["SUCCEEDED", "FAILED", "PENDING", "REVERSED"]),
  occurredAt: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp")
}).strict();

export const statementSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  periodStart: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  periodEnd: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  lines: z.array(statementLineSchema).max(5000)
}).strict().refine((value) => Date.parse(value.periodStart) < Date.parse(value.periodEnd), "period is reversed");

export type StatementLine = z.infer<typeof statementLineSchema>;
export type Statement = z.infer<typeof statementSchema>;

export interface ExecutionRecord {
  id: string;
  idempotencyKey: string;
  providerReference: string | null;
  amountCents: number;
  currency: string;
  status: string;
  type: string;
}

export type DiscrepancyKind =
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "STATUS_MISMATCH"
  | "MISSING_AT_PROVIDER"
  | "UNKNOWN_AT_RAM"
  | "DUPLICATE_PROVIDER_LINE";

export interface Discrepancy {
  kind: DiscrepancyKind;
  executionId?: string;
  providerReference?: string;
  detail: string;
}

export interface ReconciliationResult {
  matched: number;
  discrepancies: Discrepancy[];
  ramSucceededCents: number;
  providerSucceededCents: number;
  reconciled: boolean;
}

const statusEquivalent: Record<string, StatementLine["status"][]> = {
  SUCCEEDED: ["SUCCEEDED"],
  FAILED: ["FAILED"],
  CANCELED: ["FAILED"],
  PROCESSING: ["PENDING"],
  SUBMITTED: ["PENDING"],
  SUBMISSION_UNKNOWN: ["PENDING", "SUCCEEDED", "FAILED"]
};

export function reconcilePayments(executions: readonly ExecutionRecord[], lines: readonly StatementLine[]): ReconciliationResult {
  const discrepancies: Discrepancy[] = [];
  const byReference = new Map<string, StatementLine>();
  for (const line of lines) {
    if (byReference.has(line.providerReference)) {
      discrepancies.push({ kind: "DUPLICATE_PROVIDER_LINE", providerReference: line.providerReference, detail: "Provider statement lists this reference more than once" });
      continue;
    }
    byReference.set(line.providerReference, line);
  }
  const byKey = new Map<string, StatementLine>();
  for (const line of byReference.values()) if (line.idempotencyKey) byKey.set(line.idempotencyKey, line);

  const consumed = new Set<string>();
  let matched = 0;
  let ramSucceededCents = 0;
  for (const execution of executions) {
    if (execution.status === "CREATED") continue; // never submitted to a provider
    if (execution.status === "SUCCEEDED") ramSucceededCents += execution.amountCents;
    const line = (execution.providerReference && byReference.get(execution.providerReference)) || byKey.get(execution.idempotencyKey);
    if (!line) {
      if (execution.status === "SUCCEEDED" || execution.status === "PROCESSING") {
        discrepancies.push({ kind: "MISSING_AT_PROVIDER", executionId: execution.id, detail: `RAM ${execution.status} execution has no provider statement line` });
      }
      continue;
    }
    consumed.add(line.providerReference);
    let ok = true;
    if (line.amountCents !== execution.amountCents) {
      ok = false;
      discrepancies.push({ kind: "AMOUNT_MISMATCH", executionId: execution.id, providerReference: line.providerReference, detail: `RAM ${execution.amountCents} vs provider ${line.amountCents}` });
    }
    if (line.currency !== execution.currency) {
      ok = false;
      discrepancies.push({ kind: "CURRENCY_MISMATCH", executionId: execution.id, providerReference: line.providerReference, detail: `RAM ${execution.currency} vs provider ${line.currency}` });
    }
    const allowed = statusEquivalent[execution.status] ?? [];
    if (!allowed.includes(line.status)) {
      ok = false;
      discrepancies.push({ kind: "STATUS_MISMATCH", executionId: execution.id, providerReference: line.providerReference, detail: `RAM ${execution.status} vs provider ${line.status}` });
    }
    if (ok) matched++;
  }
  let providerSucceededCents = 0;
  for (const line of byReference.values()) {
    if (line.status === "SUCCEEDED") providerSucceededCents += line.amountCents;
    if (!consumed.has(line.providerReference)) {
      discrepancies.push({ kind: "UNKNOWN_AT_RAM", providerReference: line.providerReference, detail: "Provider line has no RAM payment execution" });
    }
  }
  return {
    matched,
    discrepancies,
    ramSucceededCents,
    providerSucceededCents,
    reconciled: discrepancies.length === 0 && ramSucceededCents === providerSucceededCents
  };
}
