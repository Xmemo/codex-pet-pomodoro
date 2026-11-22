const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const child_process = require('child_process');

function createTestEnv() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bootstrap-test-'));
  const fakeHome = path.join(rootDir, 'fakeHome');
  const fixturesDir = path.join(rootDir, 'fixtures');
  const binDir = path.join(rootDir, 'bin');

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Create fake curl utility
  const fakeCurlPath = path.join(binDir, 'fake-curl');
  const curlCode = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let outputFile = null;
let url = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--output') {
    outputFile = args[i + 1];
    i++;
  } else if (args[i].startsWith('http://') || args[i].startsWith('https://')) {
    url = args[i];
  }
}
if (process.env.TEST_DOWNLOAD_FAIL === '1') {
  process.exit(1);
}
if (!url || !outputFile) {
  process.exit(1);
}
const fixturesDir = process.env.TEST_FIXTURES_DIR;
if (!fixturesDir) {
  process.exit(1);
}
const filename = path.basename(url);
const sourcePath = path.join(fixturesDir, filename);
if (fs.existsSync(sourcePath)) {
  fs.copyFileSync(sourcePath, outputFile);
  process.exit(0);
} else {
  process.exit(1);
}
`;
  fs.writeFileSync(fakeCurlPath, curlCode);
  fs.chmodSync(fakeCurlPath, 0o755);

  // Create fake tar utility
  const fakeTarPath = path.join(binDir, 'fake-tar');
  const tarCode = `#!/usr/bin/env node
const child_process = require('child_process');
const args = process.argv.slice(2);
if (process.env.TEST_TAR_ENTRIES) {
  if (args.some(a => a.includes('t') && a.includes('z') && a.includes('f'))) {
    const isVerbose = args.some(a => a.includes('v'));
    const lines = process.env.TEST_TAR_ENTRIES.split('\\n');
    const output = lines.map(line => {
      if (!line) return '';
      if (isVerbose) {
        if (line.includes('->')) {
          return 'lrwxrwxrwx 0 root root 0 Jul 31 23:00 ' + line;
        } else if (line.includes('link to')) {
          return 'hrwxr-xr-x 0 root root 0 Jul 31 23:00 ' + line;
        } else if (line.endsWith('/')) {
          return 'drwxr-xr-x 0 root root 0 Jul 31 23:00 ' + line;
        } else {
          return '-rwxr-xr-x 0 root root 0 Jul 31 23:00 ' + line;
        }
      } else {
        return line;
      }
    }).join('\\n');
    console.log(output);
    process.exit(0);
  }
}
const result = child_process.spawnSync('tar', args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status);
`;
  fs.writeFileSync(fakeTarPath, tarCode);
  fs.chmodSync(fakeTarPath, 0o755);

  const fakeGhPath = path.join(binDir, 'fake-gh');
  fs.writeFileSync(fakeGhPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'attestation' || args[1] !== 'verify' || !args.includes('--repo') || !args.includes('Xmemo/codex-pet-pomodoro') || !args.includes('--signer-workflow') || !args.includes('Xmemo/codex-pet-pomodoro/.github/workflows/release.yml') || !args.includes('--source-ref') || !args.includes('refs/tags/' + process.env.TEST_RELEASE_VERSION)) process.exit(2);
process.exit(process.env.TEST_ATTESTATION_FAIL === '1' ? 1 : 0);
`);
  fs.chmodSync(fakeGhPath, 0o755);

  return {
    rootDir,
    fakeHome,
    fixturesDir,
    fakeCurlPath,
    fakeTarPath,
    fakeGhPath
  };
}

function cleanTestEnv(env) {
  if (env && env.rootDir) {
    fs.rmSync(env.rootDir, { recursive: true, force: true });
  }
}

