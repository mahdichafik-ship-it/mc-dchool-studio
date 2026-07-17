declare module 'jsqr' {
  interface Point {
    x: number
    y: number
  }
  interface QRCode {
    binaryData: number[]
    data: string
    chunks: unknown[]
    version: number
    location: {
      topRightCorner: Point
      topLeftCorner: Point
      bottomRightCorner: Point
      bottomLeftCorner: Point
      topRightFinderPattern: Point
      topLeftFinderPattern: Point
      bottomLeftFinderPattern: Point
      bottomRightAlignmentPattern?: Point
    }
  }
  type InversionAttemptOption = 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst'
  function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    providedOptions?: { inversionAttempts?: InversionAttemptOption },
  ): QRCode | null
  export = jsQR
}
