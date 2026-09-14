import { strict as assert } from "node:assert";
import test from "node:test";
import { isCsvFileName } from "./importFile.ts";

test("detects CSV extensions without regard to case", () => {
  assert.equal(isCsvFileName("roster.csv"), true);
  assert.equal(isCsvFileName("roster.CSV"), true);
  assert.equal(isCsvFileName("roster.CsV"), true);
  assert.equal(isCsvFileName("roster.xlsx"), false);
  assert.equal(isCsvFileName("csv-roster"), false);
});