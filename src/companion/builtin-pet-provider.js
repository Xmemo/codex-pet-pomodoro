const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const companionPaths = require('./paths.js');

const STANDARD_ATLAS_WIDTH = 1536;
const MIN_ATLAS_HEIGHT = 1872;
const STANDARD_CELL_HEIGHT = 208;
const MAX_ATLAS_ROWS = 16;
const MAX_JSON_HEADER_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_ENTRY_SIZE = 64 * 1024 * 1024; // 64 MiB
const MAX_CACHED_MANIFEST_SIZE = 64 * 1024;

function validateWebPHeader(buffer, expectedFileSize = null) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) {
    return { valid: false, error: 'WebP buffer too small (minimum 30 bytes required)' };
  }

  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    return { valid: false, error: 'Invalid WebP header magic (expected RIFF...WEBP)' };
  }

  const riffDeclaredSize = buffer.readUInt32LE(4);
  const totalRiffSize = riffDeclaredSize + 8;

  if (expectedFileSize !== null && expectedFileSize !== undefined) {
    if (expectedFileSize < totalRiffSize) {
      return { valid: false, error: `WebP declared RIFF size (${totalRiffSize} bytes) exceeds expected file size (${expectedFileSize} bytes)` };
    }
  }

  const chunkType = buffer.toString('ascii', 12, 16);
  const chunkSize = buffer.readUInt32LE(16);
  let width = 0;
  let height = 0;

  if (chunkType === 'VP8L') {
    if (chunkSize < 5) {
      return { valid: false, error: `Invalid VP8L chunk payload size: ${chunkSize} (minimum 5 bytes required)` };
    }
    if (buffer[20] !== 0x2F) {
      return { valid: false, error: 'Invalid VP8L signature byte (expected 0x2F)' };
    }
    const val = buffer.readUInt32LE(21);
    width = (val & 0x3FFF) + 1;
    height = ((val >> 14) & 0x3FFF) + 1;
  } else if (chunkType === 'VP8X') {
    if (chunkSize < 10) {
      return { valid: false, error: `Invalid VP8X chunk payload size: ${chunkSize} (expected at least 10 bytes)` };
    }
    width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
    height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
  } else if (chunkType === 'VP8 ') {
    if (chunkSize < 10) {
      return { valid: false, error: `Invalid VP8 chunk payload size: ${chunkSize} (minimum 10 bytes required)` };
    }
    if (buffer[23] !== 0x9D || buffer[24] !== 0x01 || buffer[25] !== 0x2A) {
      return { valid: false, error: 'Invalid VP8 frame start code' };
    }
    width = buffer.readUInt16LE(26) & 0x3FFF;
    height = buffer.readUInt16LE(28) & 0x3FFF;
  } else {
    return { valid: false, error: `Unsupported WebP chunk type: "${chunkType}"` };
  }

  if (width !== STANDARD_ATLAS_WIDTH) {
    return { valid: false, error: `WebP atlas width must be ${STANDARD_ATLAS_WIDTH}, got ${width}` };
  }
  if (height < MIN_ATLAS_HEIGHT) {
    return { valid: false, error: `WebP atlas height must be >= ${MIN_ATLAS_HEIGHT}, got ${height}` };
  }
  if (height % STANDARD_CELL_HEIGHT !== 0) {
    return { valid: false, error: `WebP atlas height must be divisible by ${STANDARD_CELL_HEIGHT}, got ${height}` };
  }
  const rows = height / STANDARD_CELL_HEIGHT;
  if (rows > MAX_ATLAS_ROWS) {
    return { valid: false, error: `WebP atlas rows must not exceed ${MAX_ATLAS_ROWS}, got ${rows}` };
  }

  return { valid: true, width, height, chunkType, totalRiffSize };
}

