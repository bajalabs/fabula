/* The pixel bound reads a picture's size as its decoder will (regression).

   JPEG, before: the header walk read `FF 00 <length>` as a segment, where a decoder skips it as a stray byte and
   finds the next marker, so a frame header could hide inside the "segment" while a small decoy answered for the size.
   It also stopped at the first frame header and never walked a scan. Now a byte that is not a marker between
   segments is refused, scans are walked through their stuffed bytes and restarts, and a second frame is refused. */

import { describe, expect, it } from 'vitest'
import { imageSize } from '../src/util/image-file.js'

const SOI = [0xff, 0xd8]
const EOI = [0xff, 0xd9]
/** A baseline frame header (SOF0) for a three-component image. */
const sof = (width: number, height: number) => [
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]
/** A scan header (SOS) and some entropy-coded data with a stuffed byte, a restart and a stuffed FF C0 look-alike. */
const scan = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0xc0, 0x00]
const jpeg = (...parts: number[][]) => Buffer.from(parts.flat())

describe('JPEG', () => {
  it('reads a frame with its scan, its stuffed bytes and its restarts', () => {
    expect(imageSize(jpeg(SOI, sof(640, 480), scan, EOI), 'jpg')).toEqual({ width: 640, height: 480 })
  })

  it('skips fill bytes before a marker, as a decoder does', () => {
    expect(imageSize(jpeg(SOI, [0xff, 0xff, 0xff], sof(3, 2), scan, EOI), 'jpg')).toEqual({ width: 3, height: 2 })
  })

  it('refuses FF 00 between segments: a frame could hide behind it while a decoy answers', () => {
    const hidden = sof(40_000, 40_000) // 1.6 billion pixels in a few bytes
    const decoy = sof(2, 2)
    // Read as a segment, FF 00 00 15 would skip the 19 bytes of the hidden frame and land on the decoy
    const file = jpeg(SOI, [0xff, 0x00, 0x00, 0x15], hidden, decoy, scan, EOI)
    expect(imageSize(file, 'jpg')).toBeNull()
  })

  it('refuses a second frame header, a scan before its frame, and a frame whose height comes later', () => {
    expect(imageSize(jpeg(SOI, sof(2, 2), scan, sof(40_000, 40_000), scan, EOI), 'jpg')).toBeNull()
    expect(imageSize(jpeg(SOI, scan, sof(2, 2), EOI), 'jpg')).toBeNull()
    expect(imageSize(jpeg(SOI, sof(2, 0), scan, EOI), 'jpg')).toBeNull()
  })

  it('refuses a length that runs past the file, and a stray byte between segments', () => {
    expect(imageSize(jpeg(SOI, [0xff, 0xe0, 0x40, 0x00, 0x00]), 'jpg')).toBeNull()
    expect(imageSize(jpeg(SOI, [0x00], sof(2, 2), EOI), 'jpg')).toBeNull()
  })

  it('stops at the end of the image, whatever follows it', () => {
    expect(imageSize(jpeg(SOI, sof(5, 4), scan, EOI, sof(40_000, 40_000)), 'jpg')).toEqual({ width: 5, height: 4 })
  })
})

/* WebP, before: the size came from the first chunk alone, so an extended file answered with its VP8X canvas while
   its bitstream, which the decoder allocates for, could declare 16384 × 16384. Now every chunk is walked, the larger
   of canvas and bitstream is the size, and an animation or a second bitstream is refused. */

const chunk = (id: string, body: number[]) => {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, Buffer.from(body), Buffer.alloc(body.length & 1)])
}
const riff = (...chunks: Buffer[]) => {
  const payload = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, payload])
}
const u24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const vp8x = (w: number, h: number, flags = 0) => chunk('VP8X', [flags, 0, 0, 0, ...u24(w - 1), ...u24(h - 1)])
const vp8l = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return chunk('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0])
}
const vp8 = (w: number, h: number) => chunk('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, w >> 8, h & 0xff, h >> 8])

describe('WebP', () => {
  it('reads a simple lossy and a simple lossless file', () => {
    expect(imageSize(riff(vp8(300, 200)), 'webp')).toEqual({ width: 300, height: 200 })
    expect(imageSize(riff(vp8l(30, 20)), 'webp')).toEqual({ width: 30, height: 20 })
  })

  it('takes the bitstream’s size when it is larger than the VP8X canvas', () => {
    expect(imageSize(riff(vp8x(1, 1), vp8l(16_384, 16_384)), 'webp')).toEqual({ width: 16_384, height: 16_384 })
    expect(imageSize(riff(vp8x(1, 1, 0x10), chunk('ALPH', [0]), vp8(16_383, 16_383)), 'webp')).toEqual({ width: 16_383, height: 16_383 })
  })

  it('takes the canvas when it is the larger', () => {
    expect(imageSize(riff(vp8x(20_000, 20_000), vp8l(1, 1)), 'webp')).toEqual({ width: 20_000, height: 20_000 })
  })

  it('refuses an animation, a second bitstream, no bitstream, and a chunk past the end', () => {
    expect(imageSize(riff(vp8x(2, 2, 0x02), chunk('ANIM', [0, 0, 0, 0, 0, 0]), chunk('ANMF', Array(16).fill(0))), 'webp')).toBeNull()
    expect(imageSize(riff(vp8x(2, 2), chunk('ANMF', Array(16).fill(0))), 'webp')).toBeNull()
    expect(imageSize(riff(vp8l(1, 1), vp8l(16_384, 16_384)), 'webp')).toBeNull()
    expect(imageSize(riff(vp8x(2, 2)), 'webp')).toBeNull()
    const cut = riff(vp8l(2, 2)).subarray(0, 22)
    expect(imageSize(Buffer.concat([cut, Buffer.alloc(0)]), 'webp')).toBeNull()
  })
})

describe('PNG', () => {
  it('reads the size only from an IHDR chunk in first place', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from('IHDR'), 0, 0, 0, 7, 0, 0, 0, 5])
    expect(imageSize(png, 'png')).toEqual({ width: 7, height: 5 })
    const other = Buffer.from(png)
    other.write('tEXt', 12, 'latin1')
    expect(imageSize(other, 'png')).toBeNull()
  })
})
