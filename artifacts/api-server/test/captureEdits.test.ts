import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { applyCaptureEdits, parseCaptureEditSettings } from "../src/lib/captureEdits";
import { r2PhotoVariantKey } from "../src/lib/photoVariants";

test("capture edits accept the nested crop position contract", () => {
  const result = parseCaptureEditSettings({
    editSettings: {
      cropPosition: { x: 0.2, y: 0.8 },
      cropScale: 1.75,
      aspectRatio: "4 : 5",
      straightenAngle: -3,
      rotation: 90,
    },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.settings, {
    cropPositionX: 0.2,
    cropPositionY: 0.8,
    cropScale: 1.75,
    aspectRatio: "4:5",
    straightenAngle: -3,
    rotation: 90,
  });
});

test("desktop framing scale is normalized from percent to canonical zoom", () => {
  const result = parseCaptureEditSettings({
    framing: {
      cropX: 40,
      cropY: -20,
      cropScale: 175,
      aspectRatio: "original",
      straightenAngle: 0,
      rotation: 0,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.settings?.cropPositionX, 0.7);
  assert.equal(result.settings?.cropPositionY, 0.4);
  assert.equal(result.settings?.cropScale, 1.75);
  assert.equal(result.settings?.aspectRatio, null);
});

test("capture edits reject unsafe values and allow identity reset", () => {
  assert.match(
    parseCaptureEditSettings({ rotation: 45 }).error ?? "",
    /rotation must be 0, 90, 180, or 270/,
  );
  assert.match(
    parseCaptureEditSettings({ editSettings: { cropScale: 3.1 } }).error ?? "",
    /cropScale must be between 1 and 3/,
  );
  assert.deepEqual(parseCaptureEditSettings({ editSettings: null }).settings, {
    cropPositionX: null,
    cropPositionY: null,
    cropScale: null,
    aspectRatio: null,
    straightenAngle: null,
    rotation: null,
  });
});

test("R2 variant keys change when saved edits change", () => {
  const original = {
    objectKey: "projects/1/captures/2/photo.jpg",
    sha256: "a".repeat(64),
  };
  const identity = r2PhotoVariantKey(original, "preview");
  const reframed = r2PhotoVariantKey(original, "preview", undefined, {
    cropPositionX: 0.2,
    cropPositionY: 0.5,
    cropScale: 2,
    aspectRatio: "4:5",
    straightenAngle: 2,
    rotation: 90,
  });
  assert.notEqual(identity, reframed);
});

test("R2 variant namespaces separate same-stem originals with different extensions", () => {
  const originalHash = "a".repeat(64);
  const jpeg = r2PhotoVariantKey(
    { objectKey: "studio/project/portrait.jpg", sha256: originalHash },
    "preview",
  );
  const png = r2PhotoVariantKey(
    { objectKey: "studio/project/portrait.png", sha256: originalHash },
    "preview",
  );
  assert.notEqual(jpeg, png);
  assert.match(jpeg, /\.variants\/portrait\.jpg__/);
  assert.match(png, /\.variants\/portrait\.png__/);
});

test("saved aspect ratio and rotation transform derivative pixels", async () => {
  const source = await sharp({
    create: { width: 100, height: 50, channels: 3, background: "red" },
  }).png().toBuffer();
  const transformed = await applyCaptureEdits(source, {
    cropPositionX: 0.5,
    cropPositionY: 0.5,
    aspectRatio: "1:1",
    straightenAngle: null,
    rotation: 90,
  });
  const output = await transformed.toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, 50);
  assert.equal(output.info.height, 50);
});

test("crop scale zooms an original-aspect derivative around the saved position", async () => {
  const source = await sharp({
    create: { width: 100, height: 50, channels: 3, background: "blue" },
  }).png().toBuffer();
  const transformed = await applyCaptureEdits(source, {
    cropPositionX: 0.75,
    cropPositionY: 0.25,
    cropScale: 2,
    aspectRatio: null,
    straightenAngle: null,
    rotation: null,
  });
  const output = await transformed.toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, 50);
  assert.equal(output.info.height, 25);
});

async function focalTestSource(): Promise<Buffer> {
  const pixels = Buffer.alloc(12 * 8 * 3);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const offset = (y * 12 + x) * 3;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = 0;
    }
  }
  return sharp(pixels, { raw: { width: 12, height: 8, channels: 3 } }).png().toBuffer();
}

async function topLeftPixel(source: Buffer, cropPositionX: number, cropPositionY: number, aspectRatio: string, cropScale: number) {
  const pipeline = await applyCaptureEdits(source, {
    cropPositionX,
    cropPositionY,
    cropScale,
    aspectRatio,
    straightenAngle: null,
    rotation: null,
  });
  return pipeline.raw().toBuffer({ resolveWithObject: true });
}

test("crop scale keeps center, right, and bottom focal positions in the fitted aspect crop", async () => {
  const source = await focalTestSource();
  const center = await topLeftPixel(source, 0.5, 0.5, "1:1", 2);
  const right = await topLeftPixel(source, 1, 0.5, "1:1", 2);
  const bottom = await topLeftPixel(source, 0.5, 1, "1:1", 2);

  for (const output of [center, right, bottom]) {
    assert.equal(output.info.width, 4);
    assert.equal(output.info.height, 4);
  }
  assert.deepEqual([...center.data.subarray(0, 3)], [4, 2, 0]);
  assert.deepEqual([...right.data.subarray(0, 3)], [6, 2, 0]);
  assert.deepEqual([...bottom.data.subarray(0, 3)], [4, 4, 0]);
});

test("crop scale shrinks the fitted rectangle before applying a non-square focal crop", async () => {
  const source = await focalTestSource();
  const center = await topLeftPixel(source, 0.5, 0.5, "5:4", 2);
  const bottomRight = await topLeftPixel(source, 1, 1, "5:4", 2);

  assert.equal(center.info.width, 5);
  assert.equal(center.info.height, 4);
  assert.equal(bottomRight.info.width, 5);
  assert.equal(bottomRight.info.height, 4);
  assert.deepEqual([...center.data.subarray(0, 3)], [4, 2, 0]);
  assert.deepEqual([...bottomRight.data.subarray(0, 3)], [6, 4, 0]);
});