const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  validateWebPHeader,
  parseAsarHeader,
  findBuiltinPetEntry,
  readAsarEntryBytes,
  locateAppAsar,
  isCacheValid,
  resolveBuiltinPet,
  MAX_ENTRY_SIZE,
} = require('../src/companion/builtin-pet-provider.js');

const { resolvePetId, parsePetManifest } = require('../src/companion/manifest-loader.js');
const companionPaths = require('../src/companion/paths.js');
const statusMod = require('../src/companion/status.js');
const workerLifecycle = require('../src/companion/worker-lifecycle.js');

function createSyntheticVP8LWebP(width, height, extraBytesLength = 100) {
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  const bits = (wMinus1 & 0x3FFF) | ((hMinus1 & 0x3FFF) << 14);

  const chunkPayloadSize = 5 + extraBytesLength;
  const totalFileSize = 12 + 8 + chunkPayloadSize;

  const buf = Buffer.alloc(totalFileSize);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(totalFileSize - 8, 4);
  buf.write('WEBP', 8, 4, 'ascii');
  buf.write('VP8L', 12, 4, 'ascii');
  buf.writeUInt32LE(chunkPayloadSize, 16);
  buf[20] = 0x2F;
  buf.writeUInt32LE(bits, 21);
  return buf;
}

function createSyntheticVP8XWebP(width, height, extraBytesLength = 100) {
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;

  const chunkPayloadSize = 10 + extraBytesLength;
  const totalFileSize = 12 + 8 + chunkPayloadSize;

  const buf = Buffer.alloc(totalFileSize);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(totalFileSize - 8, 4);
  buf.write('WEBP', 8, 4, 'ascii');
  buf.write('VP8X', 12, 4, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x10; // Has Alpha
  buf[24] = wMinus1 & 0xFF;
  buf[25] = (wMinus1 >> 8) & 0xFF;
  buf[26] = (wMinus1 >> 16) & 0xFF;
  buf[27] = hMinus1 & 0xFF;
  buf[28] = (hMinus1 >> 8) & 0xFF;
  buf[29] = (hMinus1 >> 16) & 0xFF;
  return buf;
}

function createSyntheticAsarBuffer(filesObj) {
  const filesTree = {};
  const payloadBuffers = [];
  let currentOffset = 0n;

  for (const [filePath, contentBuf] of Object.entries(filesObj)) {
    const parts = filePath.split('/');
    let current = filesTree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = { files: {} };
      }
      current = current[part].files;
    }
    const filename = parts[parts.length - 1];
    current[filename] = {
      size: contentBuf.length,
      offset: currentOffset.toString(),
    };
    payloadBuffers.push(contentBuf);
    currentOffset += BigInt(contentBuf.length);
  }

  const jsonObj = { files: filesTree };
  const jsonString = JSON.stringify(jsonObj);
  const jsonBuf = Buffer.from(jsonString, 'utf8');
  const jsonSize = jsonBuf.length;

  const headerSize = 8 + jsonSize;
  const headerPayloadSize = 4 + jsonSize;

  const headerBuf = Buffer.alloc(16 + jsonSize);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerSize, 4);
  headerBuf.writeUInt32LE(headerPayloadSize, 8);
  headerBuf.writeUInt32LE(jsonSize, 12);
  jsonBuf.copy(headerBuf, 16);

  return Buffer.concat([headerBuf, ...payloadBuffers]);
}

