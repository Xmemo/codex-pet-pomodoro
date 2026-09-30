const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

// 1. 拷贝辅助方法
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

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, Buffer.concat([sig, pngChunk("IHDR", ihdr), idat, iend]));
}

const VALID_WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0e, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0x08, 0x00, 0x00
]);

const hasXcrun = (() => {
  try {
    const { execSync } = require('child_process');
    execSync('which xcrun', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function compileSwiftRenderer(binPath) {
  const swiftSrc = path.join(__dirname, '..', 'src', 'companion_renderer.swift');
  const swiftSrc2 = path.join(__dirname, '..', 'src', 'timer_panel.swift');
  const binDir = path.dirname(binPath);
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', binPath, swiftSrc, swiftSrc2], { stdio: 'ignore' });
}

// -------------------------------------------------------------
// Test Case 1: Real decoder tests (缺陷 1)
// -------------------------------------------------------------
test('Gate 2 Defect 1: Real decoder tests using Swift', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-defect1-'));
  const tempBin = path.join(tempDir, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  await t.test('assert alpha PNG success', () => {
    const imgPath = path.join(tempDir, 'valid_alpha.png');
    writeTestPNG(imgPath, 1536, 1872, true); // valid atlas dims with alpha

    const result = execFileSync(tempBin, ['--test-imageio-validate', imgPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.width, 1536);
    assert.strictEqual(parsed.height, 1872);
    assert.strictEqual(parsed.hasAlpha, true);
  });

  await t.test('valid redistributable WebP decode', () => {
    const imgPath = path.join(tempDir, 'valid.webp');
    fs.writeFileSync(imgPath, VALID_WEBP_BYTES);

    const result = execFileSync(tempBin, ['--test-frame-validate', imgPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.width, 1);
    assert.strictEqual(parsed.height, 1);
    assert.strictEqual(parsed.hasAlpha, true);
  });

  await t.test('corrupt and unsupported fail', () => {
    // 损坏的文件内容
    const imgPath = path.join(tempDir, 'corrupt.png');
    fs.writeFileSync(imgPath, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));

    const result = execFileSync(tempBin, ['--test-frame-validate', imgPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, false);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  });

  await t.test('opaque fails alpha policy', () => {
    const imgPath = path.join(tempDir, 'opaque.png');
    writeTestPNG(imgPath, 1536, 1872, false); // hasAlpha = false

    const result = execFileSync(tempBin, ['--test-imageio-validate', imgPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.error.includes('alpha'));
  });

  await t.test('invalid atlas dimensions fail', () => {
    const imgPath = path.join(tempDir, 'invalid_dim.png');
    writeTestPNG(imgPath, 100, 100, true); // invalid dimensions

    const result = execFileSync(tempBin, ['--test-imageio-validate', imgPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.error.includes('width') || parsed.error.includes('height') || parsed.error.includes('divisible'));
  });

  await t.test('reject support-formats but renamed to unsupported extension (.gif)', () => {
    const imgPath = path.join(tempDir, 'valid_png_but_renamed.gif');
    writeTestPNG(imgPath, 192, 208, true);

    const r1 = execFileSync(tempBin, ['--test-frame-validate', imgPath], { encoding: 'utf8' });
    const p1 = JSON.parse(r1.trim());
    assert.strictEqual(p1.valid, false);
    assert.ok(p1.error.toLowerCase().includes('unsupported') || p1.error.toLowerCase().includes('extension'));

    const r2 = execFileSync(tempBin, ['--test-imageio-validate', imgPath], { encoding: 'utf8' });
    const p2 = JSON.parse(r2.trim());
    assert.strictEqual(p2.valid, false);
    assert.ok(p2.error.toLowerCase().includes('unsupported') || p2.error.toLowerCase().includes('extension'));
  });

  // Cleanup
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
});

// -------------------------------------------------------------
// Test Case 2: validate-pet read-only and Isolated HOME (缺陷 2)
// -------------------------------------------------------------
test('Gate 2 Defect 2: validate-pet read-only isolated HOME behavior', async (t) => {
  const { handleValidatePet } = require('../bin/codex-pet-companion.js');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-defect2-'));
  const petRoot = path.join(testDir, 'pet-pkg');
  fs.mkdirSync(petRoot, { recursive: true });

  // 写入有效的 pet 结构
  const petJson = {
    id: 'pet-pkg',
    displayName: 'Test Pet',
    description: 'Test Description',
    spritesheetPath: 'sheet.png'
  };
  fs.writeFileSync(path.join(petRoot, 'pet.json'), JSON.stringify(petJson));
  writeTestPNG(path.join(petRoot, 'sheet.png'), 1536, 1872, true);

  // 记录 isolated HOME 的状态
  // 在 tests/index.js 里，CODEX_TIMER_OVERLAY_HOME 已经是隔离环境的临时目录了
  const isolatedHome = process.env.CODEX_TIMER_OVERLAY_HOME;
  assert.ok(isolatedHome);

  function takeSnapshot(dir) {
    const snapshot = {};
    if (!fs.existsSync(dir)) return snapshot;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        snapshot[f] = {
          size: stat.size,
          contentHash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        };
      }
    }
    return snapshot;
  }

  const initialSnapshot = takeSnapshot(isolatedHome);

  // 执行 handleValidatePet 并拦截退出
  const origExit = process.exit;
  const origLog = console.log;
  let exitCode = null;
  let stdoutMsg = '';

  process.exit = (code) => { exitCode = code; };
  console.log = (msg) => { stdoutMsg = msg; };

  try {
    handleValidatePet([petRoot]);
  } finally {
    process.exit = origExit;
    console.log = origLog;
  }

  assert.strictEqual(exitCode, 0);
  const parsedRes = JSON.parse(stdoutMsg);
  assert.strictEqual(parsedRes.valid, true);

  // 强断言：物理 Isolated HOME 在执行完后 remains byte-for-byte / file-list unchanged!
  const postSnapshot = takeSnapshot(isolatedHome);
  assert.deepStrictEqual(postSnapshot, initialSnapshot);

  // 验证临时目录被干净清理了：检查 /tmp 中不存在任何以 companion-validate-bin- 开头的残留临时文件夹
  const tmpFiles = fs.readdirSync(os.tmpdir());
  const residues = tmpFiles.filter(f => f.startsWith('companion-validate-bin-'));
  assert.strictEqual(residues.length, 0, `Temp directory leaked: ${residues.join(', ')}`);

  // Cleanup
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

// -------------------------------------------------------------
// Test Case 3: Preview state and exit (缺陷 3)
// -------------------------------------------------------------
test('Gate 2 Defect 3: preview state exit without dummy timer', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }

  const isolatedHome = process.env.CODEX_TIMER_OVERLAY_HOME;
  assert.ok(isolatedHome);
  const petRoot = path.join(isolatedHome, '.codex/pets/pet-pkg');
  fs.mkdirSync(petRoot, { recursive: true });

  const petJson = {
    id: 'pet-pkg',
    displayName: 'Test Pet',
    description: 'Test Description',
    spritesheetPath: 'sheet.png'
  };
  fs.writeFileSync(path.join(petRoot, 'pet.json'), JSON.stringify(petJson));
  writeTestPNG(path.join(petRoot, 'sheet.png'), 1536, 1872, true);

  // 递归快照 Isolated HOME
  function takeSnapshotRecursive(dir) {
    const snapshot = {};
    if (!fs.existsSync(dir)) return snapshot;
    function walk(currDir) {
      const files = fs.readdirSync(currDir);
      for (const f of files) {
        const p = path.join(currDir, f);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          walk(p);
        } else if (stat.isFile()) {
          const rel = path.relative(dir, p);
          snapshot[rel] = {
            size: stat.size,
            contentHash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
          };
        }
      }
    }
    walk(dir);
    return snapshot;
  }

  const initialSnapshot = takeSnapshotRecursive(isolatedHome);

  // 使用 child_process.spawn 启动 CLI preview exit 子进程
  const cliPath = path.join(__dirname, '..', 'bin', 'codex-pet-companion.js');
  
  const startTime = Date.now();
  
  const child = spawn('node', [cliPath, 'preview', '--pet', 'pet-pkg', '--state', 'exit'], {
    env: { ...process.env, CODEX_TIMER_OVERLAY_HOME: isolatedHome },
    stdio: 'pipe'
  });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  let exitCode = null;
  let postSnapshot = null;
  try {
    exitCode = await exitPromise;
    // 在清理 pet fixture 前记录快照
    postSnapshot = takeSnapshotRecursive(isolatedHome);
  } finally {
    try { fs.rmSync(petRoot, { recursive: true, force: true }); } catch (_) {}
  }

  const duration = Date.now() - startTime;

  assert.strictEqual(exitCode, 0, `Preview exit subcommand did not exit cleanly: ${exitCode}`);
  // 强断言 preview 退出前后的 isolated HOME 完全保持一致 (zero mutation)
  assert.deepStrictEqual(postSnapshot, initialSnapshot);

  // Use 25000ms threshold in CI to prevent flakiness, and 7000ms locally.
  const exitThreshold = process.env.CI ? 25000 : 7000;
  assert.ok(duration < exitThreshold, `Preview exit took too long: ${duration}ms (threshold: ${exitThreshold}ms)`);
});

// -------------------------------------------------------------
// Test Case 4: Per-clip runtime resilience and --test-runtime-config (缺陷 4, 5)
// -------------------------------------------------------------
test('Gate 2 Defect 4 & 5: per-clip resilience & --test-runtime-config', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }

  const { resolveClipFrames, getSafeRenderSettings } = require('../src/companion/companion-config-loader.js');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-defect4-'));
  const petRoot = path.join(testDir, 'resilient-pet');
  fs.mkdirSync(petRoot, { recursive: true });

  const petJson = {
    id: 'resilient-pet',
    displayName: 'Resilient Pet',
    description: 'Pet Description',
    spritesheetPath: 'sheet.png'
  };
  fs.writeFileSync(path.join(petRoot, 'pet.json'), JSON.stringify(petJson));
  writeTestPNG(path.join(petRoot, 'sheet.png'), 1536, 1872, true);

  // 1. 构造一个 companion.json：
  // - enter 正常（指向合法的 192x208 alpha png）
  // - rest 指向一个不存在的文件（应退化为 fallback）
  // - exit 指向一个不透明的 PNG（没有 alpha，应退化为 fallback）
  const enterFrame = path.join(petRoot, 'enter-1.png');
  writeTestPNG(enterFrame, 192, 208, true);

  const opaqueFrame = path.join(petRoot, 'exit-1.png');
  writeTestPNG(opaqueFrame, 192, 208, false); // opaque

  const companionJson = {
    schemaVersion: 1,
    petId: 'resilient-pet',
    render: {
      smallWidth: 90,
      restWidth: 400,
      interpolation: 'linear'
    },
    clips: {
      enter: {
        frames: ['enter-1.png'],
        fps: 5,
        loop: false
      },
      rest: {
        frames: ['nonexistent.png'],
        fps: 8,
        loop: true
      },
      exit: {
        frames: ['exit-1.png'],
        fps: 12,
        loop: false
      }
    }
  };

  fs.writeFileSync(path.join(petRoot, 'companion.json'), JSON.stringify(companionJson));

  // 2. 模拟 runtime 环境下的 resolveClipFrames 校验
  // 我们需要在 resolveClipFrames 执行前，编译出真实的 Swift 二进制。
  // 因为 resolveClipFrames 中会检测二进制存在性并做真实 frame 校验。
  const companionPaths = require('../src/companion/paths.js');
  const tempBin = companionPaths.COMPANION_BINARY;
  compileSwiftRenderer(tempBin);

  const configResult = {
    valid: false, // 模拟有错误的 configResult
    clips: companionJson.clips,
    render: companionJson.render
  };

  const resolvedClips = resolveClipFrames(configResult, petJson, 9, petRoot, tempBin);

  // 强断言：只坏的 clips 退化，好的保留！
  // - enter 必须保留真实帧
  assert.strictEqual(resolvedClips.enter.fallback, false);
  assert.deepStrictEqual(resolvedClips.enter.frames, [fs.realpathSync(enterFrame)]);
  assert.strictEqual(resolvedClips.enter.fps, 5);

  // 5b. 验证当未提供 validatorBinPath 验证器时，自定义 clips 必须 fail closed 到 fallback！
  const resolvedClipsNoVal = resolveClipFrames(configResult, petJson, 9, petRoot);
  assert.strictEqual(resolvedClipsNoVal.enter.fallback, true);
  assert.strictEqual(resolvedClipsNoVal.rest.fallback, true);
  assert.strictEqual(resolvedClipsNoVal.exit.fallback, true);

  // - rest fallback
  assert.strictEqual(resolvedClips.rest.fallback, true);

  // - exit fallback
  assert.strictEqual(resolvedClips.exit.fallback, true);

  // 3. 强断言：Preserve safe render settings
  const safeRender = getSafeRenderSettings(companionJson);
  assert.strictEqual(safeRender.smallWidth, 90);
  assert.strictEqual(safeRender.restWidth, 400);
  assert.strictEqual(safeRender.interpolation, 'linear');

  // 4. 测试 --test-runtime-config 报告 JSON
  const resolvedVisualConfig = {
    atlasPath: path.join(petRoot, 'sheet.png'),
    smallWidth: safeRender.smallWidth,
    restWidth: safeRender.restWidth,
    interpolation: safeRender.interpolation,
    atlasRows: 9,
    clips: resolvedClips
  };

  const runtimeConfigPath = path.join(testDir, 'resolved-companion-config.json');
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(resolvedVisualConfig));

  const configReportStr = execFileSync(tempBin, ['--config', runtimeConfigPath, '--test-runtime-config'], { encoding: 'utf8' });
  const report = JSON.parse(configReportStr.trim());

  assert.strictEqual(report.smallWidth, 90);
  assert.strictEqual(report.restWidth, 400);
  assert.strictEqual(report.interpolation, 'linear');
  assert.strictEqual(report.clips.enter.fallback, false);
  assert.strictEqual(report.clips.enter.frameCount, 1);
  assert.strictEqual(report.clips.enter.fps, 5);
  assert.strictEqual(report.clips.rest.fallback, true);
  assert.strictEqual(report.clips.rest.frameCount, 8); // fallback 默认 8 帧

  // Cleanup
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

test('Gate 2 Defect 4b: Schema v2 atlasFrames & restHeightRatio runtime resolution', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }

  const { resolveClipFrames, getSafeRenderSettings } = require('../src/companion/companion-config-loader.js');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-v2-'));
  const petRoot = path.join(testDir, 'v2-pet');
  fs.mkdirSync(petRoot, { recursive: true });

  const petJson = {
    id: 'v2-pet',
    displayName: 'V2 Pet',
    description: 'V2 Pet Description',
    spritesheetPath: 'sheet.png'
  };
  fs.writeFileSync(path.join(petRoot, 'pet.json'), JSON.stringify(petJson));
  writeTestPNG(path.join(petRoot, 'sheet.png'), 1536, 1872, true);

  const companionJsonV2 = {
    schemaVersion: 2,
    petId: 'v2-pet',
    render: {
      restHeightRatio: 0.8,
      interpolation: 'nearest'
    },
    clips: {
      rest: {
        atlasFrames: [{ row: 5, column: 4 }, { row: 5, column: 5 }],
        fps: 2,
        loop: true
      }
    }
  };
  fs.writeFileSync(path.join(petRoot, 'companion.json'), JSON.stringify(companionJsonV2));

  const companionPaths = require('../src/companion/paths.js');
  const tempBin = companionPaths.COMPANION_BINARY;
  compileSwiftRenderer(tempBin);

  const configResult = {
    valid: true,
    clips: companionJsonV2.clips,
    render: companionJsonV2.render
  };

  const resolvedClips = resolveClipFrames(configResult, petJson, 9, petRoot, tempBin);
  assert.strictEqual(resolvedClips.rest.fallback, false);
  assert.deepStrictEqual(resolvedClips.rest.atlasFrames, [{ row: 5, column: 4 }, { row: 5, column: 5 }]);

  const safeRender = getSafeRenderSettings(companionJsonV2);
  assert.strictEqual(safeRender.restHeightRatio, 0.8);
  assert.strictEqual(safeRender.targetHeightRatio, 0.8);

  const resolvedVisualConfig = {
    atlasPath: path.join(petRoot, 'sheet.png'),
    smallWidth: safeRender.smallWidth,
    restWidth: safeRender.restWidth,
    targetHeightRatio: safeRender.targetHeightRatio,
    interpolation: safeRender.interpolation,
    atlasRows: 9,
    clips: resolvedClips
  };

  const runtimeConfigPath = path.join(testDir, 'resolved-v2-config.json');
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(resolvedVisualConfig));

  const configReportStr = execFileSync(tempBin, ['--config', runtimeConfigPath, '--test-runtime-config'], { encoding: 'utf8' });
  const report = JSON.parse(configReportStr.trim());

  assert.strictEqual(report.clips.rest.fallback, false);
  assert.strictEqual(report.clips.rest.frameCount, 2);
  assert.strictEqual(report.clips.rest.fps, 2);

  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

test('Gate 2 Defect 4c: Schema v1 fixed-width vs Schema v2 ratio mode sizing resolution', async (t) => {
  const { validateCompanionConfig, getSafeRenderSettings } = require('../src/companion/companion-config-loader.js');

  const companionJsonV1 = {
    schemaVersion: 1,
    petId: 'v1-pet',
    render: {
      smallWidth: 84,
      restWidth: 420,
      interpolation: 'nearest',
    },
    clips: {},
  };
  const safeRenderV1 = getSafeRenderSettings(companionJsonV1);
  assert.strictEqual(safeRenderV1.sizingMode, 'fixedWidth');
  assert.strictEqual(safeRenderV1.restWidth, 420);

  const companionJsonV2 = {
    schemaVersion: 2,
    petId: 'v2-pet',
    render: {
      restHeightRatio: 0.75,
      interpolation: 'linear',
    },
    clips: {},
  };
  const safeRenderV2 = getSafeRenderSettings(companionJsonV2);
  assert.strictEqual(safeRenderV2.sizingMode, 'restHeightRatio');
  assert.strictEqual(safeRenderV2.restHeightRatio, 0.75);

  if (!hasXcrun) {
    return;
  }

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-v1v2-'));
  const companionPaths = require('../src/companion/paths.js');
  const tempBin = companionPaths.COMPANION_BINARY;
  compileSwiftRenderer(tempBin);

  const v1VisualConfig = {
    atlasPath: path.join(testDir, 'sheet.png'),
    smallWidth: safeRenderV1.smallWidth,
    restWidth: safeRenderV1.restWidth,
    targetHeightRatio: safeRenderV1.targetHeightRatio,
    sizingMode: safeRenderV1.sizingMode,
    interpolation: safeRenderV1.interpolation,
    atlasRows: 9,
    clips: {},
  };
  const configPathV1 = path.join(testDir, 'v1-resolved.json');
  fs.writeFileSync(configPathV1, JSON.stringify(v1VisualConfig));

  const reportV1Str = execFileSync(tempBin, ['--config', configPathV1, '--test-runtime-config'], { encoding: 'utf8' });
  const reportV1 = JSON.parse(reportV1Str.trim());
  assert.strictEqual(reportV1.sizingMode, 'fixedWidth');
  assert.strictEqual(reportV1.restWidth, 420);

  const v2VisualConfig = {
    atlasPath: path.join(testDir, 'sheet.png'),
    smallWidth: safeRenderV2.smallWidth,
    restWidth: safeRenderV2.restWidth,
    targetHeightRatio: safeRenderV2.targetHeightRatio,
    sizingMode: safeRenderV2.sizingMode,
    interpolation: safeRenderV2.interpolation,
    atlasRows: 9,
    clips: {},
  };
  const configPathV2 = path.join(testDir, 'v2-resolved.json');
  fs.writeFileSync(configPathV2, JSON.stringify(v2VisualConfig));

  const reportV2Str = execFileSync(tempBin, ['--config', configPathV2, '--test-runtime-config'], { encoding: 'utf8' });
  const reportV2 = JSON.parse(reportV2Str.trim());
  assert.strictEqual(reportV2.sizingMode, 'restHeightRatio');

  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});
