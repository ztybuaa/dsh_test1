import { inflateSync } from 'node:zlib'

/**
 * Reading a PNG for itself: dimensions, colours, and individual pixels.
 *
 * It is deliberately a second implementation of "what is in these bytes": the claims
 * made with it are about what was really *displayed*, and asking the code under test
 * whether it displayed the right thing would not check anything.
 *
 * **Shared, not copied.** T5's screenshot test and T8's overlay test both need to parse
 * a PNG they obtained themselves, and a decoder that gets copied is a decoder that
 * drifts: the repo already paid for that lesson once with `removeWhenFree` (T7 wrote its
 * own `rmSync` and reproduced a bug T5 had fixed — see
 * `docs/research/suite-flake-two-signatures.md`). One implementation, two callers.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** What a PNG says about itself, as read here rather than by the implementation. */
export interface PngFacts {
  /** Width in encoded pixels. */
  width: number
  /** Height in encoded pixels. */
  height: number
  /** Bits per channel, from IHDR. */
  bitDepth: number
  /** PNG colour type, from IHDR (6 = RGBA, 2 = RGB). */
  colorType: number
  /** Every distinct RGB triple among the decoded pixels. */
  colors: Set<string>
  /** The `"r,g,b"` triple at one pixel, or undefined outside the image. */
  rgbAt: (x: number, y: number) => string | undefined
  /** How many pixels carry one `"r,g,b"` triple. */
  countOf: (rgb: string) => number
  /**
   * Compare two images pixel by pixel: how many pixels differ, and where the differences
   * are. `box` is null when nothing differs — which is the strongest form of "this
   * changed nothing on screen".
   */
  diffFrom: (other: PngFacts) => {
    /** How many pixels differ. */
    changed: number
    /** Where they are, inclusive, or null when nothing differs. */
    box: { left: number; top: number; right: number; bottom: number } | null
    /** How many pixels were compared. */
    total: number
  }
}

/** The Paeth predictor, as the PNG specification defines it. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Undo one scanline's filter in place, given the reconstructed row above it. */
function unfilter(row: Buffer, previous: Buffer, filter: number, bpp: number): void {
  for (let index = 0; index < row.length; index++) {
    const left = index >= bpp ? row[index - bpp] : 0
    const up = previous[index] ?? 0
    const upLeft = index >= bpp ? (previous[index - bpp] ?? 0) : 0
    let value = row[index]
    if (filter === 1) value += left
    else if (filter === 2) value += up
    else if (filter === 3) value += Math.floor((left + up) / 2)
    else if (filter === 4) value += paeth(left, up, upLeft)
    row[index] = value & 0xff
  }
}

/**
 * Read a PNG for itself: signature, IHDR, and every decoded pixel.
 *
 * @param bytes - the file or attachment bytes.
 * @returns the image's dimensions, its distinct colours, and pixel access.
 */
export function readPng(bytes: Buffer): PngFacts {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: the 8-byte signature is missing')
  }
  let offset = 8
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined
  const data: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        bitDepth: chunk[8],
        colorType: chunk[9],
        interlace: chunk[12],
      }
    } else if (type === 'IDAT') {
      data.push(Buffer.from(chunk))
    }
    offset += 12 + length
    if (type === 'IEND') break
  }
  if (header === undefined) throw new Error('the PNG has no IHDR chunk')

  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0
  const colors = new Set<string>()
  const rows: Buffer[] = []
  if (channels !== 0 && header.bitDepth === 8 && header.interlace === 0) {
    const raw = inflateSync(Buffer.concat(data))
    const stride = header.width * channels
    let previous = Buffer.alloc(stride)
    let cursor = 0
    for (let y = 0; y < header.height && cursor < raw.length; y++) {
      const filter = raw[cursor]
      cursor += 1
      const row = Buffer.from(raw.subarray(cursor, cursor + stride))
      cursor += stride
      unfilter(row, previous, filter, channels)
      for (let x = 0; x < header.width; x++) {
        const at = x * channels
        colors.add(`${row[at]},${row[at + 1]},${row[at + 2]}`)
      }
      rows.push(row)
      previous = row
    }
  }

  const width = header.width
  const rgbAt = (x: number, y: number): string | undefined => {
    const row = rows[y]
    if (row === undefined || x < 0 || x >= width) return undefined
    const at = x * channels
    return `${row[at]},${row[at + 1]},${row[at + 2]}`
  }

  const countOf = (rgb: string): number => {
    let seen = 0
    for (const row of rows) {
      for (let x = 0; x < width; x++) {
        const at = x * channels
        if (`${row[at]},${row[at + 1]},${row[at + 2]}` === rgb) seen += 1
      }
    }
    return seen
  }

  const diffFrom = (other: PngFacts): ReturnType<PngFacts['diffFrom']> => {
    if (other.width !== width || other.height !== header.height) {
      throw new Error(`cannot compare a ${String(width)}x${String(header.height)} image with a ${String(other.width)}x${String(other.height)} one`)
    }
    let changed = 0
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = -1
    let bottom = -1
    for (let y = 0; y < rows.length; y++) {
      const mine = rows[y]
      for (let x = 0; x < width; x++) {
        if (rgbAt(x, y) === other.rgbAt(x, y)) continue
        changed += 1
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
      void mine
    }
    return {
      changed,
      box: changed === 0 ? null : { left, top, right, bottom },
      total: width * rows.length,
    }
  }

  return { width, height: header.height, bitDepth: header.bitDepth, colorType: header.colorType, colors, rgbAt, countOf, diffFrom }
}
