/* What a picture's bytes say it is: its kind and its size in pixels, read from the header alone. A document takes
   only these three kinds, and a small file can still decode to a huge bitmap, so the size is checked before an engine
   sees it. */

export type ImageExtension = 'png' | 'jpg' | 'webp'

export interface ImageSize {
  width: number
  height: number
}

/** The file's real kind, by its first bytes. */
export function imageExtension(bytes: Uint8Array): ImageExtension | null {
  const head = Buffer.from(bytes.subarray(0, 12))
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** Start-of-frame markers: C0–CF but DHT (C4), JPG (C8) and DAC (CC). */
const isFrameHeader = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
/** Markers without a length: TEM and RST0–7. */
const isStandalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7)

/**
 * The frame size, walking the file as a decoder does: segment by segment, through each scan's entropy-coded data
 * (where FF 00 is a stuffed byte and FF D0–D7 a restart, never a marker), up to the end of the image. Anything a
 * decoder would have to guess at is refused (null): a byte that is not a marker between segments (FF 00 there is
 * one), a length that runs past the file, a second frame header, a second start of image, a frame that leaves its
 * height to a later DNL segment.
 */
function jpegSize(b: Buffer): ImageSize | null {
  let i = 2
  let size: ImageSize | null = null
  while (i < b.length) {
    if (b[i] !== 0xff) return null
    while (i < b.length && b[i] === 0xff) i++ // fill bytes before the marker code
    if (i >= b.length) return null
    const marker = b[i++]
    if (marker === 0xd9) return size // end of image
    if (marker === 0x00 || marker === 0xd8) return null
    if (isStandalone(marker)) continue
    if (i + 2 > b.length) return null
    const length = b.readUInt16BE(i)
    if (length < 2 || i + length > b.length) return null
    if (isFrameHeader(marker)) {
      if (size || length < 8) return null
      size = { height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5) }
      if (size.height === 0 || size.width === 0) return null
    }
    if (marker === 0xda && !size) return null // a scan before its frame header
    i += length
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is neither a stuffed byte nor a restart
      while (i < b.length) {
        if (b[i] !== 0xff) {
          i++
          continue
        }
        let j = i + 1
        while (j < b.length && b[j] === 0xff) j++
        if (j >= b.length) return size
        if (b[j] === 0x00 || (b[j] >= 0xd0 && b[j] <= 0xd7)) {
          i = j + 1
          continue
        }
        i = j - 1 // the last FF before the marker code
        break
      }
    }
  }
  return size // no end-of-image marker: a truncated file, as a decoder reads it
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  return null
}

/** The size in pixels the header declares; null when it cannot be read. */
export function imageSize(bytes: Uint8Array, kind: ImageExtension): ImageSize | null {
  const b = Buffer.from(bytes)
  if (kind === 'png') return b.length < 24 ? null : { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  return kind === 'jpg' ? jpegSize(b) : webpSize(b)
}
