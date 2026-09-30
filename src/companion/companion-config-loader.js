const fs = require('fs');
const path = require('path');
const { validatePathSecurity } = require('./manifest-loader.js');

const VALID_FRAME_EXTENSIONS = new Set(['.png', '.webp']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_DIMENSION = 2048;
const MAX_FRAME_PIXELS = 4 * 1024 * 1024;
const MAX_TOTAL_DECODED_PIXELS = 16 * 1024 * 1024;
const MAX_FRAMES_PER_CLIP = 60;
const MAX_TOTAL_CLIP_FRAMES = 120;
const MAX_ATLAS_ROWS = 16;

function validateFrameImage(framePath, petDir, binPath, runSwiftFn) {
  const ext = path.extname(framePath).toLowerCase();
  if (!VALID_FRAME_EXTENSIONS.has(ext)) {
    return { valid: false, error: `Invalid extension "${ext}" for frame "${framePath}". Only .png and .webp allowed` };
  }

  const check = validatePathSecurity(framePath, petDir);
  if (!check.safe) {
    return { valid: false, error: `Path security: ${check.reason}` };
  }

  if (!fs.existsSync(check.resolved)) {
    return { valid: false, error: `Frame file not found: ${framePath}` };
  }

  const stat = fs.statSync(check.resolved);
  if (!stat.isFile()) {
    return { valid: false, error: `Frame path must be a regular file: ${framePath}` };
  }
  if (stat.size <= 0 || stat.size > MAX_FRAME_BYTES) {
    return { valid: false, error: `Frame "${framePath}" must be between 1 byte and ${MAX_FRAME_BYTES} bytes` };
  }

  try {
    const info = runSwiftFn(binPath, '--test-frame-validate', check.resolved);
    if (!info.valid) {
      return { valid: false, error: info.error || 'Failed to validate frame image' };
    }
    if (!info.hasAlpha) {
      return { valid: false, error: `Frame "${framePath}" must have an alpha channel` };
    }
    if (!Number.isInteger(info.width) || !Number.isInteger(info.height) ||
        info.width < 1 || info.height < 1 || info.width > MAX_FRAME_DIMENSION ||
        info.height > MAX_FRAME_DIMENSION || info.width * info.height > MAX_FRAME_PIXELS) {
      return { valid: false, error: `Frame "${framePath}" exceeds the ${MAX_FRAME_DIMENSION}px / ${MAX_FRAME_PIXELS}-pixel decode limit` };
    }
    return { valid: true, width: info.width, height: info.height };
  } catch (err) {
    return { valid: false, error: `Failed to validate frame "${framePath}": ${err.message}` };
  }
}

function validateFrames(framePaths, petDir, binPath, runSwiftFn) {
  const errors = [];
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    return { valid: false, errors: ['Frame array is empty or missing'] };
  }
  if (framePaths.length > MAX_FRAMES_PER_CLIP) {
    return { valid: false, errors: [`Frame array exceeds ${MAX_FRAMES_PER_CLIP} frames`] };
  }

  const results = [];
  for (const fp of framePaths) {
    const r = validateFrameImage(fp, petDir, binPath, runSwiftFn);
    results.push(r);
    if (!r.valid) errors.push(r.error);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check that all frames in a clip have identical dimensions
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i].width !== first.width || results[i].height !== first.height) {
      errors.push(
        `Frame dimension mismatch: "${framePaths[i]}" is ${results[i].width}x${results[i].height}, expected ${first.width}x${first.height}`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateCompanionConfig(config, petId, petDir) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['companion.json must be a JSON object'], clips: {} };
  }

  if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
    errors.push(`schemaVersion must be 1 or 2, got ${config.schemaVersion}`);
  }

  if (config.petId !== petId) {
    errors.push(`petId mismatch: expected "${petId}", got "${config.petId}"`);
  }

  const render = config.render || {};
  if (render.smallWidth !== undefined) {
    if (!Number.isInteger(render.smallWidth) || render.smallWidth < 32 || render.smallWidth > 256) {
      errors.push('render.smallWidth must be an integer in [32, 256]');
    }
  }
  if (render.restWidth !== undefined) {
    if (!Number.isInteger(render.restWidth) || render.restWidth < 96 || render.restWidth > 768) {
      errors.push('render.restWidth must be an integer in [96, 768]');
    }
    const sw = render.smallWidth !== undefined ? render.smallWidth : 84;
    if (render.restWidth < sw) {
      errors.push('render.restWidth must be >= render.smallWidth');
    }
  }
  if (config.schemaVersion === 1 && render.restHeightRatio !== undefined) {
    errors.push('render.restHeightRatio is only allowed in schema v2');
  } else if (render.restHeightRatio !== undefined) {
    if (typeof render.restHeightRatio !== 'number' || !Number.isFinite(render.restHeightRatio) || render.restHeightRatio < 0.4 || render.restHeightRatio > 0.9) {
      errors.push('render.restHeightRatio must be a finite number in [0.4, 0.9]');
    }
  }
  if (config.schemaVersion === 1 && render.anchor !== undefined && render.anchor !== 'pet-bottom-center') {
    errors.push('render.anchor must be "pet-bottom-center" in schema v1');
  }
  if (render.interpolation !== undefined && render.interpolation !== 'nearest' && render.interpolation !== 'linear') {
    errors.push('render.interpolation must be "nearest" or "linear"');
  }

  const clips = config.clips || {};
  const validClipNames = ['enter', 'rest', 'exit'];
  const parsedClips = {};
  let totalClipFrames = 0;
  let totalFrameBytes = 0;
  const measuredFramePaths = new Set();

  for (const [name, clip] of Object.entries(clips)) {
    if (!validClipNames.includes(name)) continue;

    if (!clip || typeof clip !== 'object') {
      errors.push(`clip "${name}" must be an object`);
      continue;
    }

    if (config.schemaVersion === 1 && clip.atlasFrames !== undefined) {
      errors.push(`clip "${name}" atlasFrames is only allowed in schema v2`);
      continue;
    }

    const hasFrames = Array.isArray(clip.frames) && clip.frames.length > 0;
    const hasAtlasFrames = Array.isArray(clip.atlasFrames) && clip.atlasFrames.length > 0;

    if ((hasFrames && hasAtlasFrames) || (!hasFrames && !hasAtlasFrames)) {
      errors.push(`clip "${name}" must define exactly one non-empty frames or atlasFrames`);
      continue;
    }

    const frameCount = hasFrames ? clip.frames.length : clip.atlasFrames.length;
    if (frameCount > MAX_FRAMES_PER_CLIP) {
      errors.push(`clip "${name}" exceeds ${MAX_FRAMES_PER_CLIP} frames`);
      continue;
    }
    totalClipFrames += frameCount;
    if (totalClipFrames > MAX_TOTAL_CLIP_FRAMES) {
      errors.push(`companion.json exceeds ${MAX_TOTAL_CLIP_FRAMES} total clip frames`);
      continue;
    }

    if (!Number.isInteger(clip.fps) || clip.fps < 1 || clip.fps > 12) {
      errors.push(`clip "${name}" fps must be an integer in [1, 12]`);
      continue;
    }

    if (clip.loop !== undefined && typeof clip.loop !== 'boolean') {
      errors.push(`clip "${name}" loop must be a boolean`);
      continue;
    }

    if (hasFrames) {
      for (const framePath of clip.frames) {
        if (typeof framePath !== 'string') {
          errors.push(`clip "${name}" frame path must be a string`);
          continue;
        }
        const ext = path.extname(framePath).toLowerCase();
        if (!VALID_FRAME_EXTENSIONS.has(ext)) {
          errors.push(`clip "${name}" frame path "${framePath}" has invalid extension. Only .png and .webp allowed`);
          continue;
        }
        const check = validatePathSecurity(framePath, petDir);
        if (!check.safe) {
          errors.push(`clip "${name}" frame path "${framePath}": ${check.reason}`);
        } else if (!fs.existsSync(check.resolved)) {
          errors.push(`clip "${name}" frame file not found: ${framePath}`);
        } else {
          const stat = fs.statSync(check.resolved);
          if (!stat.isFile()) {
            errors.push(`clip "${name}" frame path "${framePath}" must be a regular file`);
          } else if (stat.size <= 0 || stat.size > MAX_FRAME_BYTES) {
            errors.push(`clip "${name}" frame "${framePath}" must be between 1 byte and ${MAX_FRAME_BYTES} bytes`);
          } else if (!measuredFramePaths.has(check.resolved)) {
            measuredFramePaths.add(check.resolved);
            totalFrameBytes += stat.size;
          }
        }
      }

      parsedClips[name] = {
        frames: clip.frames,
        fps: clip.fps,
        loop: clip.loop !== undefined ? clip.loop : (name === 'rest'),
      };
    } else if (hasAtlasFrames) {
      let validAtlas = true;
      for (const af of clip.atlasFrames) {
        if (!af || typeof af !== 'object' || Array.isArray(af)) {
          errors.push(`clip "${name}" atlasFrame must be an object with row and column`);
          validAtlas = false;
          break;
        }
        if (!Number.isInteger(af.column) || af.column < 0 || af.column > 7) {
          errors.push(`clip "${name}" atlasFrame column must be integer in [0, 7]`);
          validAtlas = false;
          break;
        }
        if (!Number.isInteger(af.row) || af.row < 0 || af.row >= MAX_ATLAS_ROWS) {
          errors.push(`clip "${name}" atlasFrame row must be an integer in [0, ${MAX_ATLAS_ROWS - 1}]`);
          validAtlas = false;
          break;
        }
      }

      if (validAtlas) {
        parsedClips[name] = {
          atlasFrames: clip.atlasFrames,
          fps: clip.fps,
          loop: clip.loop !== undefined ? clip.loop : (name === 'rest'),
        };
      }
    }
  }

  if (totalFrameBytes > MAX_TOTAL_FRAME_BYTES) {
    errors.push(`companion.json frame files exceed ${MAX_TOTAL_FRAME_BYTES} total bytes`);
  }

  let restHeightRatio = undefined;
  if (typeof render.restHeightRatio === 'number' && Number.isFinite(render.restHeightRatio) && render.restHeightRatio >= 0.4 && render.restHeightRatio <= 0.9) {
    restHeightRatio = render.restHeightRatio;
  }

  return {
    valid: errors.length === 0,
    errors,
    clips: parsedClips,
    render: {
      smallWidth: render.smallWidth || 84,
      restWidth: render.restWidth || 360,
      restHeightRatio: restHeightRatio !== undefined ? restHeightRatio : 0.72,
      anchor: render.anchor || 'pet-bottom-center',
      interpolation: render.interpolation || 'nearest',
    },
  };
}


