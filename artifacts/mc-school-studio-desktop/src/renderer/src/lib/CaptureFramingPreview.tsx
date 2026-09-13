import React, { useEffect, useState } from 'react'
import type { CaptureFraming } from '@shared/types'
import { cn } from '@/lib/utils'
import { capturePreviewViewportStyle, getCaptureCropGeometry } from './captureFraming'

interface Props {
  source?: string
  alt: string
  framing: Omit<CaptureFraming, 'pending'>
  maxBlockSize: string
  className?: string
}

/**
 * Displays the exact crop rectangle represented by the cloud derivative.
 * The image is placed in a transformed source canvas, and the outer viewport
 * is the extracted crop. This avoids object-contain's letterboxing and keeps
 * focal position semantics identical to the server.
 */
export function CaptureFramingPreview({ source, alt, framing, maxBlockSize, className }: Props) {
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    setNaturalSize(null)
  }, [source])

  if (!source) {
    return (
      <div className={cn('relative flex items-center justify-center overflow-hidden bg-black', className)}>
        <p className="text-sm font-semibold text-slate-400">Preview unavailable</p>
      </div>
    )
  }

  const geometry = naturalSize ? getCaptureCropGeometry(naturalSize.width, naturalSize.height, framing) : null
  return (
    <div
      className={cn('relative overflow-hidden bg-black', className)}
      style={geometry ? capturePreviewViewportStyle(geometry, maxBlockSize) : undefined}
    >
      <img
        src={source}
        alt={alt}
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget
          setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
        }}
        className={cn(
          'absolute inset-0 h-full w-full',
          geometry ? 'opacity-0' : 'opacity-100',
        )}
        aria-hidden={geometry ? true : undefined}
      />
      {geometry && (
        <div
          className="absolute"
          style={{
            width: `${(geometry.transformedWidth / geometry.cropWidth) * 100}%`,
            height: `${(geometry.transformedHeight / geometry.cropHeight) * 100}%`,
            left: `${-(geometry.cropLeft / geometry.cropWidth) * 100}%`,
            top: `${-(geometry.cropTop / geometry.cropHeight) * 100}%`,
          }}
        >
          <img
            src={source}
            alt={alt}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: `${(geometry.sourceWidth / geometry.transformedWidth) * 100}%`,
              height: `${(geometry.sourceHeight / geometry.transformedHeight) * 100}%`,
              transform: `translate(-50%, -50%) rotate(${geometry.rotation + geometry.straightenAngle}deg)`,
            }}
          />
        </div>
      )}
    </div>
  )
}
