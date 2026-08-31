import jsQR from 'jsqr'
import { Jimp } from 'jimp'

export interface QrResult {
  studentId: string
  firstName?: string
  lastName?: string
  raw: string
}

const MAX_QR_SCAN_EDGE = 2_000

function decodeBitmap(image: Jimp): QrResult | null {
  const { data, width, height } = image.bitmap
  const uint8Data = new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  )

  const normal = jsQR(uint8Data, width, height, {
    inversionAttempts: 'dontInvert',
  })
  if (normal) return parseQrData(normal.data)

  const inverted = jsQR(uint8Data, width, height, {
    inversionAttempts: 'invertFirst',
  })
  return inverted ? parseQrData(inverted.data) : null
}

function normalizedScanImage(image: Jimp): Jimp {
  const { width, height } = image.bitmap
  const longestEdge = Math.max(width, height)
  if (longestEdge <= MAX_QR_SCAN_EDGE) return image.clone()

  const scale = MAX_QR_SCAN_EDGE / longestEdge
  return image.clone().resize({
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  })
}

function qrScanVariants(image: Jimp): Jimp[] {
  const normalized = normalizedScanImage(image)
  const variants = [normalized]

  // Camera JPEGs can flatten the QR's blacks and whites. A grayscale,
  // higher-contrast pass recovers many codes without an unbounded search.
  variants.push(normalized.clone().greyscale().contrast(0.35))

  // Marker cards are normally near the center of the frame. Cropping away
  // distracting portrait/background detail gives jsQR a cleaner final pass.
  const { width, height } = normalized.bitmap
  if (width >= 240 && height >= 240) {
    const cropWidth = Math.max(1, Math.round(width * 0.8))
    const cropHeight = Math.max(1, Math.round(height * 0.8))
    variants.push(normalized.clone().crop({
      x: Math.round((width - cropWidth) / 2),
      y: Math.round((height - cropHeight) / 2),
      w: cropWidth,
      h: cropHeight,
    }).greyscale().contrast(0.35))
  }

  // If normalization changed a very large image, retain one full-resolution
  // fallback for small or distant codes that would otherwise lose modules.
  if (normalized.bitmap.width !== image.bitmap.width || normalized.bitmap.height !== image.bitmap.height) {
    variants.push(image.clone())
  }

  return variants
}

export async function readQrFromImage(filePath: string): Promise<QrResult | null> {
  try {
    const image = await Jimp.read(filePath)

    for (const candidate of qrScanVariants(image)) {
      const result = decodeBitmap(candidate)
      if (result) return result
    }
    return null
  } catch (err) {
    console.error('QR read error for', filePath, err)
    return null
  }
}

function parseQrData(raw: string): QrResult | null {
  raw = raw.trim()
  if (!raw) return null

  // JSON format: {"project":"...","class":"...","firstName":"...","lastName":"...","studentId":"..."}
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.studentId) {
        return {
          studentId: String(parsed.studentId),
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          raw,
        }
      }
    } catch {
      // fall through to simple format
    }
  }

  // Simple format: firstName.lastName.studentId
  const parts = raw.split('.')
  if (parts.length >= 3) {
    const studentId = parts[parts.length - 1]
    const lastName = parts[parts.length - 2]
    const firstName = parts.slice(0, parts.length - 2).join('.')
    return { studentId, firstName, lastName, raw }
  }

  // Last resort: treat whole string as student ID
  return { studentId: raw, raw }
}

export async function generateThumbnail(filePath: string, size = 300): Promise<string | null> {
  try {
    const image = await Jimp.read(filePath)
    image.cover({ w: size, h: size })
    const base64 = await image.getBase64('image/jpeg')
    return base64
  } catch {
    return null
  }
}
