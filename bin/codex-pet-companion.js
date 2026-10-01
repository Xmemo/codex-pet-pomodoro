#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parsePetManifest, validateAtlasDimensions, resolvePetId, normalizePetId } = require('../src/companion/manifest-loader.js');
const { validateCompanionConfig, validateFrames, resolveClipFrames, getSafeRenderSettings } = require('../src/companion/companion-config-loader.js');
const { startBridge, compileSwiftRenderer } = require('../src/companion/bridge.js');
const companionPathsMod = require('../src/companion/paths.js');
const statusMod = require('../src/companion/status.js');
const lifecycle = require('../src/companion/worker-lifecycle.js');
const serviceManager = require('../src/companion/service-manager.js');

function printUsage() {
  console.log('Usage: codex-pet-companion <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  validate-pet <path>           Validate a pet package');
  console.log('  preview --pet <id> --state <s> Preview an animation state');
  console.log('  start                         Start the background companion service');
  console.log('  stop                          Stop the background companion service');
  console.log('  status                        Query engine status');
  console.log('  doctor --json                 Diagnose permissions and runtime health');
  console.log('  repair                        Restart the supervisor after fixing a cause');
  console.log('  config set pet <id|auto>      Set pet configuration');
  console.log('  --help                        Show this help');
}

function failExit(msg, code = 1) {
  console.log(JSON.stringify({ valid: false, errors: Array.isArray(msg) ? msg : [msg] }));
  process.exit(code);
}

