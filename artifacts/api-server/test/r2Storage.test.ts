import assert from "node:assert/strict";
import test from "node:test";
import { getR2Config } from "../src/lib/r2Storage";

test("R2 stays disabled when no configuration is present", () => {
  assert.equal(getR2Config({}), null);
});

test("R2 rejects partial configuration", () => {
  assert.throws(
    () => getR2Config({ R2_ACCOUNT_ID: "account" }),
    /configuration is incomplete/,
  );
});

test("R2 builds a private S3 endpoint from complete configuration", () => {
  assert.deepEqual(
    getR2Config({
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "private-bucket",
    }),
    {
      accountId: "account",
      accessKeyId: "access",
      secretAccessKey: "secret",
      bucket: "private-bucket",
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
    },
  );
});