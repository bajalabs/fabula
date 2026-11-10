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

function jpegSize(b: Buffer): ImageSize | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i += 1
      continue
    }
    // Every start-of-frame marker but DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
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
