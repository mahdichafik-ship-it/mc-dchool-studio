import jsQR from 'jsqr'
import { Jimp } from 'jimp'

export interface QrResult {
  studentId: string
  firstName?: string
  lastName?: string
  raw: string
}

export async function readQrFromImage(filePath: string): Promise<QrResult | null> {
  try {
    const image = await Jimp.read(filePath)

    const { data, width, height } = image.bitmap

    // jsQR expects Uint8ClampedArray of RGBA data
    const uint8Data = new Uint8ClampedArray(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    )

    const code = jsQR(uint8Data, width, height, {
      inversionAttempts: 'dontInvert',
    })

    if (!code) {
      const code2 = jsQR(uint8Data, width, height, {
        inversionAttempts: 'invertFirst',
      })
      if (!code2) return null
      return parseQrData(code2.data)
    }

    return parseQrData(code.data)
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