function parseAsarHeader(asarPath, fsMod = fs) {
  let fd;
  try {
    if (!fsMod.existsSync(asarPath)) {
      return { valid: false, error: `ASAR file not found: ${asarPath}` };
    }
    const stat = fsMod.statSync(asarPath);
    if (!stat.isFile() || stat.size < 16) {
      return { valid: false, error: 'ASAR file too small or not a regular file' };
    }

    fd = fsMod.openSync(asarPath, 'r');
    const headerBuf = Buffer.alloc(16);
    const bytesRead = fsMod.readSync(fd, headerBuf, 0, 16, 0);
    if (bytesRead < 16) {
      return { valid: false, error: 'Failed to read ASAR header bytes' };
    }

    const u32SizeHeader = headerBuf.readUInt32LE(0);
    if (u32SizeHeader !== 4) {
      return { valid: false, error: `Invalid ASAR header size indicator: expected 4, got ${u32SizeHeader}` };
    }

    const headerSize = headerBuf.readUInt32LE(4);
    const headerPayloadSize = headerBuf.readUInt32LE(8);
    const jsonStringSize = headerBuf.readUInt32LE(12);

    if (headerPayloadSize !== headerSize - 4) {
      return { valid: false, error: `Invalid ASAR header payload size: expected ${headerSize - 4}, got ${headerPayloadSize}` };
    }

    if (jsonStringSize > headerPayloadSize - 4 || jsonStringSize > MAX_JSON_HEADER_SIZE) {
      return { valid: false, error: `Invalid ASAR JSON size: ${jsonStringSize}` };
    }

    const headerOffset = 8 + headerSize;
    if (headerOffset > stat.size) {
      return { valid: false, error: 'ASAR header offset exceeds file size' };
    }

    const jsonBuf = Buffer.alloc(jsonStringSize);
    const jsonBytesRead = fsMod.readSync(fd, jsonBuf, 0, jsonStringSize, 16);
    if (jsonBytesRead < jsonStringSize) {
      return { valid: false, error: 'Failed to read ASAR header JSON' };
    }

    const jsonStr = jsonBuf.toString('utf8');
    const json = JSON.parse(jsonStr);
    return { valid: true, headerOffset, json, asarFileSize: stat.size };
  } catch (err) {
    return { valid: false, error: `Failed to parse ASAR header: ${err.message}` };
  } finally {
    if (fd !== undefined) {
      try { fsMod.closeSync(fd); } catch (_) {}
    }
  }
}

function findBuiltinPetEntry(headerJson, petId, asarFileSize, headerOffset) {
  try {
    const assetsDir = headerJson?.files?.webview?.files?.assets?.files;
    if (!assetsDir || typeof assetsDir !== 'object') {
      return { found: false, error: 'No webview/assets directory found in ASAR header' };
    }

    const prefix = `${petId}-spritesheet-`;
    const matches = Object.keys(assetsDir).filter(filename =>
      filename.startsWith(prefix) && filename.endsWith('.webp')
    );

    if (matches.length === 0) {
      return { found: false, error: `No built-in entry matching "${prefix}*.webp" under webview/assets` };
    }
    if (matches.length > 1) {
      return { found: false, error: `Multiple built-in entries found for pet "${petId}": ${matches.join(', ')}` };
    }

    const filename = matches[0];
    const entry = assetsDir[filename];
    if (!entry || typeof entry !== 'object') {
      return { found: false, error: `Invalid ASAR entry node for ${filename}` };
    }

    const size = Number(entry.size);
    if (isNaN(size) || size <= 0 || !Number.isInteger(size)) {
      return { found: false, error: `Invalid entry size for ${filename}: ${entry.size}` };
    }

    if (size > MAX_ENTRY_SIZE) {
      return { found: false, error: `Entry ${filename} size (${size} bytes) exceeds maximum limit of 64 MiB` };
    }

    let offset;
    try {
      offset = BigInt(entry.offset);
    } catch (_) {
      return { found: false, error: `Invalid entry offset for ${filename}: ${entry.offset}` };
    }

    if (offset < 0n) {
      return { found: false, error: `Negative entry offset for ${filename}` };
    }

    const totalOffset = BigInt(headerOffset) + offset;
    const endOffset = totalOffset + BigInt(size);
    const maxSafeInt = BigInt(Number.MAX_SAFE_INTEGER);

    if (endOffset > maxSafeInt) {
      return { found: false, error: `Unsafe numeric offset above MAX_SAFE_INTEGER for ${filename}` };
    }

    if (endOffset > BigInt(asarFileSize)) {
      return { found: false, error: `Entry ${filename} bounds [${totalOffset}, ${endOffset}] exceed ASAR file size ${asarFileSize}` };
    }

    return { found: true, filename, offset, size };
  } catch (err) {
    return { found: false, error: `Failed to search ASAR entries: ${err.message}` };
  }
}

function readAsarEntryBytes(asarPath, headerOffset, offset, size, fsMod = fs) {
  let fd;
  try {
    fd = fsMod.openSync(asarPath, 'r');
    const buf = Buffer.alloc(size);
    const startPos = Number(BigInt(headerOffset) + BigInt(offset));
    const bytesRead = fsMod.readSync(fd, buf, 0, size, startPos);
    if (bytesRead < size) {
      throw new Error(`Expected ${size} bytes, got ${bytesRead}`);
    }
    return buf;
  } finally {
    if (fd !== undefined) {
      try { fsMod.closeSync(fd); } catch (_) {}
    }
  }
}

