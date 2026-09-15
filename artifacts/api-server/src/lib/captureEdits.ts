import type { Sharp } from "sharp";

export type CaptureEditSettings = {
  cropPositionX: number | null;
  cropPositionY: number | null;
  cropScale: number | null;
  aspectRatio: string | null;
  straightenAngle: number | null;
  rotation: number | null;
};

export type CaptureEditSettingsPatch = Partial<CaptureEditSettings>;

const EDIT_KEYS = [
  "cropPositionX",
  "cropPositionY",
  "cropScale",
  "aspectRatio",
  "straightenAngle",
  "rotation",
] as const;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedAspectRatio(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "" || (typeof value === "string" && value.toLowerCase() === "original")) return null;
  if (value === "Square") return "1:1";
  if (typeof value !== "string") return undefined;
  const compact = value.trim().replace(/\s+/g, "");
  const match = compact.match(/^(\d+(?:\.\d+)?)[/:](\d+(?:\.\d+)?)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return undefined;
  return `${Number(match[1])}:${Number(match[2])}`;
}

/**
 * Parse the optional edit fields accepted by the desktop capture review
 * endpoint. Both the flat legacy-friendly shape and the nested
 * { editSettings: { cropPosition: { x, y } } } shape are accepted. The
 * desktop framing shape is also accepted while clients migrate to the
 * canonical editSettings name.
 */
export function parseCaptureEditSettings(body: unknown): {
  provided: boolean;
  settings: CaptureEditSettings | null;
  error?: string;
} {
  if (!body || typeof body !== "object") return { provided: false, settings: null };
  const source = body as Record<string, unknown>;
  const nested = source.editSettings !== undefined ? source.editSettings : source.framing;
  const edit = nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : source;
  const framing = source.framing && typeof source.framing === "object"
    ? source.framing as Record<string, unknown>
    : undefined;
  const cropPosition = edit.cropPosition && typeof edit.cropPosition === "object"
    ? edit.cropPosition as Record<string, unknown>
    : undefined;
  const desktopCropX = framing?.cropX;
  const desktopCropY = framing?.cropY;
  const usesDesktopFraming = source.editSettings === undefined && source.framing !== undefined;
  const provided = source.editSettings !== undefined
    || source.framing !== undefined
    || EDIT_KEYS.some((key) => source[key] !== undefined)
    || cropPosition?.x !== undefined
    || cropPosition?.y !== undefined
    || edit.rotationDegrees !== undefined;
  if (!provided) return { provided: false, settings: null };
  if (source.editSettings !== undefined && source.editSettings !== null && typeof source.editSettings !== "object") {
    return { provided: true, settings: null, error: "editSettings must be an object or null" };
  }

  const x = edit.cropPositionX ?? cropPosition?.x
    ?? (finiteNumber(desktopCropX) ? Math.max(0, Math.min(1, 0.5 + desktopCropX / 200)) : null);
  const y = edit.cropPositionY ?? cropPosition?.y
    ?? (finiteNumber(desktopCropY) ? Math.max(0, Math.min(1, 0.5 + desktopCropY / 200)) : null);
  const rawCropScale = edit.cropScale;
  const cropScale = usesDesktopFraming && finiteNumber(rawCropScale)
    ? rawCropScale / 100
    : rawCropScale ?? null;
  const straightenAngle = edit.straightenAngle ?? null;
  const rotationValue = edit.rotation ?? edit.rotationDegrees ?? null;
  if (x !== null && (!finiteNumber(x) || x < 0 || x > 1)) {
    return { provided: true, settings: null, error: "cropPositionX must be between 0 and 1" };
  }
  if (y !== null && (!finiteNumber(y) || y < 0 || y > 1)) {
    return { provided: true, settings: null, error: "cropPositionY must be between 0 and 1" };
  }
  if (cropScale !== null && (!finiteNumber(cropScale) || cropScale < 1 || cropScale > 3)) {
    return { provided: true, settings: null, error: "cropScale must be between 1 and 3" };
  }
  if (straightenAngle !== null && (!finiteNumber(straightenAngle) || straightenAngle < -45 || straightenAngle > 45)) {
    return { provided: true, settings: null, error: "straightenAngle must be between -45 and 45 degrees" };
  }
  if (rotationValue !== null && (!finiteNumber(rotationValue) || !Number.isInteger(rotationValue) || ![0, 90, 180, 270].includes(rotationValue))) {
    return { provided: true, settings: null, error: "rotation must be 0, 90, 180, or 270 degrees" };
  }
  const aspectRatio = normalizedAspectRatio(edit.aspectRatio);
  if (aspectRatio === undefined) {
    return { provided: true, settings: null, error: "aspectRatio must be a positive ratio such as 4:5" };
  }
  return {
    provided: true,
    settings: {
      cropPositionX: x,
      cropPositionY: y,
      cropScale,
      aspectRatio,
      straightenAngle,
      rotation: rotationValue,
    },
  };
}

