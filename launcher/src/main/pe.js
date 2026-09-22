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

// ---------------------------------------------------------------------------
// LARGE ADDRESS AWARE — the community's "4 GB patch", on OUR copy only
// ---------------------------------------------------------------------------
// A 32-bit process gets a 2 GB user address space unless the image says it can
// cope with pointers above 0x7FFFFFFF. `IMAGE_FILE_LARGE_ADDRESS_AWARE` (0x0020)
// in `IMAGE_FILE_HEADER.Characteristics` says so, and on 64-bit Windows the
// loader then hands the process a 4 GB space. That is the whole of the "4 GB
// patch" every custom-map community ships: two bytes, no code.
//
// Why we need it: a big custom zone (ORBiT, UGX Requiem) stalls the CLIENT in
// CL_InitCGame at about 1.5 GB RSS — the 2 GB ceiling, arrived at with the
// allocator's own overhead on top (dedi.md §14.7). The server is fine; the
// client runs out of address space.
//
// Where it may be applied: `<ENW>\game\CoDWaW.exe`, our own junction-copy, and
// the agents' dev copies. NEVER the player's Steam install (dev-box.md rule 1) —
// that guard is `assertWritable()` in setup.js, not here; this file is the tool.
//
// The flag lives in the PE FILE HEADER, which SteamStub does not encrypt: the
// stub wraps `.text`, and the loader has to read the file header before the
// stub's entry point can run at all. That is the reasoning; setup.js's docs
// carry the MEASUREMENT, which is what actually decides it.
export const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020

// Where FileHeader.Characteristics is, and what it says. `null` when the file is
// not a PE we understand — same contract as read().
export function characteristics(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size < 0x400) return null
    const head = Buffer.alloc(Math.min(MAX_HEADER, size))
    fs.readSync(fd, head, 0, head.length, 0)
    if (head.readUInt16LE(0) !== 0x5a4d) return null
    const peOff = head.readUInt32LE(0x3c)
    if (peOff <= 0 || peOff + 0x18 > head.length) return null
    if (head.readUInt32LE(peOff) !== 0x00004550) return null
    const machine = head.readUInt16LE(peOff + 4)
    const offset = peOff + 22 // IMAGE_FILE_HEADER.Characteristics
    const value = head.readUInt16LE(offset)
    return { offset, value, machine, laa: (value & IMAGE_FILE_LARGE_ADDRESS_AWARE) !== 0 }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// Set or clear the flag, in place, two bytes. Idempotent: if the bit already has
// the value asked for, nothing is written at all and `changed` is false.
//
// It ALWAYS READS THE BYTES BACK off disk afterwards and fails loudly if they are
// not what was written — a half-applied patch to a game executable is not
// something to discover at launch.
export function setLargeAddressAware(file, on = true) {
  const before = characteristics(file)
  if (!before) return { ok: false, changed: false, reason: `${file} is not a PE file we can read` }
  if (before.machine !== 0x14c)
    return { ok: false, changed: false, reason: `${file} is not a 32-bit image (machine 0x${before.machine.toString(16)}); the LAA flag would be meaningless`, before }
  if (before.laa === !!on)
    return { ok: true, changed: false, reason: `already ${on ? 'large-address-aware' : 'not large-address-aware'}`, before, after: before, offset: before.offset }

  const want = on
    ? before.value | IMAGE_FILE_LARGE_ADDRESS_AWARE
    : before.value & ~IMAGE_FILE_LARGE_ADDRESS_AWARE

  let fd
  try {
    fd = fs.openSync(file, 'r+')
    const two = Buffer.alloc(2)
    two.writeUInt16LE(want & 0xffff, 0)
    fs.writeSync(fd, two, 0, 2, before.offset)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }

  const after = characteristics(file)
  if (!after || after.value !== (want & 0xffff))
    throw new Error(`Writing the large-address-aware flag to ${file} did not take: wanted 0x${(want & 0xffff).toString(16)}, the file reads 0x${(after?.value ?? -1).toString(16)}.`)

  return {
    ok: true,
    changed: true,
    offset: before.offset,
    before,
    after,
    reason: `Characteristics 0x${before.value.toString(16).padStart(4, '0')} -> 0x${after.value.toString(16).padStart(4, '0')} at file offset 0x${before.offset.toString(16)}`,
  }
}
