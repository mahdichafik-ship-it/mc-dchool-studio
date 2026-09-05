import type { Photo, PhotoMatchedEvent } from '../../../shared/types'

/**
 * A fast preview arrives before the managed photo row exists. When the
 * persisted event arrives, it may not carry the preview URL again because
 * persistence must not block on image work. Keep the already-prepared local
 * artifact while replacing the source metadata with the durable photo.
 */
export function mergeMatchedPhoto(
  previous: Photo | null,
  event: PhotoMatchedEvent,
): Photo {
  return {
    ...event.photo,
    previewUrl: event.photo.previewUrl ?? previous?.previewUrl,
    previewKey: event.previewKey ?? event.photo.previewKey ?? previous?.previewKey,
    thumbnailData: event.photo.thumbnailData ?? previous?.thumbnailData ?? null,
  }
}