const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const companionPaths = require('../src/companion/paths.js');

// Minimal PNG generator helper for tests
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crcV = Buffer.alloc(4);
  crcV.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeB, data, crcV]);
}

function writeTestPNG(filePath, width, height, hasAlpha = true) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = hasAlpha ? 6 : 2; // color type: 6 = RGBA, 2 = RGB (opaque)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const bytesPerPixel = hasAlpha ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (rowBytes + 1)] = 0; // Filter none
  }

  const compressed = zlib.deflateSync(filtered);
  const idat = pngChunk("IDAT", compressed);
  const iend = pngChunk("IEND", Buffer.alloc(0));

  fs.writeFileSync(filePath, Buffer.concat([sig, pngChunk("IHDR", ihdr), idat, iend]));
}

// Minimal 1x1 WebP bytes (has alpha)
const VALID_WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0e, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0x08, 0x00, 0x00
]);

// CLI contract tests (T045)
test('T045: CLI contract tests', async (t) => {
  const { printUsage } = require('../bin/codex-pet-companion.js');

  await t.test('printUsage outputs help text', () => {
    const origLog = console.log;
    const lines = [];
    console.log = (msg) => lines.push(msg);
    printUsage();
    console.log = origLog;
    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.includes('validate-pet')));
    assert.ok(lines.some(l => l.includes('preview')));
    assert.ok(lines.some(l => l.includes('start')));
    assert.ok(lines.some(l => l.includes('stop')));
    assert.ok(lines.some(l => l.includes('status')));
    assert.ok(lines.some(l => l.includes('config')));
  });
});

