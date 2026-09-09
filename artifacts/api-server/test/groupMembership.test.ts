import assert from "node:assert/strict";
import test from "node:test";
import { defaultGroupExclusionChanges } from "../src/lib/groupMembership";

test("replace excludes every omitted class member and clears re-added members", () => {
  assert.deepEqual(
    defaultGroupExclusionChanges("replace", [2, 4], [1, 2, 3]),
    { exclude: [1, 3], clear: [2] },
  );
});

test("remove creates exclusions without clearing them", () => {
  assert.deepEqual(
    defaultGroupExclusionChanges("remove", [2, 4], [1, 2, 3]),
    { exclude: [2], clear: [] },
  );
});

test("add only clears exclusions for class members", () => {
  assert.deepEqual(
    defaultGroupExclusionChanges("add", [2, 4], [1, 2, 3]),
    { exclude: [], clear: [2] },
  );
});