test('WebP header parser & atlas dimensions validation', async (t) => {
  await t.test('accepts valid 1536x2288 VP8L and VP8X synthetic atlas headers', () => {
    const vp8l = createSyntheticVP8LWebP(1536, 2288);
    const valL = validateWebPHeader(vp8l, vp8l.length);
    assert.strictEqual(valL.valid, true);
    assert.strictEqual(valL.width, 1536);
    assert.strictEqual(valL.height, 2288);
    assert.strictEqual(valL.chunkType, 'VP8L');

    const vp8x = createSyntheticVP8XWebP(1536, 2288);
    const valX = validateWebPHeader(vp8x, vp8x.length);
    assert.strictEqual(valX.valid, true);
    assert.strictEqual(valX.width, 1536);
    assert.strictEqual(valX.height, 2288);
    assert.strictEqual(valX.chunkType, 'VP8X');
  });

  await t.test('validates RIFF declared size vs expected file size and chunk payload size', () => {
    const vp8l = createSyntheticVP8LWebP(1536, 2288);
    const valTrunc = validateWebPHeader(vp8l, vp8l.length - 10);
    assert.strictEqual(valTrunc.valid, false);
    assert.ok(valTrunc.error.includes('exceeds expected file size'));

    const vp8lCorruptChunk = Buffer.from(vp8l);
    vp8lCorruptChunk.writeUInt32LE(2, 16);
    const valChunk = validateWebPHeader(vp8lCorruptChunk, vp8lCorruptChunk.length);
    assert.strictEqual(valChunk.valid, false);
    assert.ok(valChunk.error.includes('minimum 5 bytes required'));
  });

  await t.test('rejects wrong width, height, or non-divisible height', () => {
    const wrongW = createSyntheticVP8LWebP(1000, 2288);
    const valW = validateWebPHeader(wrongW);
    assert.strictEqual(valW.valid, false);
    assert.ok(valW.error.includes('width must be 1536'));

    const smallH = createSyntheticVP8LWebP(1536, 1000);
    const valSmallH = validateWebPHeader(smallH);
    assert.strictEqual(valSmallH.valid, false);
    assert.ok(valSmallH.error.includes('height must be >= 1872'));

    const nonDivH = createSyntheticVP8LWebP(1536, 2000);
    const valNonDivH = validateWebPHeader(nonDivH);
    assert.strictEqual(valNonDivH.valid, false);
    assert.ok(valNonDivH.error.includes('divisible by 208'));

    const corrupt = Buffer.from('NOT_A_WEBP_HEADER_DATA_1234567890');
    const valCorrupt = validateWebPHeader(corrupt);
    assert.strictEqual(valCorrupt.valid, false);
    assert.ok(valCorrupt.error.includes('Invalid WebP header magic'));
  });
});

test('ASAR bounds & unsafe numeric offset checks', async (t) => {
  await t.test('rejects entry size exceeding MAX_ENTRY_SIZE', () => {
    const json = {
      files: {
        webview: {
          files: {
            assets: {
              files: {
                'cat-spritesheet-1.webp': { size: MAX_ENTRY_SIZE + 1, offset: '0' },
              },
            },
          },
        },
      },
    };

    const res = findBuiltinPetEntry(json, 'cat', 1000000000, 100);
    assert.strictEqual(res.found, false);
    assert.ok(res.error.includes('exceeds maximum limit of 64 MiB'));
  });

  await t.test('accepts entry at exact MAX_ENTRY_SIZE bound', () => {
    const json = {
      files: {
        webview: {
          files: {
            assets: {
              files: {
                'boundcat-spritesheet-1.webp': { size: MAX_ENTRY_SIZE, offset: '0' },
              },
            },
          },
        },
      },
    };

    const res = findBuiltinPetEntry(json, 'boundcat', BigInt(MAX_ENTRY_SIZE) + 1000n, 100);
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.size, MAX_ENTRY_SIZE);
  });

  await t.test('rejects unsafe numeric offsets above Number.MAX_SAFE_INTEGER', () => {
    const unsafeOffsetStr = String(BigInt(Number.MAX_SAFE_INTEGER) + 100n);
    const json = {
      files: {
        webview: {
          files: {
            assets: {
              files: {
                'dog-spritesheet-1.webp': { size: 1000, offset: unsafeOffsetStr },
              },
            },
          },
        },
      },
    };

    const res = findBuiltinPetEntry(json, 'dog', BigInt(Number.MAX_SAFE_INTEGER) * 2n, 100);
    assert.strictEqual(res.found, false);
    assert.ok(res.error.includes('MAX_SAFE_INTEGER'));
  });
});