// Companion JSON validation tests (T034)
test('T034: companion.json schema validation', async (t) => {
  const { validateCompanionConfig } = require('../src/companion/companion-config-loader.js');

  await t.test('valid companion.json passes', () => {
    const config = {
      schemaVersion: 1,
      petId: 'test-pet',
      render: {
        smallWidth: 84,
        restWidth: 360,
        anchor: 'pet-bottom-center',
        interpolation: 'nearest',
      },
      clips: {
        enter: { frames: ['enter/1.png'], fps: 10, loop: false },
        rest: { frames: ['rest/1.png'], fps: 8, loop: true },
      },
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-json-'));
    for (const clipName of ['enter', 'rest']) {
      const clipDir = path.join(tempDir, clipName);
      fs.mkdirSync(clipDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, clipName, '1.png'), Buffer.alloc(100));
    }
    const result = validateCompanionConfig(config, 'test-pet', tempDir);
    assert.strictEqual(result.valid, true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('reject unsupported schemaVersion', () => {
    const result = validateCompanionConfig({ schemaVersion: 3, petId: 'x' }, 'x', '/tmp');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('schemaVersion')));
  });

  await t.test('reject petId mismatch', () => {
    const result = validateCompanionConfig({ schemaVersion: 1, petId: 'a' }, 'b', '/tmp');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('petId')));
  });

  await t.test('smallWidth range validation', () => {
    const r1 = validateCompanionConfig({ schemaVersion: 1, petId: 'x', render: { smallWidth: 10 } }, 'x', '/tmp');
    assert.strictEqual(r1.valid, false);
    const r2 = validateCompanionConfig({ schemaVersion: 1, petId: 'x', render: { smallWidth: 300 } }, 'x', '/tmp');
    assert.strictEqual(r2.valid, false);
  });

  await t.test('restWidth must be >= smallWidth', () => {
    const r = validateCompanionConfig({ schemaVersion: 1, petId: 'x', render: { smallWidth: 200, restWidth: 100 } }, 'x', '/tmp');
    assert.strictEqual(r.valid, false);
  });

  await t.test('anchor validation', () => {
    const r = validateCompanionConfig({ schemaVersion: 1, petId: 'x', render: { anchor: 'top-left' } }, 'x', '/tmp');
    assert.strictEqual(r.valid, false);
  });

  await t.test('interpolation validation', () => {
    const r = validateCompanionConfig({ schemaVersion: 1, petId: 'x', render: { interpolation: 'smooth' } }, 'x', '/tmp');
    assert.strictEqual(r.valid, false);
  });

  await t.test('fps range validation', () => {
    const r = validateCompanionConfig({ schemaVersion: 1, petId: 'x', clips: { enter: { frames: ['a.png'], fps: 20 } } }, 'x', '/tmp');
    assert.strictEqual(r.valid, false);
  });

  await t.test('unknown clip names silently ignored', () => {
    const r = validateCompanionConfig({ schemaVersion: 1, petId: 'x', clips: { unknown_clip: { frames: ['a.png'], fps: 5 } } }, 'x', '/tmp');
    assert.strictEqual(r.valid, true);
  });

  await t.test('schemaVersion 2 valid config passes', () => {
    const config = {
      schemaVersion: 2,
      petId: 'test-pet',
      render: {
        restHeightRatio: 0.75,
      },
      clips: {
        rest: {
          atlasFrames: [{ row: 5, column: 4 }, { row: 5, column: 5 }],
          fps: 2,
          loop: true,
        },
      },
    };
    const result = validateCompanionConfig(config, 'test-pet', '/tmp');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.render.restHeightRatio, 0.75);
  });

  await t.test('schemaVersion 2 restHeightRatio validation', () => {
    const rLow = validateCompanionConfig({ schemaVersion: 2, petId: 'x', render: { restHeightRatio: 0.3 } }, 'x', '/tmp');
    assert.strictEqual(rLow.valid, false);
    assert.ok(rLow.errors.some(e => e.includes('restHeightRatio')));

    const rHigh = validateCompanionConfig({ schemaVersion: 2, petId: 'x', render: { restHeightRatio: 0.95 } }, 'x', '/tmp');
    assert.strictEqual(rHigh.valid, false);

    const rStr = validateCompanionConfig({ schemaVersion: 2, petId: 'x', render: { restHeightRatio: '0.72' } }, 'x', '/tmp');
    assert.strictEqual(rStr.valid, false);
  });

  await t.test('clip must define exactly one of frames or atlasFrames', () => {
    const rBoth = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { frames: ['a.png'], atlasFrames: [{ row: 0, column: 0 }], fps: 4 } },
    }, 'x', '/tmp');
    assert.strictEqual(rBoth.valid, false);
    assert.ok(rBoth.errors.some(e => e.includes('exactly one')));

    const rNeither = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { fps: 4 } },
    }, 'x', '/tmp');
    assert.strictEqual(rNeither.valid, false);
  });

  await t.test('atlasFrames bounds validation (column [0,7], row >= 0)', () => {
    const rCol = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { atlasFrames: [{ row: 0, column: 8 }], fps: 2 } },
    }, 'x', '/tmp');
    assert.strictEqual(rCol.valid, false);
    assert.ok(rCol.errors.some(e => e.includes('column')));

    const rRow = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { atlasFrames: [{ row: -1, column: 2 }], fps: 2 } },
    }, 'x', '/tmp');
    assert.strictEqual(rRow.valid, false);

    const rTooHigh = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { atlasFrames: [{ row: 16, column: 2 }], fps: 2 } },
    }, 'x', '/tmp');
    assert.strictEqual(rTooHigh.valid, false);
    assert.ok(rTooHigh.errors.some(e => e.includes('row')));
  });

  await t.test('custom clips have bounded per-clip and total frame counts', () => {
    const tooManyInOne = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: { rest: { frames: Array(61).fill('f.png'), fps: 2 } },
    }, 'x', '/tmp');
    assert.ok(tooManyInOne.errors.some(e => e.includes('exceeds 60 frames')));

    const overTotal = validateCompanionConfig({
      schemaVersion: 2,
      petId: 'x',
      clips: {
        enter: { atlasFrames: Array(60).fill({ row: 0, column: 0 }), fps: 2 },
        rest: { atlasFrames: Array(60).fill({ row: 0, column: 0 }), fps: 2 },
        exit: { atlasFrames: [{ row: 0, column: 0 }], fps: 2 },
      },
    }, 'x', '/tmp');
    assert.ok(overTotal.errors.some(e => e.includes('120 total clip frames')));
  });

  await t.test('custom atlas row count is bounded', () => {
    const { validateAtlasDimensions } = require('../src/companion/manifest-loader.js');
    assert.strictEqual(validateAtlasDimensions(1536, 16 * 208).valid, true);
    assert.strictEqual(validateAtlasDimensions(1536, 17 * 208).valid, false);
  });
});