function getSafeRenderSettings(config) {
  const render = (config && config.render) || {};
  let sw = 84;
  if (Number.isInteger(render.smallWidth) && render.smallWidth >= 32 && render.smallWidth <= 256) {
    sw = render.smallWidth;
  }
  let rw = 360;
  if (Number.isInteger(render.restWidth) && render.restWidth >= 96 && render.restWidth <= 768 && render.restWidth >= sw) {
    rw = render.restWidth;
  }
  let ratio = 0.72;
  if (typeof render.restHeightRatio === 'number' && Number.isFinite(render.restHeightRatio) && render.restHeightRatio >= 0.4 && render.restHeightRatio <= 0.9) {
    ratio = render.restHeightRatio;
  }
  let interp = 'nearest';
  if (render.interpolation === 'nearest' || render.interpolation === 'linear') {
    interp = render.interpolation;
  }
  let anchor = 'pet-bottom-center';
  if (render.anchor === 'pet-bottom-center') {
    anchor = render.anchor;
  }
  let sizingMode = 'restHeightRatio';
  if (config && config.schemaVersion === 1) {
    sizingMode = 'fixedWidth';
  } else if (config && config.schemaVersion === 2) {
    sizingMode = 'restHeightRatio';
  }
  return {
    smallWidth: sw,
    restWidth: rw,
    restHeightRatio: ratio,
    targetHeightRatio: ratio,
    sizingMode: sizingMode,
    interpolation: interp,
    anchor: anchor
  };
}

