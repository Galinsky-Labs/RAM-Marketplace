import assert from "node:assert/strict";
import test from "node:test";
import { csvToSupplierBatch, parseCsv } from "../lib/producer-feed-csv";
import { previewSupplierBatch } from "../lib/supplier-batch-preview";

const header = "externalAnimalId,species,sex,condition,observedSigns,cullDecisionDate,plannedCullAt,cullReason,welfareUrgency,independentCullAttestation,ownerAttestation,ageMonths";
const row = 'SOW-0142,Swine,Female,Chronic lameness,"Intermittent lameness, left hind; ""mild"" swelling",2026-11-01,2026-11-20,Culled for chronic lameness,ROUTINE,yes,true,30';

test("RFC 4180 quoting, escaped quotes, CRLF and BOM are parsed", () => {
  const rows = parseCsv("﻿a,b\r\n\"x,1\",\"he said \"\"hi\"\"\"\r\n");
  assert.deepEqual(rows, [["a", "b"], ["x,1", 'he said "hi"']]);
});

test("malformed quoting is rejected", () => {
  assert.throws(() => parseCsv('a,"b\n'), /unterminated/);
  assert.throws(() => parseCsv('a,"b"c\n'), /after closing quote/);
  assert.throws(() => parseCsv('a,b"c"\n'), /quote inside/);
});

test("CSV feed converts to a batch that validates like single submissions", () => {
  const batch = csvToSupplierBatch("farm-feed-20261115", header + "\n" + row + "\n");
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].externalAnimalId, "SOW-0142");
  assert.equal(batch.rows[0].submission.independentCullAttestation, true);
  assert.equal(batch.rows[0].submission.ageMonths, 30);
  const preview = previewSupplierBatch("org-1", batch);
  assert.equal(preview.acceptedForReview, true, JSON.stringify(preview.rows));
});

test("unknown/duplicate columns and ragged rows are rejected", () => {
  assert.throws(() => csvToSupplierBatch("farm-feed-1", "externalAnimalId,price\nA,1\n"), /Unknown CSV column/);
  assert.throws(() => csvToSupplierBatch("farm-feed-1", "externalAnimalId,species,species\nA,B,C\n"), /Duplicate/);
  assert.throws(() => csvToSupplierBatch("farm-feed-1", header + "\nA,Swine\n"), /row 2 has 2 cells/);
  assert.throws(() => csvToSupplierBatch("farm-feed-1", header + "\n"), /at least one animal/);
});

test("missing attestation fails batch validation (no implicit consent)", () => {
  const batch = csvToSupplierBatch("farm-feed-20261115", header + "\n" + row.replace(",yes,true,", ",no,true,") + "\n");
  assert.equal(previewSupplierBatch("org-1", batch).acceptedForReview, false);
});