function handleValidatePet(args) {
  const crypto = require('crypto');
  const os = require('os');
  const tempBinDir = fs.mkdtempSync(path.join(os.tmpdir(), `companion-validate-bin-${crypto.randomBytes(8).toString('hex')}`));
  const binPath = path.join(tempBinDir, 'companion_renderer');

  let exitCode = 0;
  let outputObj = null;

  try {
    const petPath = args[0];
    if (!petPath) {
      outputObj = { valid: false, errors: ['pet path is required'] };
      exitCode = 1;
      return;
    }

    const absPath = path.resolve(petPath);
    const petJsonPath = path.join(absPath, 'pet.json');

    if (!fs.existsSync(petJsonPath)) {
      outputObj = { valid: false, errors: ['pet.json not found'] };
      exitCode = 1;
      return;
    }

    let petJson;
    try {
      petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
    } catch (err) {
      outputObj = { valid: false, errors: [`Failed to parse pet.json: ${err.message}`] };
      exitCode = 1;
      return;
    }

    const manifestResult = parsePetManifest(absPath, petJson);
    if (!manifestResult.valid || !manifestResult.pet) {
      outputObj = { valid: false, errors: manifestResult.errors || ['Invalid pet manifest'] };
      exitCode = 1;
      return;
    }

    const spritesheetFullPath = manifestResult.pet.spritesheetFullPath;

    let atlasResult;
    try {
      compileSwiftRenderer(binPath);
      const imageInfoStr = execFileSync(binPath, ['--test-imageio-validate', spritesheetFullPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const imageInfo = JSON.parse(imageInfoStr.trim());
      if (!imageInfo.valid) {
        outputObj = { valid: false, errors: [imageInfo.error || 'Failed to validate spritesheet image'] };
        exitCode = 1;
        return;
      }
      if (!imageInfo.hasAlpha) {
        outputObj = { valid: false, errors: ['Spritesheet must have an alpha channel'] };
        exitCode = 1;
        return;
      }
      atlasResult = validateAtlasDimensions(imageInfo.width, imageInfo.height);
      if (!atlasResult.valid) {
        outputObj = { valid: false, errors: atlasResult.errors };
        exitCode = 1;
        return;
      }
    } catch (err) {
      outputObj = { valid: false, errors: [`Failed to validate spritesheet dimensions: ${err.message}`] };
      exitCode = 1;
      return;
    }

    const companionJsonPath = path.join(absPath, 'companion.json');
    let companionJsonLoaded = false;
    let frameErrors = [];
    if (fs.existsSync(companionJsonPath)) {
      let companionJson;
      try {
        companionJson = JSON.parse(fs.readFileSync(companionJsonPath, 'utf8'));
      } catch (err) {
        outputObj = { valid: false, errors: [`Failed to parse companion.json: ${err.message}`] };
        exitCode = 1;
        return;
      }
      const configResult = validateCompanionConfig(companionJson, manifestResult.pet.id, absPath);
      if (configResult.valid) {
        companionJsonLoaded = true;
        for (const [clipName, clip] of Object.entries(configResult.clips)) {
          if (Array.isArray(clip.frames) && clip.frames.length > 0) {
            const frameValidation = validateFrames(clip.frames, absPath, binPath,
              (b, flag, fp) => {
                const r = execFileSync(b, [flag, fp], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
                return JSON.parse(r.trim());
              });
            if (frameValidation.errors.length > 0) {
              frameErrors.push(...frameValidation.errors.map(e => `clip "${clipName}": ${e}`));
            }
          } else if (Array.isArray(clip.atlasFrames) && clip.atlasFrames.length > 0) {
            for (const af of clip.atlasFrames) {
              if (af.row >= atlasResult.rows) {
                frameErrors.push(`clip "${clipName}": atlasFrame row ${af.row} out of range [0, ${atlasResult.rows - 1}]`);
              }
            }
          }
        }
        if (frameErrors.length > 0) {
          outputObj = { valid: false, errors: frameErrors };
          exitCode = 1;
          return;
        }
      } else {
        outputObj = { valid: false, errors: configResult.errors };
        exitCode = 1;
        return;
      }
    }

    outputObj = {
      valid: true,
      pet: manifestResult.pet.id,
      atlasRows: atlasResult.rows,
      companionJson: companionJsonLoaded,
    };
    exitCode = 0;
  } catch (globalErr) {
    outputObj = { valid: false, errors: [globalErr.message] };
    exitCode = 1;
  } finally {
    try {
      fs.rmSync(tempBinDir, { recursive: true, force: true });
    } catch (_) {}

    if (outputObj) {
      console.log(JSON.stringify(outputObj));
    }
    process.exit(exitCode);
  }
}

function handlePreview(args) {
  const petIndex = args.indexOf('--pet');
  const stateIndex = args.indexOf('--state');
  const petId = petIndex >= 0 ? args[petIndex + 1] : null;
  const state = stateIndex >= 0 ? args[stateIndex + 1] : 'rest';

  if (!petId || typeof petId !== 'string') {
    console.error('Error: --pet <id> is required for preview');
    process.exit(1);
    return;
  }

  if (state !== 'enter' && state !== 'rest' && state !== 'exit') {
    console.error(`Error: Invalid state "${state}". State must be enter, rest, or exit`);
    process.exit(1);
    return;
  }

  const plainPetId = normalizePetId(petId);
  const petDir = path.join(companionPathsMod.PETS_ROOT, plainPetId);
  const petJsonPath = path.join(petDir, 'pet.json');
  if (!fs.existsSync(petJsonPath)) {
    console.error(`Error: Pet "${plainPetId}" not found at ${petDir}`);
    process.exit(1);
    return;
  }

  const crypto = require('crypto');
  const os = require('os');
  const tempPreviewDir = fs.mkdtempSync(path.join(os.tmpdir(), `companion-preview-${crypto.randomBytes(8).toString('hex')}`));
  const binPath = path.join(tempPreviewDir, 'companion_renderer');
  const resolvedConfigPath = path.join(tempPreviewDir, 'config.json');

  let bridge = null;

  const cleanup = () => {
    if (bridge) {
      try { bridge.stop(); } catch (_) {}
    }
    try {
      fs.rmSync(tempPreviewDir, { recursive: true, force: true });
    } catch (_) {}
  };

  try {
    let petJson;
    try {
      petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
    } catch (err) {
      console.error(`Error parsing pet.json: ${err.message}`);
      process.exit(1);
      return;
    }

    const manifestResult = parsePetManifest(petDir, petJson);
    if (!manifestResult.valid || !manifestResult.pet) {
      console.error(`Error in pet manifest: ${manifestResult.errors.join(', ')}`);
      process.exit(1);
      return;
    }

    const petManifest = manifestResult.pet;

    const companionJsonPath = path.join(petDir, 'companion.json');
    let companionJson = null;
    let configResult = { valid: false, errors: [], clips: {}, render: {} };
    if (fs.existsSync(companionJsonPath)) {
      try {
        companionJson = JSON.parse(fs.readFileSync(companionJsonPath, 'utf8'));
        configResult = validateCompanionConfig(companionJson, petManifest.id, petDir);
      } catch (err) {
        console.error(`Error parsing companion.json: ${err.message}`);
        process.exit(1);
        return;
      }
    }

    // Compile Swift renderer into the temp folder only
    compileSwiftRenderer(binPath);

    let width = 1536;
    let height = 1872;
    let atlasRows = 9;
    try {
      const imageInfoStr = execFileSync(binPath, ['--test-imageio-validate', petManifest.spritesheetFullPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const imageInfo = JSON.parse(imageInfoStr.trim());
      if (imageInfo.valid) {
        width = imageInfo.width;
        height = imageInfo.height;
        atlasRows = Math.floor(height / 208);
      }
    } catch (err) {}

    // Explicitly inject the compiled validation binary
    const resolvedClips = resolveClipFrames(
      configResult,
      petManifest,
      atlasRows,
      petDir,
      binPath
    );

    const safeRender = getSafeRenderSettings(companionJson);

    const resolvedVisualConfig = {
      petId: petManifest.id,
      atlasPath: petManifest.spritesheetFullPath,
      smallWidth: safeRender.smallWidth,
      restWidth: safeRender.restWidth,
      targetHeightRatio: safeRender.targetHeightRatio,
      sizingMode: safeRender.sizingMode,
      interpolation: safeRender.interpolation,
      atlasRows: atlasRows,
      clips: resolvedClips
    };

    // Write resolved config to the temp folder only
    fs.writeFileSync(resolvedConfigPath, JSON.stringify(resolvedVisualConfig, null, 2));

    bridge = startBridge({
      binPath,
      extraArgs: ['--preview', '--preview-state', state, '--config', resolvedConfigPath],
    });
    bridge.start();

    const shutdown = () => {
      cleanup();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    process.stdin.on('end', shutdown);
    process.stdin.resume();

    const pollInterval = setInterval(() => {
      if (!bridge.getIsRunning()) {
        clearInterval(pollInterval);
        shutdown();
      }
    }, 100);
    pollInterval.unref();

  } catch (err) {
    console.error(`Error: ${err.message}`);
    cleanup();
    process.exit(1);
  }
}

async function handleStart() {
  try {
    const result = serviceManager.start();
    console.log(result.alreadyRunning ? 'Pet companion service is already running.' : 'Pet companion service started.');
    process.exit(0);
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(1);
  }
}

async function handleStop() {
  try {
    const result = serviceManager.stop();
    console.log(result.alreadyStopped ? 'Pet companion service is already stopped.' : 'Pet companion service stopped for this login session.');
    process.exit(0);
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(1);
  }
}

function handleDoctor() {
  const result = serviceManager.doctor();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function handleRepair() {
  try {
    const result = serviceManager.repair();
    console.log(result.action);
    process.exit(0);
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(1);
  }
}

function handleStatus() {
  const deps = lifecycle.createDeps();
  const result = lifecycle.statusManager(deps);
  const useJson = process.argv.includes('--json');

  if (useJson) {
    console.log(JSON.stringify(result.status, null, 2));
  } else {
    console.log(statusMod.formatHuman(result.status));
  }
  process.exit(0);
}

async function handleWorker() {
  const argv = process.argv.slice(2);
  const tokenIndex = argv.indexOf('--ready-token');
  const token = tokenIndex >= 0 ? argv[tokenIndex + 1] : null;
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    console.error('Error: --worker requires a valid readiness token');
    process.exit(1);
    return;
  }
  const deps = lifecycle.createDeps({ readyToken: token });
  const result = await lifecycle.runWorker(deps);
  if (result && result.ok === false) {
    console.error('Error: ' + (result.error || 'worker startup failed'));
    process.exit(result.code || 1);
  }
}

function handleConfig(args) {
  if (args[0] !== 'set' || args[1] !== 'pet' || !args[2]) {
    console.error('Usage: codex-pet-companion config set pet <id|auto>');
    process.exit(1);
    return;
  }

  const value = args[2];
  const configDir = path.dirname(companionPathsMod.COMPANION_CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let petIdValue = value === 'auto' ? null : value;
  if (petIdValue && petIdValue.startsWith('custom:')) {
    petIdValue = petIdValue.substring(7);
  }

  const config = { petId: petIdValue };
  fs.writeFileSync(companionPathsMod.COMPANION_CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Pet configuration set to: ${value === 'auto' ? 'auto' : petIdValue}`);
}

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (!cmd || cmd === '--help') {
    printUsage();
    process.exit(cmd === '--help' ? 0 : 1);
    return;
  }

  switch (cmd) {
    case 'validate-pet':
      handleValidatePet(rest);
      break;
    case 'preview':
      handlePreview(rest);
      break;
    case 'start':
      await handleStart();
      break;
    case 'stop':
      await handleStop();
      break;
    case 'status':
      handleStatus();
      break;
    case 'doctor':
      handleDoctor();
      break;
    case 'repair':
      handleRepair();
      break;
    case 'config':
      handleConfig(rest);
      break;
    case '--worker':
      await handleWorker();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  handleValidatePet,
  handlePreview,
  handleStart,
  handleStop,
  handleStatus,
  handleWorker,
  handleConfig,
  printUsage,
  resolvePetId,
};
