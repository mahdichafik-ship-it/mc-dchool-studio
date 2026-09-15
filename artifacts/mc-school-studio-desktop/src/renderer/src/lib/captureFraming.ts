import type { CaptureFraming } from '@shared/types'
import type { CSSProperties } from 'react'

export interface CaptureCropGeometry {
  sourceWidth: number
  sourceHeight: number
  transformedWidth: number
  transformedHeight: number
  cropWidth: number
  cropHeight: number
  cropLeft: number
  cropTop: number
  aspectRatio: number
  rotation: 0 | 90 | 180 | 270
  straightenAngle: number
}

export interface CapturePreviewLayout {
  width: number
  height: number
  aspectRatio: number
}

/**
 * Fit a crop viewport inside both available inline and block space without
 * independently clamping either dimension. This is also useful for renderer
 * layout tests because it contains the exact sizing rule used by the CSS
 * viewport.
 */
export function fitCapturePreviewLayout(
  availableWidth: number,
  availableHeight: number,
  aspectRatio: number,
): CapturePreviewLayout {
  const width = Math.min(availableWidth, availableHeight * aspectRatio)
  return { width, height: width / aspectRatio, aspectRatio }
}

export function capturePreviewViewportStyle(
  geometry: Pick<CaptureCropGeometry, 'cropWidth' | 'cropHeight' | 'aspectRatio'>,
  maxBlockSize: string,
): CSSProperties {
  return {
    width: `min(100%, calc(${maxBlockSize} * ${geometry.aspectRatio}))`,
    maxHeight: maxBlockSize,
    aspectRatio: `${geometry.cropWidth} / ${geometry.cropHeight}`,
  }
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  return normalized as 0 | 90 | 180 | 270
}

function aspectRatioValue(aspectRatio: CaptureFraming['aspectRatio']): number | null {
  if (aspectRatio === 'original') return null
  const [width, height] = aspectRatio.split(':').map(Number)
  return width > 0 && height > 0 ? width / height : null
}

/**
 * Mirrors applyCaptureEdits on the server:
 * normalize orientation, apply rotation/straighten, fit the requested aspect
 * rectangle to the transformed source, then shrink that rectangle by scale and
 * place it using normalized focal coordinates.
 */
export function getCaptureCropGeometry(
  sourceWidth: number,
  sourceHeight: number,
  framing: Omit<CaptureFraming, 'pending'>,
): CaptureCropGeometry {
  const width = finiteDimension(sourceWidth)
  const height = finiteDimension(sourceHeight)
  const rotation = normalizeRotation(framing.rotation)
  const rotatedWidth = rotation === 90 || rotation === 270 ? height : width
  const rotatedHeight = rotation === 90 || rotation === 270 ? width : height
  const straightenAngle = Number.isFinite(framing.straightenAngle) ? framing.straightenAngle : 0
  const radians = Math.abs(straightenAngle) * Math.PI / 180
  const transformedWidth = rotatedWidth * Math.cos(radians) + rotatedHeight * Math.sin(radians)
  const transformedHeight = rotatedWidth * Math.sin(radians) + rotatedHeight * Math.cos(radians)
  const targetRatio = aspectRatioValue(framing.aspectRatio) ?? transformedWidth / transformedHeight
  const fittedWidth = transformedWidth / transformedHeight > targetRatio
    ? transformedHeight * targetRatio
    : transformedWidth
  const fittedHeight = transformedWidth / transformedHeight > targetRatio
    ? transformedHeight
    : transformedWidth / targetRatio
  const scale = Math.max(1, Math.min(3, framing.cropScale / 100))
  const cropWidth = Math.max(1, Math.round(fittedWidth / scale))
  const cropHeight = Math.max(1, Math.round(fittedHeight / scale))
  const focalX = Math.max(0, Math.min(1, 0.5 + framing.cropX / 200))
  const focalY = Math.max(0, Math.min(1, 0.5 + framing.cropY / 200))
  const fittedLeft = (transformedWidth - fittedWidth) / 2
  const fittedTop = (transformedHeight - fittedHeight) / 2
  const cropLeft = Math.max(
    0,
    Math.min(transformedWidth - cropWidth, Math.round(fittedLeft + (fittedWidth - cropWidth) * focalX)),
  )
  const cropTop = Math.max(
    0,
    Math.min(transformedHeight - cropHeight, Math.round(fittedTop + (fittedHeight - cropHeight) * focalY)),
  )

  return {
    sourceWidth: width,
    sourceHeight: height,
    transformedWidth,
    transformedHeight,
    cropWidth,
    cropHeight,
    cropLeft,
    cropTop,
    aspectRatio: cropWidth / cropHeight,
    rotation,
    straightenAngle,
  }
}
