import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

function fail(message) {
  throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail(`Issue #23 reseal ${label} must be an absolute normalized path`)
  }
}

function requireDirectory(directoryPath, label) {
  requireAbsolutePath(directoryPath, label)
  let stat
  try {
    stat = lstatSync(directoryPath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (!stat.isDirectory()) fail(`Issue #23 reseal ${label} must be a directory`)
  return realpathSync(directoryPath)
}

function safeArchivePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function archiveEntryIsRegular(versionMadeBy, externalAttributes) {
  const hostSystem = versionMadeBy >>> 8
  if (hostSystem === 3 || hostSystem === 19) {
    const unixMode = externalAttributes >>> 16
    return (unixMode & 0o170000) === 0o100000
  }
  if (hostSystem === 0 || hostSystem === 10) {
    const dosAttributes = externalAttributes & 0xff
    return (dosAttributes & 0x18) === 0
  }
  return false
}

export function readArchiveEntries(archiveBytes) {
  try {
    const minimumEndOffset = Math.max(0, archiveBytes.length - 22 - 0xffff)
    let endOffset = -1
    for (
      let offset = archiveBytes.length - 22;
      offset >= minimumEndOffset;
      offset -= 1
    ) {
      if (archiveBytes.readUInt32LE(offset) === 0x06054b50) {
        const commentLength = archiveBytes.readUInt16LE(offset + 20)
        if (offset + 22 + commentLength === archiveBytes.length) {
          endOffset = offset
          break
        }
      }
    }
    if (endOffset === -1) {
      fail('Issue #23 reseal build archive has an invalid central directory')
    }

    const diskNumber = archiveBytes.readUInt16LE(endOffset + 4)
    const centralDirectoryDisk = archiveBytes.readUInt16LE(endOffset + 6)
    const entriesOnDisk = archiveBytes.readUInt16LE(endOffset + 8)
    const entryCount = archiveBytes.readUInt16LE(endOffset + 10)
    const centralDirectorySize = archiveBytes.readUInt32LE(endOffset + 12)
    const centralDirectoryOffset = archiveBytes.readUInt32LE(endOffset + 16)
    if (
      diskNumber !== 0
      || centralDirectoryDisk !== 0
      || entriesOnDisk !== entryCount
      || entryCount === 0xffff
      || centralDirectorySize === 0xffffffff
      || centralDirectoryOffset === 0xffffffff
      || centralDirectoryOffset + centralDirectorySize !== endOffset
    ) {
      fail('Issue #23 reseal build archive has an unsupported central directory')
    }

    const centralEntries = []
    let centralOffset = centralDirectoryOffset
    for (let index = 0; index < entryCount; index += 1) {
      if (
        centralOffset + 46 > endOffset
        || archiveBytes.readUInt32LE(centralOffset) !== 0x02014b50
      ) {
        fail('Issue #23 reseal build archive has an invalid central entry')
      }
      const versionMadeBy = archiveBytes.readUInt16LE(centralOffset + 4)
      const flags = archiveBytes.readUInt16LE(centralOffset + 8)
      const method = archiveBytes.readUInt16LE(centralOffset + 10)
      const compressedSize = archiveBytes.readUInt32LE(centralOffset + 20)
      const uncompressedSize = archiveBytes.readUInt32LE(centralOffset + 24)
      const nameLength = archiveBytes.readUInt16LE(centralOffset + 28)
      const extraLength = archiveBytes.readUInt16LE(centralOffset + 30)
      const commentLength = archiveBytes.readUInt16LE(centralOffset + 32)
      const diskStart = archiveBytes.readUInt16LE(centralOffset + 34)
      const externalAttributes = archiveBytes.readUInt32LE(centralOffset + 38)
      const localHeaderOffset = archiveBytes.readUInt32LE(centralOffset + 42)
      const nextCentralOffset = centralOffset
        + 46
        + nameLength
        + extraLength
        + commentLength
      if (
        nextCentralOffset > endOffset
        || diskStart !== 0
        || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff
        || localHeaderOffset === 0xffffffff
        || (flags & 0x41) !== 0
        || (method !== 0 && method !== 8)
      ) {
        fail('Issue #23 reseal build archive has an unsupported entry')
      }
      const nameBytes = archiveBytes.subarray(
        centralOffset + 46,
        centralOffset + 46 + nameLength,
      )
      const path = nameBytes.toString('utf8')
      if (!Buffer.from(path, 'utf8').equals(nameBytes) || !safeArchivePath(path)) {
        fail('Issue #23 reseal build archive has an unsafe entry path')
      }
      if (!archiveEntryIsRegular(versionMadeBy, externalAttributes)) {
        fail('Issue #23 reseal build archive entries must be regular files')
      }
      centralEntries.push({
        compressedSize,
        flags,
        localHeaderOffset,
        method,
        nameBytes,
        path,
        uncompressedSize,
      })
      centralOffset = nextCentralOffset
    }
    if (centralOffset !== endOffset) {
      fail('Issue #23 reseal build archive central directory size is inconsistent')
    }

    const archiveEntries = new Map()
    for (const entry of centralEntries) {
      if (archiveEntries.has(entry.path)) {
        fail('Issue #23 reseal build archive paths must be unique')
      }
      const localOffset = entry.localHeaderOffset
      if (
        localOffset + 30 > centralDirectoryOffset
        || archiveBytes.readUInt32LE(localOffset) !== 0x04034b50
      ) {
        fail('Issue #23 reseal build archive has an invalid local entry')
      }
      const localFlags = archiveBytes.readUInt16LE(localOffset + 6)
      const localMethod = archiveBytes.readUInt16LE(localOffset + 8)
      const localNameLength = archiveBytes.readUInt16LE(localOffset + 26)
      const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28)
      const localNameStart = localOffset + 30
      const dataOffset = localNameStart + localNameLength + localExtraLength
      const dataEnd = dataOffset + entry.compressedSize
      if (
        localFlags !== entry.flags
        || localMethod !== entry.method
        || dataEnd > centralDirectoryOffset
        || !archiveBytes
          .subarray(localNameStart, localNameStart + localNameLength)
          .equals(entry.nameBytes)
      ) {
        fail('Issue #23 reseal build archive local entry is inconsistent')
      }
      const compressed = archiveBytes.subarray(dataOffset, dataEnd)
      const bytes = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(entry.uncompressedSize, 1),
          })
      if (bytes.byteLength !== entry.uncompressedSize) {
        fail('Issue #23 reseal build archive entry size is inconsistent')
      }
      archiveEntries.set(entry.path, bytes)
    }
    return archiveEntries
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('Issue #23 reseal build archive')
    ) {
      throw error
    }
    fail('Issue #23 reseal build archive cannot be read safely')
  }
}