test('built-in pets resolve hashed WebP names through the app-initial asset map', async (t) => {
  await t.test('maps the pet id to a bounded ASAR WebP entry and extracts it', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashed-pet-test-'));
    try {
      const atlas = createSyntheticVP8LWebP(1536, 2288);
      const bundle = Buffer.from(
        'var J7i;function getRocky(){return J7i??(J7i=new URL(`rockyhash.webp`,import.meta.url).href)};var pets={rocky:J7i};',
        'utf8'
      );
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, createSyntheticAsarBuffer({
        'webview/assets/rockyhash.webp': atlas,
        'webview/assets/app-initial-abcd1234.js': bundle,
      }));

      const res = resolveBuiltinPet('rocky', {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      });

      assert.strictEqual(res.available, true, res.error);
      assert.deepStrictEqual(fs.readFileSync(res.spritesheetFullPath), atlas);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(res.petDir, 'pet.json'), 'utf8')).id, 'rocky');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('rejects unsafe and ambiguous bundle mappings', () => {
    const assets = {
      files: {
        webview: { files: { assets: { files: {
          'first.webp': { size: 400, offset: '0' },
          'second.webp': { size: 400, offset: '400' },
        } } } },
      },
    };
    const unsafe = findBuiltinPetEntry(
      assets, 'rocky', 1000, 100,
      'var X;var pets={rocky:X};X=new URL(`../outside.webp`,import.meta.url).href;'
    );
    assert.strictEqual(unsafe.found, false);
    assert.match(unsafe.error, /Unsafe built-in asset filename/);

    const ambiguous = findBuiltinPetEntry(
      assets, 'rocky', 1000, 100,
      'var A,B;var pets={rocky:A,rocky:B};A=new URL(`first.webp`,import.meta.url).href;B=new URL(`second.webp`,import.meta.url).href;'
    );
    assert.strictEqual(ambiguous.found, false);
    assert.match(ambiguous.error, /Multiple hashed WebP assets/);
  });

  await t.test('fails closed when the bundle has no pet asset mapping', () => {
    const json = {
      files: {
        webview: {
          files: {
            assets: {
              files: {
                'unrelated.webp': { size: 400, offset: '0' },
              },
            },
          },
        },
      },
    };
    const res = findBuiltinPetEntry(
      json,
      'rocky', 1000, 100, 'var pets={other:X};X=new URL(`unrelated.webp`,import.meta.url).href;'
    );
    assert.strictEqual(res.found, false);
    assert.match(res.error, /No pet-to-asset mapping for "rocky"/);
  });
});

