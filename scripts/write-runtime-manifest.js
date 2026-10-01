#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const [nodePath, pythonPath, installDir] = process.argv.slice(2);
if (!nodePath || !pythonPath || !installDir) {
  console.error('Usage: write-runtime-manifest.js <node> <python> <install-dir>');
  process.exit(2);
}

function runtime(filePath, args, versionPattern) {
  const resolvedPath = fs.realpathSync(filePath);
  const version = execFileSync(resolvedPath, args, { encoding: 'utf8' }).trim();
  if (!versionPattern.test(version)) throw new Error(`unsupported runtime version: ${version}`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex');
  return { path: resolvedPath, version, sha256 };
}

const manifest = {
  schemaVersion: 1,
  node: runtime(nodePath, ['--version'], /^v?(?:20|22|24)\./),
  python: runtime(pythonPath, ['-V'], /^Python (?:3\.(?:11|12|13|14))\./),
};
const outputPath = path.join(installDir, 'runtime-manifest.json');
const tempPath = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tempPath, outputPath);