function readBuildDirectoryEntries(directoryPath) {
  const root = requireDirectory(directoryPath, 'upload source directory')
  const entries = new Map()
  const visit = (relativeDirectory = '') => {
    const directory = relativeDirectory ? join(root, relativeDirectory) : root
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const entryPath = join(directory, entry.name)
      const stat = lstatSync(entryPath)
      if (entry.isDirectory() && stat.isDirectory()) {
        visit(relativePath)
      } else if (entry.isFile() && stat.isFile()) {
        entries.set(relativePath, readFileSync(entryPath))
      } else {
        fail('Issue #23 reseal upload source directory must contain only regular files')
      }
    }
  }
  visit()
  return entries
}

export function verifyBuildDirectory({
  archivePath,
  directoryPath,
  expectedArchiveSha256,
}) {
  requireAbsolutePath(archivePath, 'build archive')
  if (!/^[a-f0-9]{64}$/.test(expectedArchiveSha256 || '')) {
    fail('Issue #23 reseal build archive SHA-256 is invalid')
  }
  const archiveStat = lstatSync(archivePath)
  if (!archiveStat.isFile()) fail('Issue #23 reseal build archive must be a regular file')
  const archiveBytes = readFileSync(archivePath)
  if (sha256(archiveBytes) !== expectedArchiveSha256) {
    fail('Issue #23 reseal package has a mismatched build archive SHA-256 binding')
  }
  const archiveEntries = readArchiveEntries(archiveBytes)
  const directoryEntries = readBuildDirectoryEntries(directoryPath)
  if (
    archiveEntries.size !== directoryEntries.size
    || [...archiveEntries].some(([path, bytes]) => (
      !directoryEntries.has(path) || !directoryEntries.get(path).equals(bytes)
    ))
  ) {
    fail('Issue #23 reseal upload source directory does not match the sealed build archive')
  }
  return {
    format: 'blogman-build-directory-proof/v1',
    state: 'matched',
    archive_sha256: expectedArchiveSha256,
    file_count: archiveEntries.size,
  }
}