function locateAppAsar(deps = {}) {
  const fsMod = deps.fs || fs;
  const home = deps.home || companionPaths.HOME;

  if (deps.appAsarPath !== undefined) {
    if (deps.appAsarPath && fsMod.existsSync(deps.appAsarPath)) {
      return deps.appAsarPath;
    }
    return null;
  }
  if (process.env.CODEX_APP_ASAR_PATH) {
    if (fsMod.existsSync(process.env.CODEX_APP_ASAR_PATH)) {
      return process.env.CODEX_APP_ASAR_PATH;
    }
    return null;
  }

  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/app.asar',
    '/Applications/Codex.app/Contents/Resources/app.asar',
    path.join(home, 'Applications/ChatGPT.app/Contents/Resources/app.asar'),
    path.join(home, 'Applications/Codex.app/Contents/Resources/app.asar'),
  ];

  for (const cand of candidates) {
    try {
      if (fsMod.existsSync(cand) && fsMod.statSync(cand).isFile()) {
        return cand;
      }
    } catch (_) {}
  }
  return null;
}

function isCacheValid(cacheDir, cachedWebpPath, cachedPetJsonPath, expectedSize, expectedPetId, fsMod = fs) {
  try {
    if (!fsMod.existsSync(cacheDir) || !fsMod.existsSync(cachedWebpPath) || !fsMod.existsSync(cachedPetJsonPath)) {
      return false;
    }

    const dirStat = fsMod.statSync(cacheDir);
    const webpStat = fsMod.statSync(cachedWebpPath);
    const jsonStat = fsMod.statSync(cachedPetJsonPath);

    if (webpStat.size !== expectedSize) {
      return false;
    }
    if (jsonStat.size <= 0 || jsonStat.size > MAX_CACHED_MANIFEST_SIZE) return false;

    const webpBuf = fsMod.readFileSync(cachedWebpPath);
    const webpVal = validateWebPHeader(webpBuf, webpBuf.length);
    if (!webpVal.valid) {
      return false;
    }

    const jsonStr = fsMod.readFileSync(cachedPetJsonPath, 'utf8');
    const jsonObj = JSON.parse(jsonStr);
    if (!jsonObj || typeof jsonObj !== 'object') {
      return false;
    }
    if (jsonObj.id !== expectedPetId || jsonObj.spritesheetPath !== 'spritesheet.webp') {
      return false;
    }

    const actualDigest = crypto.createHash('sha256').update(webpBuf).digest('hex');
    if (!jsonObj.sha256 || jsonObj.sha256 !== actualDigest) {
      return false;
    }

    // Only call chmodSync if permission bits actually differ from 0700/0600 to avoid ctime mutations on valid hits
    try {
      if (fsMod.chmodSync) {
        if ((dirStat.mode & 0o777) !== 0o700) {
          fsMod.chmodSync(cacheDir, 0o700);
        }
        if ((webpStat.mode & 0o777) !== 0o600) {
          fsMod.chmodSync(cachedWebpPath, 0o600);
        }
        if ((jsonStat.mode & 0o777) !== 0o600) {
          fsMod.chmodSync(cachedPetJsonPath, 0o600);
        }
      }
    } catch (_) {}

    return true;
  } catch (_) {
    return false;
  }
}