function resolveClipFrames(configResult, manifestResult, atlasRows, petDir, validatorBinPath) {
  const clips = {};
  const dir = petDir || '.';

  let resolvedPetDir = dir;
  try {
    resolvedPetDir = fs.realpathSync(dir);
  } catch (_) {
    resolvedPetDir = path.resolve(dir);
  }

  const hasBin = validatorBinPath && fs.existsSync(validatorBinPath);

  const validatedFrames = new Map();
  let totalDecodedPixels = 0;

  function validateClipRuntime(clip) {
    if (!clip || !Array.isArray(clip.frames) || clip.frames.length === 0) return false;
    if (clip.frames.length > MAX_FRAMES_PER_CLIP) return false;
    
    let firstWidth = null;
    let firstHeight = null;
    
    for (const fp of clip.frames) {
      if (typeof fp !== 'string') return false;
      
      const ext = path.extname(fp).toLowerCase();
      if (ext !== '.png' && ext !== '.webp') return false;
      
      if (petDir) {
        if (!hasBin) {
          return false;
        }

        const check = validatePathSecurity(fp, resolvedPetDir);
        if (!check.safe) return false;
        
        const resolvedPath = check.resolved;
        if (!fs.existsSync(resolvedPath)) return false;
        
        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) return false;
        
        try {
          let info = validatedFrames.get(resolvedPath);
          if (!info) {
            const { execFileSync } = require('child_process');
            const resStr = execFileSync(validatorBinPath, ['--test-frame-validate', resolvedPath], {
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
              timeout: 5000,
            });
            info = JSON.parse(resStr.trim());
            if (!info.valid || !info.hasAlpha || !Number.isInteger(info.width) || !Number.isInteger(info.height) ||
                info.width < 1 || info.height < 1 || info.width > MAX_FRAME_DIMENSION ||
                info.height > MAX_FRAME_DIMENSION || info.width * info.height > MAX_FRAME_PIXELS) return false;
            const decodedPixels = info.width * info.height;
            if (totalDecodedPixels + decodedPixels > MAX_TOTAL_DECODED_PIXELS) return false;
            totalDecodedPixels += decodedPixels;
            validatedFrames.set(resolvedPath, info);
          }
          if (!info.valid || !info.hasAlpha) return false;
          
          if (firstWidth === null) {
            firstWidth = info.width;
            firstHeight = info.height;
          } else {
            if (info.width !== firstWidth || info.height !== firstHeight) {
              return false;
            }
          }
        } catch (err) {
          return false;
        }
      }
    }
    return true;
  }

  function validateAtlasFramesRuntime(clip, rows) {
    if (!clip || !Array.isArray(clip.atlasFrames) || clip.atlasFrames.length === 0) return false;
    for (const af of clip.atlasFrames) {
      if (!af || typeof af !== 'object' || Array.isArray(af)) return false;
      if (!Number.isInteger(af.column) || af.column < 0 || af.column > 7) return false;
      if (!Number.isInteger(af.row) || af.row < 0 || af.row >= MAX_ATLAS_ROWS) return false;
      if (rows !== undefined && rows !== null && af.row >= rows) return false;
    }
    return true;
  }

  const hasEnterFrames = configResult && configResult.clips && configResult.clips.enter && validateClipRuntime(configResult.clips.enter);
  const hasEnterAtlas = configResult && configResult.clips && configResult.clips.enter && validateAtlasFramesRuntime(configResult.clips.enter, atlasRows);
  if (hasEnterFrames) {
    clips.enter = {
      frames: configResult.clips.enter.frames.map(fp => petDir ? validatePathSecurity(fp, resolvedPetDir).resolved : path.resolve(dir, fp)),
      fps: configResult.clips.enter.fps,
      loop: !!configResult.clips.enter.loop,
      fallback: false
    };
  } else if (hasEnterAtlas) {
    clips.enter = {
      atlasFrames: configResult.clips.enter.atlasFrames,
      fps: configResult.clips.enter.fps,
      loop: !!configResult.clips.enter.loop,
      fallback: false
    };
  } else {
    clips.enter = { fallback: true, row: 1, frames: 8, fps: 10, loop: false };
  }

  const hasRestFrames = configResult && configResult.clips && configResult.clips.rest && validateClipRuntime(configResult.clips.rest);
  const hasRestAtlas = configResult && configResult.clips && configResult.clips.rest && validateAtlasFramesRuntime(configResult.clips.rest, atlasRows);
  if (hasRestFrames) {
    clips.rest = {
      frames: configResult.clips.rest.frames.map(fp => petDir ? validatePathSecurity(fp, resolvedPetDir).resolved : path.resolve(dir, fp)),
      fps: configResult.clips.rest.fps,
      loop: configResult.clips.rest.loop !== undefined ? !!configResult.clips.rest.loop : true,
      fallback: false
    };
  } else if (hasRestAtlas) {
    clips.rest = {
      atlasFrames: configResult.clips.rest.atlasFrames,
      fps: configResult.clips.rest.fps,
      loop: configResult.clips.rest.loop !== undefined ? !!configResult.clips.rest.loop : true,
      fallback: false
    };
  } else {
    clips.rest = { fallback: true, row: 0, frames: 8, fps: 8, loop: true };
  }

  const hasExitFrames = configResult && configResult.clips && configResult.clips.exit && validateClipRuntime(configResult.clips.exit);
  const hasExitAtlas = configResult && configResult.clips && configResult.clips.exit && validateAtlasFramesRuntime(configResult.clips.exit, atlasRows);
  if (hasExitFrames) {
    clips.exit = {
      frames: configResult.clips.exit.frames.map(fp => petDir ? validatePathSecurity(fp, resolvedPetDir).resolved : path.resolve(dir, fp)),
      fps: configResult.clips.exit.fps,
      loop: !!configResult.clips.exit.loop,
      fallback: false
    };
  } else if (hasExitAtlas) {
    clips.exit = {
      atlasFrames: configResult.clips.exit.atlasFrames,
      fps: configResult.clips.exit.fps,
      loop: !!configResult.clips.exit.loop,
      fallback: false
    };
  } else {
    clips.exit = { fallback: true, reverse: true, fps: 12, loop: false };
  }

  return clips;
}

module.exports = {
  validateCompanionConfig,
  resolveClipFaces: resolveClipFrames,
  resolveClipFrames,
  validateFrameImage,
  validateFrames,
  VALID_FRAME_EXTENSIONS,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_CLIP,
  MAX_TOTAL_CLIP_FRAMES,
  getSafeRenderSettings,
};