export function captureEditSettingsFromRow(row: {
  cropPositionX: number | null;
  cropPositionY: number | null;
  cropScale: number | null;
  aspectRatio: string | null;
  straightenAngle: number | null;
  rotation: number | null;
}): CaptureEditSettings {
  return {
    cropPositionX: row.cropPositionX ?? null,
    cropPositionY: row.cropPositionY ?? null,
    cropScale: row.cropScale ?? null,
    aspectRatio: row.aspectRatio ?? null,
    straightenAngle: row.straightenAngle ?? null,
    rotation: row.rotation ?? null,
  };
}

export function normalizedCaptureEditSettings(settings?: Partial<CaptureEditSettings> | null): CaptureEditSettings {
  return {
    cropPositionX: settings?.cropPositionX ?? null,
    cropPositionY: settings?.cropPositionY ?? null,
    cropScale: settings?.cropScale === 1 ? null : settings?.cropScale ?? null,
    aspectRatio: settings?.aspectRatio ?? null,
    straightenAngle: settings?.straightenAngle === 0 ? null : settings?.straightenAngle ?? null,
    rotation: settings?.rotation === 0 ? null : settings?.rotation ?? null,
  };
}

function aspectRatio(value: string): number | null {
  const [width, height] = value.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

/**
 * Apply edits after EXIF orientation has been normalized. Cropping is done
 * explicitly rather than with a gravity preset so the photographer's saved
 * normalized crop position is retained in every derivative.
 */
export async function applyCaptureEdits(
  sourceBytes: Buffer,
  settings: CaptureEditSettings,
): Promise<Sharp> {
  let pipeline = (await import("sharp")).default(sourceBytes).rotate();
  if (settings.rotation) pipeline = pipeline.rotate(settings.rotation);
  if (settings.straightenAngle) {
    pipeline = pipeline.rotate(settings.straightenAngle, {
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }
  const ratio = settings.aspectRatio ? aspectRatio(settings.aspectRatio) : null;
  const scale = settings.cropScale ?? 1;
  if (ratio || scale !== 1) {
    const intermediate = await pipeline.png().toBuffer();
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(intermediate).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width > 0 && height > 0) {
      const targetRatio = ratio ?? width / height;
        // Fit the requested aspect ratio to the full image first. Zoom then
        // shrinks that fitted rectangle, rather than independently dividing
        // the source dimensions (which can lose the aspect-ratio constraint).
        let fittedWidth: number;
        let fittedHeight: number;
        if (width / height > targetRatio) {
          fittedHeight = height;
          fittedWidth = height * targetRatio;
        } else {
          fittedWidth = width;
          fittedHeight = width / targetRatio;
        }
        const cropWidth = Math.max(1, Math.round(fittedWidth / scale));
        const cropHeight = Math.max(1, Math.round(fittedHeight / scale));
      const positionX = settings.cropPositionX ?? 0.5;
      const positionY = settings.cropPositionY ?? 0.5;
        const fittedLeft = (width - fittedWidth) / 2;
        const fittedTop = (height - fittedHeight) / 2;
        const left = Math.max(
          0,
          Math.min(width - cropWidth, Math.round(fittedLeft + (fittedWidth - cropWidth) * positionX)),
        );
        const top = Math.max(
          0,
          Math.min(height - cropHeight, Math.round(fittedTop + (fittedHeight - cropHeight) * positionY)),
        );
      pipeline = sharp(intermediate).extract({ left, top, width: cropWidth, height: cropHeight });
    }
  }
  return pipeline;
}