function resolveBuiltinPet(petId, deps = {}) {
  const fsMod = deps.fs || fs;
  const paths = deps.paths || companionPaths;

  const asarPath = locateAppAsar(deps);
  if (!asarPath) {
    return { available: false, error: `ChatGPT/Codex application package not found for pet "${petId}"` };
  }

  const headerRes = parseAsarHeader(asarPath, fsMod);
  if (!headerRes.valid) {
    return { available: false, error: headerRes.error };
  }

  const entryRes = findBuiltinPetEntry(headerRes.json, petId, headerRes.asarFileSize, headerRes.headerOffset);
  if (!entryRes.found) {
    return { available: false, error: entryRes.error };
  }

  let asarStat;
  try {
    asarStat = fsMod.statSync(asarPath);
  } catch (err) {
    return { available: false, error: `Failed to stat ASAR file: ${err.message}` };
  }

  const keyString = `${asarStat.size}:${asarStat.mtimeMs}:${entryRes.filename}:${entryRes.offset}:${entryRes.size}:${petId}`;
  const hash = crypto.createHash('sha256').update(keyString).digest('hex').substring(0, 16);

  const cacheBase = paths.COMPANION_BUILTIN_CACHE_PATH || path.join(paths.COMPANION_BUILD_PATH, 'builtin-cache');
  const cacheDir = path.join(cacheBase, `${petId}-${hash}`);
  const cachedWebpPath = path.join(cacheDir, 'spritesheet.webp');
  const cachedPetJsonPath = path.join(cacheDir, 'pet.json');

  if (isCacheValid(cacheDir, cachedWebpPath, cachedPetJsonPath, entryRes.size, petId, fsMod)) {
    return {
      available: true,
      petDir: cacheDir,
      spritesheetFullPath: cachedWebpPath,
      provider: 'builtin',
      cacheStatus: 'hit',
      cacheKey: hash,
      error: null,
    };
  }

  // Cache miss or corrupt cache: extract entry and write cache atomically
  let tmpCacheDir = null;
  try {
    const bytes = readAsarEntryBytes(asarPath, headerRes.headerOffset, entryRes.offset, entryRes.size, fsMod);

    const webpVal = validateWebPHeader(bytes, bytes.length);
    if (!webpVal.valid) {
      return { available: false, error: `Invalid built-in WebP atlas: ${webpVal.error}` };
    }

    if (!fsMod.existsSync(cacheBase)) {
      fsMod.mkdirSync(cacheBase, { recursive: true, mode: 0o700 });
      try { fsMod.chmodSync(cacheBase, 0o700); } catch (_) {}
    }

    tmpCacheDir = path.join(cacheBase, `.tmp-${petId}-${hash}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fsMod.mkdirSync(tmpCacheDir, { recursive: true, mode: 0o700 });

    fsMod.writeFileSync(path.join(tmpCacheDir, 'spritesheet.webp'), bytes, { mode: 0o600 });

    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const petJsonObj = {
      id: petId,
      displayName: petId,
      description: `Built-in pet ${petId}`,
      spritesheetPath: 'spritesheet.webp',
      sha256: digest,
    };
    fsMod.writeFileSync(path.join(tmpCacheDir, 'pet.json'), JSON.stringify(petJsonObj, null, 2) + '\n', { mode: 0o600 });

    try {
      fsMod.chmodSync(tmpCacheDir, 0o700);
      fsMod.chmodSync(path.join(tmpCacheDir, 'spritesheet.webp'), 0o600);
      fsMod.chmodSync(path.join(tmpCacheDir, 'pet.json'), 0o600);
    } catch (_) {}

    if (fsMod.existsSync(cacheDir)) {
      if (isCacheValid(cacheDir, cachedWebpPath, cachedPetJsonPath, entryRes.size, petId, fsMod)) {
        try { fsMod.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch (_) {}
        return {
          available: true,
          petDir: cacheDir,
          spritesheetFullPath: cachedWebpPath,
          provider: 'builtin',
          cacheStatus: 'hit',
          cacheKey: hash,
          error: null,
        };
      }
      fsMod.rmSync(cacheDir, { recursive: true, force: true });
    }

    try {
      fsMod.renameSync(tmpCacheDir, cacheDir);
    } catch (renameErr) {
      if (isCacheValid(cacheDir, cachedWebpPath, cachedPetJsonPath, entryRes.size, petId, fsMod)) {
        try { fsMod.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch (_) {}
        return {
          available: true,
          petDir: cacheDir,
          spritesheetFullPath: cachedWebpPath,
          provider: 'builtin',
          cacheStatus: 'hit',
          cacheKey: hash,
          error: null,
        };
      }
      try { fsMod.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch (_) {}
      return { available: false, error: `Failed to rename cache directory: ${renameErr.message}` };
    }

    try { fsMod.chmodSync(cacheDir, 0o700); } catch (_) {}

    return {
      available: true,
      petDir: cacheDir,
      spritesheetFullPath: cachedWebpPath,
      provider: 'builtin',
      cacheStatus: 'miss',
      cacheKey: hash,
      error: null,
    };
  } catch (err) {
    if (tmpCacheDir && fsMod.existsSync(tmpCacheDir)) {
      try { fsMod.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch (_) {}
    }
    return { available: false, error: `Failed to extract built-in pet entry: ${err.message}` };
  }
}

module.exports = {
  validateWebPHeader,
  parseAsarHeader,
  findBuiltinPetEntry,
  readAsarEntryBytes,
  locateAppAsar,
  isCacheValid,
  resolveBuiltinPet,
  MAX_ENTRY_SIZE,
};