// T035: Frame image validation tests
test('T035: Frame image validation', async (t) => {
  const { validateFrameImage, validateFrames, VALID_FRAME_EXTENSIONS } = require('../src/companion/companion-config-loader.js');

  await t.test('validateFrameImage rejects invalid extension', () => {
    const result = validateFrameImage('test.gif', '/tmp', '/dev/null', () => ({ valid: true }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('.gif'));
  });

  await t.test('validateFrameImage rejects oversized encoded files before decoding', () => {
    const { MAX_FRAME_BYTES } = require('../src/companion/companion-config-loader.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-size-'));
    const framePath = path.join(tempDir, 'oversized.png');
    const fd = fs.openSync(framePath, 'w');
    fs.ftruncateSync(fd, MAX_FRAME_BYTES + 1);
    fs.closeSync(fd);
    let validatorCalled = false;
    const result = validateFrameImage('oversized.png', tempDir, '/dev/null', () => {
      validatorCalled = true;
      return { valid: true, width: 1, height: 1, hasAlpha: true };
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(validatorCalled, false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('validateFrameImage rejects path traversal', () => {
    const result = validateFrameImage('../../etc/passwd.png', '/tmp', '/dev/null', () => ({ valid: true }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('traversal') || result.error.includes('not allowed') || result.error.includes('outside pet root'));
  });

  await t.test('validateFrames rejects empty array', () => {
    const result = validateFrames([], '/tmp', '/dev/null', () => ({ valid: true }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('empty')));
  });

  await t.test('validateFrames passes for valid frames with same dimensions', () => {
    const runSwiftFn = () => ({ valid: true, width: 192, height: 208, hasAlpha: true });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-val-'));
    for (const f of ['f1.png', 'f2.png']) {
      fs.writeFileSync(path.join(tempDir, f), Buffer.alloc(100));
    }
    const result = validateFrames(['f1.png', 'f2.png'], tempDir, '/dev/null', runSwiftFn);
    assert.strictEqual(result.valid, true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('validateFrames catches dimension mismatch', () => {
    const dims = [{ valid: true, width: 192, height: 208, hasAlpha: true },
                  { valid: true, width: 200, height: 208, hasAlpha: true }];
    let callCount = 0;
    const runSwiftFn = () => dims[callCount++];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-dim-'));
    for (const f of ['f1.png', 'f2.png']) {
      fs.writeFileSync(path.join(tempDir, f), Buffer.alloc(100));
    }
    const result = validateFrames(['f1.png', 'f2.png'], tempDir, '/dev/null', runSwiftFn);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('dimension mismatch')));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('validateFrames catches missing alpha', () => {
    const runSwiftFn = () => ({ valid: true, width: 192, height: 208, hasAlpha: false });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-alpha-'));
    fs.writeFileSync(path.join(tempDir, 'f1.png'), Buffer.alloc(100));
    const result = validateFrames(['f1.png'], tempDir, '/dev/null', runSwiftFn);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('alpha')));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('VALID_FRAME_EXTENSIONS contains png and webp', () => {
    assert.ok(VALID_FRAME_EXTENSIONS.has('.png'));
    assert.ok(VALID_FRAME_EXTENSIONS.has('.webp'));
    assert.strictEqual(VALID_FRAME_EXTENSIONS.size, 2);
  });
});

// T037/T038: Pet resolution from config.toml and companion-config.json
test('T037/T038: Pet resolution from config.toml and manual override', async (t) => {
  const { resolvePetId, validatePetId, readConfigToml, normalizePetId } = require('../src/companion/manifest-loader.js');

  await t.test('validatePetId rejects invalid formats', () => {
    assert.strictEqual(validatePetId('custom:').valid, false);
    assert.strictEqual(validatePetId('custom:bad@pet').valid, false);
    assert.strictEqual(validatePetId('').valid, false);
    assert.strictEqual(validatePetId(null).valid, false);
  });

  await t.test('validatePetId accepts valid custom and plain IDs', () => {
    assert.strictEqual(validatePetId('plain-id').valid, true);
    assert.strictEqual(validatePetId('custom:my-pet').valid, true);
    assert.strictEqual(validatePetId('custom:pet_123').valid, true);
    assert.strictEqual(validatePetId('custom:a').valid, true);
  });

  await t.test('normalizePetId converts custom prefix to plain id', () => {
    assert.strictEqual(normalizePetId('custom:ultradian-pixel-cat'), 'ultradian-pixel-cat');
    assert.strictEqual(normalizePetId('ultradian-pixel-cat'), 'ultradian-pixel-cat');
    assert.strictEqual(normalizePetId(' custom:pet '), 'pet');
  });

  await t.test('resolvePetId detects configuration logic', () => {
    const result = resolvePetId();
    assert.ok(result.hasOwnProperty('available'));
    assert.ok(result.hasOwnProperty('source'));
  });
});

// validate-pet integration tests (T047)
test('T047: validate-pet integration', async (t) => {
  const { handleValidatePet } = require('../bin/codex-pet-companion.js');

  await t.test('invalid pet path exits with error', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-pet-'));
    const origExit = process.exit;
    const origLog = console.log;
    let exitCode = null;
    let output = null;
    process.exit = (code) => { exitCode = code; };
    console.log = (msg) => { output = msg; };

    handleValidatePet([tempDir]);

    process.exit = origExit;
    console.log = origLog;
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('pet.json not found'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

// Preview tests (T049)
test('T049: Preview command test', async (t) => {
  const { handlePreview } = require('../bin/codex-pet-companion.js');

  await t.test('preview without --pet fails', () => {
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; };
    console.error = () => {};

    handlePreview(['--state', 'rest']);

    process.exit = origExit;
    console.error = origErr;
    assert.strictEqual(exitCode, 1);
  });
});

// Config persistence tests (T052)
test('T052: Config persistence tests', async (t) => {
  const { handleConfig } = require('../bin/codex-pet-companion.js');

  await t.test('config set pet requires arguments', () => {
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; };
    console.error = () => {};

    handleConfig([]);

    process.exit = origExit;
    console.error = origErr;
    assert.strictEqual(exitCode, 1);
  });
});

// Detailed validation, decoding and containment tests
test('US3: Strict validations, WebP, opaque, corrupt and containment tests', async (t) => {
  const { parsePetManifest, validatePathSecurity, resolvePetId } = require('../src/companion/manifest-loader.js');
  const { validateCompanionConfig } = require('../src/companion/companion-config-loader.js');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-us3-'));
  const petsRoot = path.join(baseDir, 'pets');
  const configDir = path.join(baseDir, 'ultradian-rhythm');
  fs.mkdirSync(petsRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Backup original paths
  const origPetsRoot = companionPaths.PETS_ROOT;
  const origConfigPath = companionPaths.COMPANION_CONFIG_PATH;
  const origTomlPath = companionPaths.CODEX_CONFIG_PATH;

  companionPaths.PETS_ROOT = petsRoot;
  companionPaths.COMPANION_CONFIG_PATH = path.join(configDir, 'companion-config.json');
  companionPaths.CODEX_CONFIG_PATH = path.join(baseDir, 'config.toml');

  // Create pet folder
  const petId = 'ultradian-pixel-cat';
  const petDir = path.join(petsRoot, petId);
  fs.mkdirSync(petDir, { recursive: true });

  // Write a valid spritesheet PNG
  const validPngPath = path.join(petDir, 'spritesheet.png');
  writeTestPNG(validPngPath, 1536, 1872, true);

  // Write WebP spritesheet
  const webpPath = path.join(petDir, 'spritesheet.webp');
  fs.writeFileSync(webpPath, VALID_WEBP_BYTES);

  // Write opaque spritesheet (no alpha)
  const opaquePngPath = path.join(petDir, 'opaque.png');
  writeTestPNG(opaquePngPath, 1536, 1872, false);

  // Write invalid dimension spritesheet
  const badDimPngPath = path.join(petDir, 'bad_dim.png');
  writeTestPNG(badDimPngPath, 100, 100, true);

  // Write corrupt spritesheet
  const corruptPngPath = path.join(petDir, 'corrupt.png');
  fs.writeFileSync(corruptPngPath, Buffer.from([0x00, 0x11, 0x22, 0x33]));

  await t.test('validate path traversal escapes', () => {
    const sec1 = validatePathSecurity('../escape.png', petDir);
    assert.strictEqual(sec1.safe, false);

    const sec2 = validatePathSecurity('/absolute/escape.png', petDir);
    assert.strictEqual(sec2.safe, false);
  });

  await t.test('pet.json id must match normalized directory id', () => {
    const petJson = {
      id: 'another-id',
      displayName: 'Test Cat',
      description: 'A test cat',
      spritesheetPath: 'spritesheet.png'
    };
    const res = parsePetManifest(petDir, petJson);
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('match')));
  });

  await t.test('config.toml custom:<id> resolves to correct plain id and directory', () => {
    fs.writeFileSync(companionPaths.CODEX_CONFIG_PATH, 'selected-avatar-id = "custom:ultradian-pixel-cat"\n');
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      id: petId,
      displayName: 'Ultradian Pixel Cat',
      description: 'Cat',
      spritesheetPath: 'spritesheet.png'
    }));

    const res = resolvePetId();
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.petId, 'ultradian-pixel-cat');
    assert.strictEqual(res.source, 'auto');
  });

  await t.test('manual companion-config override wins over auto', () => {
    // Write manual config
    fs.writeFileSync(companionPaths.COMPANION_CONFIG_PATH, JSON.stringify({
      petId: 'custom:manual-cat'
    }));
    
    // Create manual pet dir
    const manualPetDir = path.join(petsRoot, 'manual-cat');
    fs.mkdirSync(manualPetDir, { recursive: true });
    writeTestPNG(path.join(manualPetDir, 'sheet.png'), 1536, 1872, true);
    fs.writeFileSync(path.join(manualPetDir, 'pet.json'), JSON.stringify({
      id: 'manual-cat',
      displayName: 'Manual Cat',
      description: 'Manual',
      spritesheetPath: 'sheet.png'
    }));

    const res = resolvePetId();
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.petId, 'manual-cat');
    assert.strictEqual(res.source, 'manual');
  });

  // Restore paths
  companionPaths.PETS_ROOT = origPetsRoot;
  companionPaths.COMPANION_CONFIG_PATH = origConfigPath;
  companionPaths.CODEX_CONFIG_PATH = origTomlPath;

  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('Batch C: Sizing policy, v2-only fields, and handleValidatePet atlasFrames range check', async (t) => {
  const { validateCompanionConfig, getSafeRenderSettings } = require('../src/companion/companion-config-loader.js');
  const { defaultPrepareVisualConfig } = require('../src/companion/worker-lifecycle.js');
  const { handleValidatePet } = require('../bin/codex-pet-companion.js');

  await t.test('schema v1 with v2-only fields fails validation', () => {
    const v1Ratio = validateCompanionConfig({
      schemaVersion: 1,
      petId: 'pet-x',
      render: { restHeightRatio: 0.75 },
    }, 'pet-x', '/tmp');
    assert.strictEqual(v1Ratio.valid, false);
    assert.ok(v1Ratio.errors.some(e => e.includes('restHeightRatio')));

    const v1Atlas = validateCompanionConfig({
      schemaVersion: 1,
      petId: 'pet-x',
      clips: { rest: { atlasFrames: [{ row: 0, column: 0 }], fps: 8 } },
    }, 'pet-x', '/tmp');
    assert.strictEqual(v1Atlas.valid, false);
    assert.ok(v1Atlas.errors.some(e => e.includes('atlasFrames')));
  });

  await t.test('defaultPrepareVisualConfig sizing policy for missing companion.json, v1, v2, and user override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-sizing-'));
    const petDir = path.join(tempDir, 'test-pet');
    fs.mkdirSync(petDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      id: 'test-pet',
      displayName: 'Test Pet',
      description: 'desc',
      spritesheetPath: 'spritesheet.png'
    }));
    writeTestPNG(path.join(petDir, 'spritesheet.png'), 1536, 1872, true);
    const userConfigPath = path.join(tempDir, 'companion-config.json');

    const mockDeps = (userConfigObj = null) => ({
      fs,
      paths: {
        COMPANION_BINARY: '/dev/null',
        COMPANION_CONFIG_PATH: userConfigPath,
      },
      compileSwiftRenderer: () => {},
      execFileSync: () => JSON.stringify({ valid: true, hasAlpha: true, width: 1536, height: 1872 }),
    });

    const prepareWithUserConfig = (userConfigObj = null) => {
      if (userConfigObj === null) {
        fs.rmSync(userConfigPath, { force: true });
      } else {
        fs.writeFileSync(userConfigPath, JSON.stringify(userConfigObj));
      }
      return defaultPrepareVisualConfig(mockDeps(), { petDir });
    };

    // 1. Missing companion.json -> restHeightRatio at 0.72
    const resMissing = prepareWithUserConfig();
    assert.strictEqual(resMissing.failMsg, undefined);
    assert.strictEqual(resMissing.visualConfig.sizingMode, 'restHeightRatio');
    assert.strictEqual(resMissing.visualConfig.targetHeightRatio, 0.72);

    // 2. Schema v1 companion.json -> fixedWidth
    fs.writeFileSync(path.join(petDir, 'companion.json'), JSON.stringify({
      schemaVersion: 1,
      petId: 'test-pet',
      render: { smallWidth: 84, restWidth: 360 },
      clips: {},
    }));
    const resV1 = prepareWithUserConfig();
    assert.strictEqual(resV1.failMsg, undefined);
    assert.strictEqual(resV1.visualConfig.sizingMode, 'fixedWidth');

    // 3. Schema v1 companion.json WITH explicit user restHeightRatio override -> forces restHeightRatio mode
    const resV1UserOverride = prepareWithUserConfig({ render: { restHeightRatio: 0.8 } });
    assert.strictEqual(resV1UserOverride.failMsg, undefined);
    assert.strictEqual(resV1UserOverride.visualConfig.sizingMode, 'restHeightRatio');
    assert.strictEqual(resV1UserOverride.visualConfig.targetHeightRatio, 0.8);

    // 4. Schema v2 companion.json -> restHeightRatio mode
    fs.writeFileSync(path.join(petDir, 'companion.json'), JSON.stringify({
      schemaVersion: 2,
      petId: 'test-pet',
      render: { restHeightRatio: 0.65 },
      clips: {},
    }));
    const resV2 = prepareWithUserConfig();
    assert.strictEqual(resV2.failMsg, undefined);
    assert.strictEqual(resV2.visualConfig.sizingMode, 'restHeightRatio');
    assert.strictEqual(resV2.visualConfig.targetHeightRatio, 0.65);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('handleValidatePet atlasFrames range check end-to-end', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-atlas-'));
    const petDir = path.join(tempDir, 'atlas-pet');
    fs.mkdirSync(petDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      id: 'atlas-pet',
      displayName: 'Atlas Pet',
      description: 'desc',
      spritesheetPath: 'spritesheet.png'
    }));
    writeTestPNG(path.join(petDir, 'spritesheet.png'), 1536, 1872, true);

    // 1. Valid atlasFrames (rows 0-8 within 9 rows)
    fs.writeFileSync(path.join(petDir, 'companion.json'), JSON.stringify({
      schemaVersion: 2,
      petId: 'atlas-pet',
      clips: {
        rest: { atlasFrames: [{ row: 0, column: 0 }, { row: 8, column: 7 }], fps: 8 }
      }
    }));

    const origExit = process.exit;
    const origLog = console.log;
    let exitCode = null;
    let output = null;

    process.exit = (c) => { exitCode = c; };
    console.log = (msg) => { output = JSON.parse(msg); };

    handleValidatePet([petDir]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(output.valid, true);
    assert.strictEqual(output.atlasRows, 9);
    assert.strictEqual(output.companionJson, true);

    // 2. Invalid atlasFrames (row 10 exceeds 9 rows)
    fs.writeFileSync(path.join(petDir, 'companion.json'), JSON.stringify({
      schemaVersion: 2,
      petId: 'atlas-pet',
      clips: {
        rest: { atlasFrames: [{ row: 10, column: 0 }], fps: 8 }
      }
    }));

    exitCode = null;
    output = null;

    handleValidatePet([petDir]);

    process.exit = origExit;
    console.log = origLog;

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(output.valid, false);
    assert.ok(output.errors.some(e => e.includes('row 10 out of range')));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