test('Cache permissions, permission correction, hit mtime/ctime preservation, corrupt cache digest rebuild, and tmp cleanup', async (t) => {
  await t.test('cache files are 0600 and directories 0700', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/permcat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const mockBuildPath = path.join(tempDir, 'companion-build');
      const mockCachePath = path.join(mockBuildPath, 'builtin-cache');

      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: mockBuildPath,
          COMPANION_BUILTIN_CACHE_PATH: mockCachePath,
        },
        appAsarPath: asarPath,
      };

      const res = resolveBuiltinPet('permcat', deps);
      assert.strictEqual(res.available, true);

      const dirMode = fs.statSync(res.petDir).mode & 0o777;
      const webpMode = fs.statSync(res.spritesheetFullPath).mode & 0o777;
      const jsonMode = fs.statSync(path.join(res.petDir, 'pet.json')).mode & 0o777;

      assert.strictEqual(dirMode, 0o700);
      assert.strictEqual(webpMode, 0o600);
      assert.strictEqual(jsonMode, 0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('cache hit leaves all six timestamps (mtime/ctime for directory and two files) unchanged', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timestamps-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/timecat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res1 = resolveBuiltinPet('timecat', deps);
      assert.strictEqual(res1.available, true);
      assert.strictEqual(res1.cacheStatus, 'miss');

      const jsonPath = path.join(res1.petDir, 'pet.json');
      const dirStat1 = fs.statSync(res1.petDir);
      const webpStat1 = fs.statSync(res1.spritesheetFullPath);
      const jsonStat1 = fs.statSync(jsonPath);

      await new Promise(r => setTimeout(r, 60));

      const res2 = resolveBuiltinPet('timecat', deps);
      assert.strictEqual(res2.available, true);
      assert.strictEqual(res2.cacheStatus, 'hit');

      const dirStat2 = fs.statSync(res2.petDir);
      const webpStat2 = fs.statSync(res2.spritesheetFullPath);
      const jsonStat2 = fs.statSync(jsonPath);

      assert.strictEqual(dirStat1.mtimeMs, dirStat2.mtimeMs, 'directory mtime unchanged');
      assert.strictEqual(dirStat1.ctimeMs, dirStat2.ctimeMs, 'directory ctime unchanged');
      assert.strictEqual(webpStat1.mtimeMs, webpStat2.mtimeMs, 'spritesheet mtime unchanged');
      assert.strictEqual(webpStat1.ctimeMs, webpStat2.ctimeMs, 'spritesheet ctime unchanged');
      assert.strictEqual(jsonStat1.mtimeMs, jsonStat2.mtimeMs, 'pet.json mtime unchanged');
      assert.strictEqual(jsonStat1.ctimeMs, jsonStat2.ctimeMs, 'pet.json ctime unchanged');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('deliberately weakened permissions (0644/0755) are corrected on cache hit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-correct-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/weakcat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res1 = resolveBuiltinPet('weakcat', deps);
      assert.strictEqual(res1.available, true);
      assert.strictEqual(res1.cacheStatus, 'miss');
      const stat1 = fs.statSync(res1.spritesheetFullPath);

      fs.chmodSync(res1.petDir, 0o755);
      fs.chmodSync(res1.spritesheetFullPath, 0o644);
      fs.chmodSync(path.join(res1.petDir, 'pet.json'), 0o644);

      assert.strictEqual(fs.statSync(res1.petDir).mode & 0o777, 0o755);
      assert.strictEqual(fs.statSync(res1.spritesheetFullPath).mode & 0o777, 0o644);

      await new Promise(r => setTimeout(r, 50));

      const res2 = resolveBuiltinPet('weakcat', deps);
      assert.strictEqual(res2.available, true);
      assert.strictEqual(res2.cacheStatus, 'hit');

      assert.strictEqual(fs.statSync(res2.petDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(res2.spritesheetFullPath).mode & 0o777, 0o600);

      const stat2 = fs.statSync(res2.spritesheetFullPath);
      assert.strictEqual(stat1.mtimeMs, stat2.mtimeMs);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('same-size corrupted cache (altered body / wrong sha256 digest) is rejected and rebuilt', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-corrupt-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288, 500);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/digestcat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res1 = resolveBuiltinPet('digestcat', deps);
      assert.strictEqual(res1.available, true);
      assert.strictEqual(res1.cacheStatus, 'miss');

      const alteredBuf = Buffer.from(vp8lBuf);
      alteredBuf[vp8lBuf.length - 10] ^= 0xFF;
      fs.writeFileSync(res1.spritesheetFullPath, alteredBuf);

      const res2 = resolveBuiltinPet('digestcat', deps);
      assert.strictEqual(res2.available, true);
      assert.strictEqual(res2.cacheStatus, 'miss');

      const rebuiltBytes = fs.readFileSync(res2.spritesheetFullPath);
      assert.deepStrictEqual(rebuiltBytes, vp8lBuf);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('invalid pet.json (wrong petId or wrong spritesheetPath) invalidates cache', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-invalid-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/jsoncat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res1 = resolveBuiltinPet('jsoncat', deps);
      assert.strictEqual(res1.available, true);

      const petJsonPath = path.join(res1.petDir, 'pet.json');
      const jsonContent = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
      jsonContent.id = 'wrong-id';
      fs.writeFileSync(petJsonPath, JSON.stringify(jsonContent));

      const res2 = resolveBuiltinPet('jsoncat', deps);
      assert.strictEqual(res2.available, true);
      assert.strictEqual(res2.cacheStatus, 'miss');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('failed extraction leaves no .tmp directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-cleanup-test-'));
    try {
      const invalidWebpBuf = Buffer.from('NOT_WEBP_PAYLOAD_FOR_CLEANUP_TEST_123456');
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/failcat-spritesheet-123.webp': invalidWebpBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const cacheBase = path.join(tempDir, 'companion-build/builtin-cache');
      const deps = {
        fs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: cacheBase,
        },
        appAsarPath: asarPath,
      };

      const res = resolveBuiltinPet('failcat', deps);
      assert.strictEqual(res.available, false);
      assert.ok(res.error.includes('Invalid built-in WebP atlas'));

      if (fs.existsSync(cacheBase)) {
        const entries = fs.readdirSync(cacheBase);
        const tmpDirs = entries.filter(e => e.startsWith('.tmp-'));
        assert.deepStrictEqual(tmpDirs, []);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('rename race condition: handles EEXIST/ENOTEMPTY and reuses valid concurrent winner', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-race-test-'));
    try {
      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/racecat-spritesheet-123.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const cacheBase = path.join(tempDir, 'companion-build/builtin-cache');

      let winnerCreated = false;
      const injectedFs = Object.create(fs);
      injectedFs.renameSync = (oldPath, newPath) => {
        if (!winnerCreated) {
          winnerCreated = true;
          fs.mkdirSync(newPath, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(newPath, 'spritesheet.webp'), vp8lBuf, { mode: 0o600 });
          const digest = crypto.createHash('sha256').update(vp8lBuf).digest('hex');
          const petJson = {
            id: 'racecat',
            displayName: 'racecat',
            description: 'Built-in pet racecat',
            spritesheetPath: 'spritesheet.webp',
            sha256: digest,
          };
          fs.writeFileSync(path.join(newPath, 'pet.json'), JSON.stringify(petJson, null, 2) + '\n', { mode: 0o600 });
          const err = new Error('EEXIST: file already exists');
          err.code = 'EEXIST';
          throw err;
        }
        return fs.renameSync(oldPath, newPath);
      };

      const deps = {
        fs: injectedFs,
        paths: {
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: cacheBase,
        },
        appAsarPath: asarPath,
      };

      const res = resolveBuiltinPet('racecat', deps);
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.cacheStatus, 'hit');
      assert.ok(fs.existsSync(res.spritesheetFullPath));

      const entries = fs.readdirSync(cacheBase);
      const tmpDirs = entries.filter(e => e.startsWith('.tmp-'));
      assert.deepStrictEqual(tmpDirs, []);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('T003 & T004: Manifest loader dispatch, manual override, degradation, status metadata & workerLifecycle', async (t) => {
  await t.test('resolvePetId dispatches to custom pet package when present in PETS_ROOT', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-custom-test-'));
    try {
      const petsRoot = path.join(tempDir, 'pets');
      const customPetDir = path.join(petsRoot, 'custom-dragon');
      fs.mkdirSync(customPetDir, { recursive: true });

      const fakeSheet = path.join(customPetDir, 'sheet.png');
      fs.writeFileSync(fakeSheet, Buffer.alloc(100));

      const petJson = {
        id: 'custom-dragon',
        displayName: 'Custom Dragon',
        description: 'Dragon',
        spritesheetPath: 'sheet.png',
      };
      fs.writeFileSync(path.join(customPetDir, 'pet.json'), JSON.stringify(petJson));

      const configToml = path.join(tempDir, 'config.toml');
      fs.writeFileSync(configToml, 'selected-avatar-id = "custom-dragon"\n');

      const deps = {
        fs,
        paths: {
          PETS_ROOT: petsRoot,
          CODEX_CONFIG_PATH: configToml,
          COMPANION_CONFIG_PATH: path.join(tempDir, 'companion-config.json'),
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
        },
      };

      const res = resolvePetId(deps);
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.petId, 'custom-dragon');
      assert.strictEqual(res.provider, 'custom');
      assert.strictEqual(res.cacheStatus, 'none');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('resolvePetId dispatches to built-in provider when custom pet is missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-builtin-test-'));
    try {
      const petsRoot = path.join(tempDir, 'pets');
      fs.mkdirSync(petsRoot, { recursive: true });

      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/builtin-owl-spritesheet-xyz987.webp': vp8lBuf,
      });

      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const configToml = path.join(tempDir, 'config.toml');
      fs.writeFileSync(configToml, 'selected-avatar-id = "builtin-owl"\n');

      const deps = {
        fs,
        paths: {
          PETS_ROOT: petsRoot,
          CODEX_CONFIG_PATH: configToml,
          COMPANION_CONFIG_PATH: path.join(tempDir, 'companion-config.json'),
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res = resolvePetId(deps);
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.petId, 'builtin-owl');
      assert.strictEqual(res.provider, 'builtin');
      assert.strictEqual(res.cacheStatus, 'miss');

      const resHit = resolvePetId(deps);
      assert.strictEqual(resHit.available, true);
      assert.strictEqual(resHit.provider, 'builtin');
      assert.strictEqual(resHit.cacheStatus, 'hit');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('manual companion-config override precedence is preserved', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-override-test-'));
    try {
      const petsRoot = path.join(tempDir, 'pets');
      fs.mkdirSync(petsRoot, { recursive: true });

      const configToml = path.join(tempDir, 'config.toml');
      fs.writeFileSync(configToml, 'selected-avatar-id = "auto-cat"\n');

      const companionConfigJson = path.join(tempDir, 'companion-config.json');
      fs.writeFileSync(companionConfigJson, JSON.stringify({ petId: 'manual-owl' }));

      const vp8lBuf = createSyntheticVP8LWebP(1536, 2288);
      const asarBuf = createSyntheticAsarBuffer({
        'webview/assets/manual-owl-spritesheet-xyz987.webp': vp8lBuf,
      });
      const asarPath = path.join(tempDir, 'app.asar');
      fs.writeFileSync(asarPath, asarBuf);

      const deps = {
        fs,
        paths: {
          PETS_ROOT: petsRoot,
          CODEX_CONFIG_PATH: configToml,
          COMPANION_CONFIG_PATH: companionConfigJson,
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
          COMPANION_BUILTIN_CACHE_PATH: path.join(tempDir, 'companion-build/builtin-cache'),
        },
        appAsarPath: asarPath,
      };

      const res = resolvePetId(deps);
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.petId, 'manual-owl');
      assert.strictEqual(res.source, 'manual');
      assert.strictEqual(res.provider, 'builtin');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('failed built-in degradation returns pet unavailable without throwing exceptions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degrad-test-'));
    try {
      const petsRoot = path.join(tempDir, 'pets');
      fs.mkdirSync(petsRoot, { recursive: true });

      const configToml = path.join(tempDir, 'config.toml');
      fs.writeFileSync(configToml, 'selected-avatar-id = "missing-pet"\n');

      const deps = {
        fs,
        paths: {
          PETS_ROOT: petsRoot,
          CODEX_CONFIG_PATH: configToml,
          COMPANION_CONFIG_PATH: path.join(tempDir, 'companion-config.json'),
          COMPANION_BUILD_PATH: path.join(tempDir, 'companion-build'),
        },
        appAsarPath: path.join(tempDir, 'nonexistent-app.asar'),
      };

      const res = resolvePetId(deps);
      assert.strictEqual(res.available, false);
      assert.strictEqual(res.petId, 'missing-pet');
      assert.strictEqual(res.provider, 'builtin');
      assert.ok(res.error.includes('application package not found'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('status & formatHuman includes petProvider and cacheStatus metadata', () => {
    const def = statusMod.defaultStatus();
    assert.ok(def.hasOwnProperty('petProvider'));
    assert.ok(def.hasOwnProperty('cacheStatus'));

    def.petId = 'builtin-owl';
    def.petProvider = 'builtin';
    def.cacheStatus = 'hit';

    const formatted = statusMod.formatHuman(def);
    assert.ok(formatted.includes('Pet provider: builtin'));
    assert.ok(formatted.includes('Cache status: hit'));

    const read = statusMod.readStatus(path.join(os.tmpdir(), 'nonexistent-status-file.json'));
    assert.strictEqual(read.petProvider, null);
    assert.strictEqual(read.cacheStatus, null);
  });

  await t.test('workerLifecycle runWorker status receives petProvider and cacheStatus from petInfo', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-status-test-'));
    try {
      const socketPath = path.join(tempDir, 'daemon.sock');
      fs.writeFileSync(socketPath, '');

      const statusPath = path.join(tempDir, 'companion-status.json');
      const pidPath = path.join(tempDir, 'companion.pid');
      const readyPath = path.join(tempDir, 'companion-ready.json');

      const mockPetInfo = {
        petId: 'builtin-cat',
        source: 'auto',
        available: true,
        petDir: tempDir,
        spritesheetFullPath: path.join(tempDir, 'spritesheet.webp'),
        provider: 'builtin',
        cacheStatus: 'hit',
        error: null,
      };

      const deps = workerLifecycle.createDeps({
        fs,
        socketPath,
        paths: {
          COMPANION_STATUS_PATH: statusPath,
          COMPANION_PID_PATH: pidPath,
          COMPANION_READY_PATH: readyPath,
          COMPANION_BUILD_PATH: tempDir,
          URD_STATE_DIR: tempDir,
        },
        resolvePetId: () => mockPetInfo,
        prepareVisualConfig: () => ({ visualConfig: {}, companionJsonLoaded: false }),
        sendDaemonCommand: async () => ({ ok: true, state: { status: 'completed', phase: 'work' } }),
        startBridge: () => ({
          start: () => {},
          whenReady: async () => {},
          send: () => {},
          stop: () => {},
        }),
        createUltradianAdapter: () => ({
          start: () => {},
          stop: () => {},
        }),
        runtimeExit: () => {},
        exit: () => {},
        workerPid: 12345,
      });

      await workerLifecycle.runWorker(deps);

      assert.ok(fs.existsSync(statusPath));
      const writtenStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      assert.strictEqual(writtenStatus.petId, 'builtin-cat');
      assert.strictEqual(writtenStatus.petProvider, 'builtin');
      assert.strictEqual(writtenStatus.cacheStatus, 'hit');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('Provider-aware manifest validation in parsePetManifest and defaultPrepareVisualConfig', async (t) => {
  await t.test('parsePetManifest accepts expectedPetId as string or options object', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-expected-id-test-'));
    try {
      const cacheDir = path.join(tempDir, 'seedy-a1b2c3d4e5f6');
      fs.mkdirSync(cacheDir, { recursive: true });
      const sheetPath = path.join(cacheDir, 'spritesheet.webp');
      fs.writeFileSync(sheetPath, Buffer.alloc(100));

      const petJson = {
        id: 'seedy',
        displayName: 'Seedy',
        description: 'Builtin seedy',
        spritesheetPath: 'spritesheet.webp',
      };

      // Direct string parameter
      const resStr = parsePetManifest(cacheDir, petJson, 'seedy');
      assert.strictEqual(resStr.valid, true);

      // Options object parameter
      const resObj = parsePetManifest(cacheDir, petJson, { expectedPetId: 'seedy' });
      assert.strictEqual(resObj.valid, true);

      // Unsupplied / undefined defaults to strict directory basename check
      const resDefault = parsePetManifest(cacheDir, petJson);
      assert.strictEqual(resDefault.valid, false);
      assert.ok(resDefault.errors[0].includes('does not match normalized directory id'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('prepares successfully for built-in pet with hashed cache directory (e.g. seedy-hash)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-prep-success-test-'));
    try {
      const cacheDir = path.join(tempDir, 'seedy-a1b2c3d4e5f6');
      fs.mkdirSync(cacheDir, { recursive: true });

      const sheetPath = path.join(cacheDir, 'spritesheet.webp');
      fs.writeFileSync(sheetPath, Buffer.alloc(100));

      const petJson = {
        id: 'seedy',
        displayName: 'Seedy Pet',
        description: 'Built-in seedy',
        spritesheetPath: 'spritesheet.webp',
      };
      fs.writeFileSync(path.join(cacheDir, 'pet.json'), JSON.stringify(petJson));

      const mockDeps = {
        fs,
        paths: {
          COMPANION_BINARY: path.join(tempDir, 'mock-bin'),
          COMPANION_CONFIG_PATH: path.join(tempDir, 'companion-config.json'),
        },
        compileSwiftRenderer: () => {},
        execFileSync: () => JSON.stringify({ valid: true, width: 1536, height: 2288, hasAlpha: true }),
      };

      const petInfo = {
        petId: 'seedy',
        provider: 'builtin',
        petDir: cacheDir,
      };

      const res = workerLifecycle.defaultPrepareVisualConfig(mockDeps, petInfo);
      assert.strictEqual(res.failMsg, undefined);
      assert.ok(res.visualConfig);
      assert.strictEqual(res.visualConfig.atlasPath, fs.realpathSync(sheetPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('rejects built-in pet when pet.json has wrong id', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-prep-wrong-id-test-'));
    try {
      const cacheDir = path.join(tempDir, 'seedy-a1b2c3d4e5f6');
      fs.mkdirSync(cacheDir, { recursive: true });

      const sheetPath = path.join(cacheDir, 'spritesheet.webp');
      fs.writeFileSync(sheetPath, Buffer.alloc(100));

      const petJson = {
        id: 'wrong-id',
        displayName: 'Wrong Pet',
        description: 'Wrong id',
        spritesheetPath: 'spritesheet.webp',
      };
      fs.writeFileSync(path.join(cacheDir, 'pet.json'), JSON.stringify(petJson));

      const mockDeps = {
        fs,
        paths: {
          COMPANION_BINARY: path.join(tempDir, 'mock-bin'),
        },
        compileSwiftRenderer: () => {},
        execFileSync: () => JSON.stringify({ valid: true, width: 1536, height: 2288, hasAlpha: true }),
      };

      const petInfo = {
        petId: 'seedy',
        provider: 'builtin',
        petDir: cacheDir,
      };

      const res = workerLifecycle.defaultPrepareVisualConfig(mockDeps, petInfo);
      assert.ok(res.failMsg);
      assert.ok(res.failMsg.includes('invalid pet manifest'));
      assert.ok(res.failMsg.includes('wrong-id'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('rejects custom pet package when directory name does not match pet.json id', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-prep-mismatch-test-'));
    try {
      const petDir = path.join(tempDir, 'mismatched-dir');
      fs.mkdirSync(petDir, { recursive: true });

      const sheetPath = path.join(petDir, 'spritesheet.webp');
      fs.writeFileSync(sheetPath, Buffer.alloc(100));

      const petJson = {
        id: 'custom-dragon',
        displayName: 'Custom Dragon',
        description: 'Dragon pet',
        spritesheetPath: 'spritesheet.webp',
      };
      fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(petJson));

      const mockDeps = {
        fs,
        paths: {
          COMPANION_BINARY: path.join(tempDir, 'mock-bin'),
        },
        compileSwiftRenderer: () => {},
        execFileSync: () => JSON.stringify({ valid: true, width: 1536, height: 2288, hasAlpha: true }),
      };

      const petInfo = {
        petId: 'custom-dragon',
        provider: 'custom',
        petDir: petDir,
      };

      const res = workerLifecycle.defaultPrepareVisualConfig(mockDeps, petInfo);
      assert.ok(res.failMsg);
      assert.ok(res.failMsg.includes('invalid pet manifest'));
      assert.ok(res.failMsg.includes('mismatched-dir'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
