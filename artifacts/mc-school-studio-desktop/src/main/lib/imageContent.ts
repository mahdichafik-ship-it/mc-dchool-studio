import sharp from 'sharp'

/**
 * A blank camera frame is normally encoded as a valid JPEG, so checking only
 * the file size or decoder status is not enough. Keep this deliberately
 * conservative: a frame is blank only when every channel is effectively
 * uniform. A dark frame with subject detail still has measurable variation
 * and is accepted.
 */
export interface ImageContentAssessment {
  usable: boolean
  reason?: 'decode-failed' | 'uniform-frame'
  channelRange?: number
  maximumStandardDeviation?: number
}

const MAX_UNIFORM_CHANNEL_RANGE = 3
const MAX_UNIFORM_STANDARD_DEVIATION = 1.25

export async function assessImageContent(filePath: string): Promise<ImageContentAssessment> {
  try {
    const stats = await sharp(filePath, { failOn: 'none' }).stats()
    const channels = stats.channels
    const minimum = Math.min(...channels.map((channel) => channel.min))
    const maximum = Math.max(...channels.map((channel) => channel.max))
    const channelRange = maximum - minimum
    const maximumStandardDeviation = Math.max(
      ...channels.map((channel) => channel.stdev),
    )
    const uniform = channelRange <= MAX_UNIFORM_CHANNEL_RANGE
      && maximumStandardDeviation <= MAX_UNIFORM_STANDARD_DEVIATION

    return {
      usable: !uniform,
      ...(uniform ? { reason: 'uniform-frame' as const } : {}),
      channelRange,
      maximumStandardDeviation,
    }
  } catch {
    return { usable: false, reason: 'decode-failed' }
  }
}