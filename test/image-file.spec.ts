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
