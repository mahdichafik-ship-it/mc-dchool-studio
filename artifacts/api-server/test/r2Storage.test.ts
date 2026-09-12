import assert from "node:assert/strict";
import test from "node:test";
import { createR2PutUpload, getR2Config } from "../src/lib/r2Storage";

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

test("R2 creates a bounded deterministic presigned PUT without exposing its secret", () => {
  const session = createR2PutUpload(
    "projects/1/captures/2/files/3/photo.nef",
    {
      contentType: "application/octet-stream",
      sha256: "a".repeat(64),
      expiresInSeconds: 300,
      now: new Date("2026-09-12T12:00:00.000Z"),
    },
    {
      accountId: "account",
      accessKeyId: "access",
      secretAccessKey: "never-expose-this",
      bucket: "private-bucket",
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
    },
  );

  assert.equal(session.uploadMethod, "PUT");
  assert.equal(session.expiresAt, "2026-09-12T12:05:00.000Z");
  assert.equal(session.uploadHeaders["x-amz-meta-sha256"], "a".repeat(64));
  assert.match(session.uploadUrl, /X-Amz-Expires=300/);
  assert.doesNotMatch(session.uploadUrl, /never-expose-this/);
});