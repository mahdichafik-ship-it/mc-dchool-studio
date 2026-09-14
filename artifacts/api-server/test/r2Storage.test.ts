import assert from "node:assert/strict";
import test from "node:test";
import {
  createR2GetDownload,
  createR2PutUpload,
  getR2Config,
} from "../src/lib/r2Storage";

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

test("R2 creates a bounded direct GET capability without exposing its secret", () => {
  const download = createR2GetDownload(
    "projects/1/captures/2/files/3/photo preview.jpg",
    {
      expiresInSeconds: 999,
      responseContentDisposition: 'inline; filename="photo preview.jpg"',
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

  const url = new URL(download.downloadUrl);
  assert.equal(download.downloadMethod, "GET");
  assert.equal(download.expiresAt, "2026-09-12T12:15:00.000Z");
  assert.equal(url.pathname, "/private-bucket/projects/1/captures/2/files/3/photo%20preview.jpg");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(url.searchParams.get("response-content-disposition"), 'inline; filename="photo preview.jpg"');
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(download.downloadUrl, /never-expose-this/);
});