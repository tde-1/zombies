// Just enough PE reading to answer three questions about a CoDWaW.exe, without
// shelling out and without a dependency:
//
//   1. Is it a 32-bit Windows executable at all?  (machine, magic)
//   2. Does it have a `.bind` section?             -> SteamStub, i.e. the Steam build
//                                                     (docs/kickstart/foundation.md §4)
//   3. What does its VS_FIXEDFILEINFO say?         -> the 1.7 check
//
// Everything is bounds-checked: this parses a file a stranger chose with a Browse
// button, so a malformed header must produce `null`, never a throw or a huge read.
import fs from 'node:fs'

const MAX_HEADER = 4096

export function read(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size < 0x400) return null

    const head = Buffer.alloc(Math.min(MAX_HEADER, size))
    fs.readSync(fd, head, 0, head.length, 0)
    if (head.readUInt16LE(0) !== 0x5a4d) return null // MZ
    const peOff = head.readUInt32LE(0x3c)
    if (peOff <= 0 || peOff + 0xf8 > head.length) return null
    if (head.readUInt32LE(peOff) !== 0x00004550) return null // PE\0\0

    const machine = head.readUInt16LE(peOff + 4)
    const numSections = head.readUInt16LE(peOff + 6)
    const optSize = head.readUInt16LE(peOff + 20)
    const optOff = peOff + 24
    const magic = head.readUInt16LE(optOff)
    const pe32 = magic === 0x10b
    const imageBase = pe32 ? head.readUInt32LE(optOff + 28) : Number(head.readBigUInt64LE(optOff + 24))
    const dataDirOff = optOff + (pe32 ? 96 : 112)
    const numDirs = head.readUInt32LE(optOff + (pe32 ? 92 : 108))

    const dirs = []
    for (let i = 0; i < Math.min(numDirs, 16); i++) {
      const o = dataDirOff + i * 8
      if (o + 8 > head.length) break
      dirs.push({ rva: head.readUInt32LE(o), size: head.readUInt32LE(o + 4) })
    }

    const secOff = optOff + optSize
    const sections = []
    for (let i = 0; i < Math.min(numSections, 96); i++) {
      const o = secOff + i * 40
      if (o + 40 > head.length) break
      sections.push({
        name: head.toString('latin1', o, o + 8).replace(/\0+$/, ''),
        vsize: head.readUInt32LE(o + 8),
        rva: head.readUInt32LE(o + 12),
        rawSize: head.readUInt32LE(o + 16),
        rawPtr: head.readUInt32LE(o + 20),
        characteristics: head.readUInt32LE(o + 36),
      })
    }

    const rvaToOff = (rva) => {
      for (const s of sections) {
        if (rva >= s.rva && rva < s.rva + Math.max(s.vsize, s.rawSize)) {
          const off = s.rawPtr + (rva - s.rva)
          return off < size ? off : null
        }
      }
      return null
    }

    const version = readVersion(fd, size, dirs[2], rvaToOff)

    return {
      size,
      machine, // 0x14c = i386
      pe32,
      imageBase,
      sections: sections.map((s) => s.name),
      hasBind: sections.some((s) => s.name === '.bind'),
      version,
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// Walk the resource directory to RT_VERSION (16) -> first id -> first lang, then find
// the VS_FIXEDFILEINFO signature 0xFEEF04BD inside it.
function readVersion(fd, size, resDir, rvaToOff) {
  if (!resDir || !resDir.rva || !resDir.size || resDir.size > 8 * 1024 * 1024) return null
  const base = rvaToOff(resDir.rva)
  if (base === null) return null
  const len = Math.min(resDir.size, size - base)
  if (len < 16) return null
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, base)

  // Instead of a full three-level walk (which each vendor lays out slightly
  // differently), scan the resource blob for the fixed signature. It is unique,
  // 4-byte aligned, and this cannot run off the end.
  for (let i = 0; i + 52 <= buf.length; i += 4) {
    if (buf.readUInt32LE(i) !== 0xfeef04bd) continue
    const ms = buf.readUInt32LE(i + 8)
    const ls = buf.readUInt32LE(i + 12)
    const pms = buf.readUInt32LE(i + 16)
    const pls = buf.readUInt32LE(i + 20)
    const q = (hi, lo) => [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff]
    return {
      file: q(ms, ls),
      product: q(pms, pls),
      fileString: q(ms, ls).join('.'),
      productString: q(pms, pls).join('.'),
    }
  }
  return null
}

// "1.7" the way a player would say it: the first two components of either version.
export function isVersion17(version) {
  if (!version) return false
  for (const v of [version.file, version.product]) {
    if (v && v[0] === 1 && v[1] === 7) return true
  }
  return false
}