// Reusable test helper
function runBootstrapTest({
  version = 'v0.1.2',
  versionArg = null,
  tarballFiles = null, // array of { name, content, type: 'file'|'symlink', target, outsideRoot }
  customChecksumContent = null,
  testEnvOverrides = {},
  expectSuccess = true,
  testTarEntries = null,
}) {
  const env = createTestEnv();
  const tarballName = `pet-pomodoro-for-codex-${version}.tar.gz`;

  const packageDir = path.join(env.rootDir, `pet-pomodoro-for-codex-${version}`);
  fs.mkdirSync(path.join(packageDir, 'scripts'), { recursive: true });

  // Default installer script
  const defaultInstaller = `#!/bin/zsh
touch "$HOME/installed_marker"
mkdir -p "$HOME/.local/bin"
cat <<'EOF' > "$HOME/.local/bin/ultradian"
#!/bin/zsh
touch "$HOME/ultradian_health_marker"
echo '{"status": "ok"}'
EOF
chmod +x "$HOME/.local/bin/ultradian"

cat <<'EOF' > "$HOME/.local/bin/codex-pet-companion"
#!/bin/zsh
touch "$HOME/companion_health_marker"
echo '{"engineState": "resting", "error": null}'
EOF
chmod +x "$HOME/.local/bin/codex-pet-companion"
`;
  fs.writeFileSync(path.join(packageDir, 'scripts/install.sh'), defaultInstaller);
  fs.chmodSync(path.join(packageDir, 'scripts/install.sh'), 0o755);

  const extraTarFiles = [];
  if (tarballFiles) {
    for (const file of tarballFiles) {
      if (file.outsideRoot) {
        const dest = path.join(env.rootDir, file.name);
        fs.writeFileSync(dest, file.content || '');
        extraTarFiles.push(file.name);
      } else {
        const dest = path.join(packageDir, file.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (file.type === 'symlink') {
          fs.symlinkSync(file.target, dest);
        } else {
          fs.writeFileSync(dest, file.content || '');
          if (file.mode) {
            fs.chmodSync(dest, file.mode);
          }
        }
      }
    }
  }

  // Pack tarball using execFileSync to avoid shell interpretation and unquoted path issues
  const tarArgs = ['-czf', path.join(env.fixturesDir, tarballName), '-C', env.rootDir, `pet-pomodoro-for-codex-${version}`];
  for (const file of extraTarFiles) {
    tarArgs.push(file);
  }
  child_process.execFileSync('tar', tarArgs);

  if (customChecksumContent !== null) {
    fs.writeFileSync(path.join(env.fixturesDir, 'SHA256SUMS'), customChecksumContent);
  } else {
    const tarballBuf = fs.readFileSync(path.join(env.fixturesDir, tarballName));
    const hash = crypto.createHash('sha256').update(tarballBuf).digest('hex');
    fs.writeFileSync(path.join(env.fixturesDir, 'SHA256SUMS'), `${hash}  ${tarballName}\n`);
  }

  const repoRoot = path.resolve(__dirname, '..');
  const bootstrapPath = path.join(repoRoot, 'scripts/bootstrap.sh');

  const args = versionArg ? [versionArg] : [];
  const runEnv = {
    ...process.env,
    HOME: env.fakeHome,
    CURL_BIN: env.fakeCurlPath,
    TAR_BIN: env.fakeTarPath,
    GH_BIN: env.fakeGhPath,
    TEST_RELEASE_VERSION: versionArg || version,
    TEST_FIXTURES_DIR: env.fixturesDir,
    CODEX_RELEASE_URL_BASE: `http://fakegithub.com/Xmemo/codex-pet-pomodoro/releases/download/${versionArg || version}`,
    CODEX_BOOTSTRAP_TEST: '1',
    ...testEnvOverrides
  };
  if (testTarEntries) {
    runEnv.TEST_TAR_ENTRIES = testTarEntries;
  }

  const result = child_process.spawnSync('/bin/zsh', [bootstrapPath, ...args], {
    env: runEnv,
    encoding: 'utf8'
  });

  if (expectSuccess) {
    assert.strictEqual(result.status, 0, `Bootstrap failed: ${result.stderr}\nStdout: ${result.stdout}`);
    assert.ok(fs.existsSync(path.join(env.fakeHome, 'installed_marker')), 'Installer was not executed on success');
    assert.ok(fs.existsSync(path.join(env.fakeHome, 'ultradian_health_marker')), 'Ultradian health check did not write marker');
    assert.ok(fs.existsSync(path.join(env.fakeHome, 'companion_health_marker')), 'Companion health check did not write marker');
  } else {
    assert.notStrictEqual(result.status, 0, `Bootstrap should have failed but succeeded\nStdout: ${result.stdout}`);
    assert.ok(!fs.existsSync(path.join(env.fakeHome, 'installed_marker')), 'Installer must not execute on verification failure');
  }

  cleanTestEnv(env);
}

// Required Test Cases
test('bootstrap succeeds with the default attested release version, executes installer, and runs health checks', () => {
  runBootstrapTest({ expectSuccess: true });
});

test('bootstrap succeeds with valid version override, executes installer, and runs health checks', () => {
  runBootstrapTest({ version: 'v1.2.3', versionArg: 'v1.2.3', expectSuccess: true });
});

test('bootstrap refuses to execute installer when release attestation verification fails', () => {
  runBootstrapTest({
    testEnvOverrides: { TEST_ATTESTATION_FAIL: '1' },
    expectSuccess: false
  });
});

test('bootstrap refuses to execute installer when GitHub CLI is unavailable', () => {
  runBootstrapTest({
    testEnvOverrides: { GH_BIN: '/nonexistent/gh' },
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when checksum does not match', () => {
  runBootstrapTest({
    customChecksumContent: 'd3b07384d113edec49eaa6238ad5ff00b7d9ee42ef2b9b7759d5cc23588a4c84  pet-pomodoro-for-codex-v0.1.0.tar.gz\n',
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when checksum is empty', () => {
  runBootstrapTest({ customChecksumContent: '', expectSuccess: false });
});

test('bootstrap fails and does not execute installer when checksum file has multiple entries', () => {
  runBootstrapTest({
    customChecksumContent: `d3b07384d113edec49eaa6238ad5ff00b7d9ee42ef2b9b7759d5cc23588a4c84  pet-pomodoro-for-codex-v0.1.0.tar.gz\nd3b07384d113edec49eaa6238ad5ff00b7d9ee42ef2b9b7759d5cc23588a4c84  another.tar.gz\n`,
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when checksum is malformed', () => {
  runBootstrapTest({
    customChecksumContent: 'badhash  pet-pomodoro-for-codex-v0.1.0.tar.gz\n',
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when download fails', () => {
  runBootstrapTest({
    testEnvOverrides: { TEST_DOWNLOAD_FAIL: '1' },
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when archive contains entries outside root', () => {
  runBootstrapTest({
    tarballFiles: [
      { name: 'illegal-file.txt', content: 'illegal', outsideRoot: true }
    ],
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when path traversal is detected in tar list', () => {
  runBootstrapTest({
    testTarEntries: `pet-pomodoro-for-codex-v0.1.0/
pet-pomodoro-for-codex-v0.1.0/scripts/
pet-pomodoro-for-codex-v0.1.0/scripts/install.sh
pet-pomodoro-for-codex-v0.1.0/../traversal.txt`,
    expectSuccess: false
  });
});

test('bootstrap fails and does not execute installer when archive contains a symlink entry', () => {
  runBootstrapTest({
    tarballFiles: [
      { name: 'scripts/install_link.sh', target: 'install.sh', type: 'symlink' }
    ],
    expectSuccess: false
  });
});

test('bootstrap fails when installer exits with non-zero code', () => {
  runBootstrapTest({
    tarballFiles: [
      { name: 'scripts/install.sh', content: '#!/bin/zsh\nexit 5\n', mode: 0o755 }
    ],
    expectSuccess: false
  });
});

// Extra safety tests for test mode environment variables
test('bootstrap rejects invalid non-absolute executable override in test mode', () => {
  const env = createTestEnv();
  const repoRoot = path.resolve(__dirname, '..');
  const bootstrapPath = path.join(repoRoot, 'scripts/bootstrap.sh');
  const result = child_process.spawnSync('/bin/zsh', [bootstrapPath], {
    env: {
      ...process.env,
      HOME: env.fakeHome,
      CURL_BIN: 'relative-curl',
      CODEX_RELEASE_URL_BASE: 'http://fakegithub.com/Xmemo/codex-pet-pomodoro/releases/download/v0.1.0',
      CODEX_BOOTSTRAP_TEST: '1'
    },
    encoding: 'utf8'
  });
  assert.notStrictEqual(result.status, 0, 'Should reject relative paths in overrides');
  cleanTestEnv(env);
});

test('bootstrap rejects command-plus-arguments string override in test mode', () => {
  const env = createTestEnv();
  const repoRoot = path.resolve(__dirname, '..');
  const bootstrapPath = path.join(repoRoot, 'scripts/bootstrap.sh');
  const result = child_process.spawnSync('/bin/zsh', [bootstrapPath], {
    env: {
      ...process.env,
      HOME: env.fakeHome,
      CURL_BIN: '/usr/bin/curl --silent',
      CODEX_RELEASE_URL_BASE: 'http://fakegithub.com/Xmemo/codex-pet-pomodoro/releases/download/v0.1.0',
      CODEX_BOOTSTRAP_TEST: '1'
    },
    encoding: 'utf8'
  });
  assert.notStrictEqual(result.status, 0, 'Should reject space-containing paths in overrides');
  cleanTestEnv(env);
});

test('bootstrap rejects test mode if CODEX_RELEASE_URL_BASE is missing', () => {
  const env = createTestEnv();
  const repoRoot = path.resolve(__dirname, '..');
  const bootstrapPath = path.join(repoRoot, 'scripts/bootstrap.sh');
  const result = child_process.spawnSync('/bin/zsh', [bootstrapPath], {
    env: {
      ...process.env,
      HOME: env.fakeHome,
      CURL_BIN: env.fakeCurlPath,
      CODEX_BOOTSTRAP_TEST: '1'
    },
    encoding: 'utf8'
  });
  assert.notStrictEqual(result.status, 0, 'Should reject test mode without release url base');
  cleanTestEnv(env);
});
