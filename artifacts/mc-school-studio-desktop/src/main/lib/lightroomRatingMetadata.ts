import { writeFileSync } from 'node:fs'
import { extname, join, parse } from 'node:path'
import { exiftool } from 'exiftool-vendored'

export type LightroomRatingMetadataKind = 'embedded' | 'sidecar'

export function normalizedLightroomRating(rating: number): number {
  if (!Number.isFinite(rating)) {
    throw new Error('The capture rating is not a valid Lightroom rating.')
  }
  return Math.max(0, Math.min(5, Math.round(rating)))
}

export function buildLightroomRatingSidecar(rating: number): string {
  const value = normalizedLightroomRating(rating)
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmp:Rating="${value}"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>\n`
}

export function lightroomRatingSidecarPath(imagePath: string): string {
  const image = parse(imagePath)
  return join(image.dir, `${image.name}.xmp`)
}

export async function writeLightroomRatingMetadata(
  imagePath: string,
  rating: number,
  fileRole: 'JPEG' | 'RAW',
): Promise<LightroomRatingMetadataKind> {
  const value = normalizedLightroomRating(rating)
  const extension = extname(imagePath).toLowerCase()
  if (fileRole === 'JPEG' && (extension === '.jpg' || extension === '.jpeg')) {
    const result = await exiftool.write(
      imagePath,
      { 'XMP:Rating': value },
      { writeArgs: ['-overwrite_original'] },
    )
    if (result.updated < 1 && result.unchanged < 1) {
      throw new Error(`ExifTool did not write the Lightroom rating to ${imagePath}.`)
    }
    return 'embedded'
  }

  writeFileSync(lightroomRatingSidecarPath(imagePath), buildLightroomRatingSidecar(value), 'utf8')
  return 'sidecar'
}
