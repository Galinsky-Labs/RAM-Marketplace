/**
 * Producer data feed import: converts a herd-management CSV export into the
 * supplier batch envelope. Parsing is strict and bounded; every row is then
 * validated by the same schema as a single submission and lands in quarantine.
 */
export const MAX_FEED_CSV_BYTES = 262_144;

const BOOLEAN_FIELDS = new Set(["independentCullAttestation", "ownerAttestation"]);
const NUMBER_FIELDS = new Set(["ageMonths", "weightKg"]);
export const FEED_COLUMNS = [
  "externalAnimalId", "species", "breed", "sex", "ageMonths", "weightKg", "condition", "diseaseStage",
  "observedSigns", "firstObservedDate", "existingDiagnosis", "currentTreatment", "generalHusbandry",
  "cullDecisionDate", "plannedCullAt", "cullReason", "welfareUrgency", "independentCullAttestation", "ownerAttestation"
] as const;

/** RFC 4180 CSV (quoted fields, escaped quotes, CRLF/LF). Throws on malformed quoting. */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_FEED_CSV_BYTES) throw new Error("CSV feed exceeds size limit");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.replace(/^﻿/, "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++;
        if (i < src.length && src[i] !== "," && src[i] !== "\n" && src[i] !== "\r") {
          throw new Error("Malformed CSV: text after closing quote");
        }
        continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') {
      if (field.length) throw new Error("Malformed CSV: quote inside unquoted field");
      quoted = true; i++; continue;
    }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(field); field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quote");
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function coerce(column: string, raw: string): unknown {
  const value = raw.trim();
  if (value === "") return undefined;
  if (BOOLEAN_FIELDS.has(column)) {
    if (/^(true|yes|y|1)$/i.test(value)) return true;
    if (/^(false|no|n|0)$/i.test(value)) return false;
    return value;
  }
  if (NUMBER_FIELDS.has(column)) {
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return value;
}

/** Build the batch envelope; unknown or duplicate headers are rejected. */
export function csvToSupplierBatch(batchKey: string, csv: string) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("CSV feed needs a header row and at least one animal");
  const header = rows[0].map((value) => value.trim());
  const known = new Set<string>(FEED_COLUMNS);
  const seen = new Set<string>();
  for (const column of header) {
    if (!known.has(column)) throw new Error(`Unknown CSV column: ${column.slice(0, 60)}`);
    if (seen.has(column)) throw new Error(`Duplicate CSV column: ${column}`);
    seen.add(column);
  }
  if (!seen.has("externalAnimalId")) throw new Error("CSV feed requires an externalAnimalId column");
  return {
    batchKey,
    rows: rows.slice(1).map((cells, index) => {
      if (cells.length !== header.length) {
        throw new Error(`CSV row ${index + 2} has ${cells.length} cells; expected ${header.length}`);
      }
      const submission: Record<string, unknown> = {};
      let externalAnimalId = "";
      header.forEach((column, position) => {
        if (column === "externalAnimalId") { externalAnimalId = cells[position].trim(); return; }
        const value = coerce(column, cells[position]);
        if (value !== undefined) submission[column] = value;
      });
      return { externalAnimalId, submission };
    })
  };
}
