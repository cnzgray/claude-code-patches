#!/usr/bin/env node

/**
 * Claude Code background command completion format patcher
 *
 * Shortens notifications like:
 *   Background command "xxxx" completed (exit code 0)
 *
 * by removing the embedded raw command from the completion notification.
 *
 * This patch targets:
 * - npm/local installs: patch the compiled `@anthropic-ai/claude-code/cli.js`
 * - native/binary installs: patch the embedded JS in-place (length-preserving)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isRestore = args.includes('--restore');
const showHelp = args.includes('--help') || args.includes('-h');
const fileArgIndex = args.indexOf('--file');
const fileArgPath = fileArgIndex >= 0 ? args[fileArgIndex + 1] : null;

if (fileArgIndex >= 0 && !fileArgPath) {
  console.error('❌ Error: --file requires a path argument');
  process.exit(1);
}

if (showHelp) {
  console.log('Claude Code background command format patcher');
  console.log('==============================================\n');
  console.log('Usage: node patch-background-command-format.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
  console.log('  --file PATH  Patch a specific cli.js file or native claude binary');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node patch-background-command-format.js');
  console.log('  node patch-background-command-format.js --dry-run');
  console.log('  node patch-background-command-format.js --restore');
  console.log('  node patch-background-command-format.js --file /path/to/cli.js');
  console.log('  node patch-background-command-format.js --file /path/to/claude');
  process.exit(0);
}

function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function shellQuotePosix(str) {
  return `'${String(str).replace(/'/g, `'"'"'`)}'`;
}

function readFilePrefix(filePath, maxBytes = 4096) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
      if (bytesRead <= 0) return null;
      return buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function detectClaudeTargetKind(filePath) {
  if (filePath.endsWith('.js')) return 'js';

  const prefix = readFilePrefix(filePath);
  if (!prefix) return 'unknown';

  if (prefix.includes(0)) return 'native-binary';

  if (
    prefix.length >= 4 &&
    prefix[0] === 0x7f &&
    prefix[1] === 0x45 &&
    prefix[2] === 0x4c &&
    prefix[3] === 0x46
  ) {
    return 'native-binary';
  }

  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) return 'native-binary';

  if (prefix.length >= 4) {
    const magic = prefix.readUInt32BE(0);
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe) {
      return 'native-binary';
    }
  }

  const asUtf8 = prefix.toString('utf8');
  if (asUtf8.startsWith('#!')) return 'js';

  return 'unknown';
}

function getNativeCandidatePaths(homeDir) {
  const candidates = [];
  candidates.push(path.join(homeDir, '.local', 'bin', 'claude'));

  const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
  try {
    if (fs.existsSync(versionsDir)) {
      const parseVersionish = entry => {
        const m = String(entry).match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
        if (!m) return null;
        return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
      };
      const compareVersionishDesc = (a, b) => {
        if (a.major !== b.major) return b.major - a.major;
        if (a.minor !== b.minor) return b.minor - a.minor;
        return b.patch - a.patch;
      };

      const entries = fs
        .readdirSync(versionsDir)
        .filter(entry => !String(entry).endsWith('.backup'))
        .sort((a, b) => {
          const va = parseVersionish(a);
          const vb = parseVersionish(b);
          if (va && vb) return compareVersionishDesc(va, vb);
          if (va) return -1;
          if (vb) return 1;
          return a.localeCompare(b);
        });

      for (const entry of entries) {
        const fullPath = path.join(versionsDir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) candidates.push(fullPath);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return candidates;
}

function resolveClaudeTarget() {
  const attempted = [];
  const home = os.homedir();

  function checkPath(candidatePath, method) {
    if (!candidatePath) return null;
    attempted.push({ path: candidatePath, method });
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const real = fs.realpathSync(candidatePath);
      const kind = detectClaudeTargetKind(real);
      if (kind === 'unknown') return null;
      return { path: real, kind, method };
    } catch {
      const kind = detectClaudeTargetKind(candidatePath);
      if (kind === 'unknown') return null;
      return { path: candidatePath, kind, method };
    }
  }

  if (fileArgPath) {
    const resolved = path.resolve(fileArgPath);
    const found = checkPath(resolved, '--file');
    resolveClaudeTarget.attempted = attempted;
    return found;
  }

  const localPaths = [
    path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(home, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  for (const candidate of localPaths) {
    const found = checkPath(candidate, 'local installation');
    if (found && (found.kind === 'js' || found.kind === 'native-binary')) {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  const npmGlobalRoot = safeExec('npm root -g');
  if (npmGlobalRoot) {
    const npmGlobalPaths = [
      path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js'),
      path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ];
    for (const npmGlobalPath of npmGlobalPaths) {
      const found = checkPath(npmGlobalPath, 'npm root -g');
      if (found && (found.kind === 'js' || found.kind === 'native-binary')) {
        resolveClaudeTarget.attempted = attempted;
        return found;
      }
    }
  }

  const nodeDir = path.dirname(process.execPath);
  const derivedGlobalPaths = [
    path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  for (const derivedGlobalPath of derivedGlobalPaths) {
    const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
    if (found && (found.kind === 'js' || found.kind === 'native-binary')) {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  const whichClaude = safeExec('command -v claude');
  if (whichClaude) {
    let realBinary = whichClaude;
    try {
      realBinary = fs.realpathSync(whichClaude);
    } catch {
      // ignore
    }

    if (realBinary.endsWith(path.join('@anthropic-ai', 'claude-code', 'cli.js'))) {
      const foundDirect = checkPath(realBinary, 'command -v claude (direct cli.js)');
      if (foundDirect && foundDirect.kind === 'js') {
        resolveClaudeTarget.attempted = attempted;
        return foundDirect;
      }
    }

    const binDir = path.dirname(realBinary);
    const derivedFromBin = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const foundFromBin = checkPath(derivedFromBin, 'command -v claude (derived)');
    if (foundFromBin && foundFromBin.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return foundFromBin;
    }

    const foundNative = checkPath(realBinary, 'command -v claude (native)');
    if (foundNative && foundNative.kind === 'native-binary') {
      resolveClaudeTarget.attempted = attempted;
      return foundNative;
    }
  }

  for (const candidate of getNativeCandidatePaths(home)) {
    const found = checkPath(candidate, 'native/binary default paths');
    if (found && found.kind === 'native-binary') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  resolveClaudeTarget.attempted = attempted;
  return null;
}

function adHocCodesignIfNeeded(filePath, kind) {
  if (kind !== 'native-binary') return;
  if (process.platform !== 'darwin') return;

  try {
    execSync(`codesign --force --deep --sign - ${shellQuotePosix(filePath)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    console.log('✅ macOS codesign: re-signed patched native binary (ad-hoc)');
  } catch {
    console.error('⚠️  macOS codesign failed. The patched binary may be killed when executed.');
    console.error('   You can try manually:');
    console.error(`   codesign --force --deep --sign - ${shellQuotePosix(filePath)}`);
  }
}

function backupPathFor(targetPath) {
  return `${targetPath}.backup`;
}

function ensureBackup(targetPath) {
  const backupPath = backupPathFor(targetPath);
  if (fs.existsSync(backupPath)) return backupPath;
  fs.copyFileSync(targetPath, backupPath);
  return backupPath;
}

function restoreFromBackup(targetPath) {
  const backupPath = backupPathFor(targetPath);
  if (!fs.existsSync(backupPath)) {
    console.error(`❌ Backup not found: ${backupPath}`);
    process.exit(1);
  }
  if (!isDryRun) fs.copyFileSync(backupPath, targetPath);
  console.log(`✅ Restored from backup: ${backupPath}`);
}

function locateNotificationBlockByMarker(text, markerRegex, startIndex = 0) {
  const match = markerRegex.exec(text.slice(startIndex));
  if (!match) return null;

  const markerIndex = startIndex + match.index;
  const start = text.lastIndexOf('function ', markerIndex);
  if (start < 0) return null;

  const tail = text.slice(markerIndex);
  const endMatch = /mode:"task-notification"(?:,priority:[^)]*)?\)\}/.exec(tail);
  if (!endMatch) return null;

  const end = markerIndex + endMatch.index + endMatch[0].length;
  const block = text.slice(start, end);
  if (!block.includes('task-notification')) return null;

  return { start, end, markerIndex, block };
}

function locateOriginalNotificationBlock(text, startIndex = 0) {
  const originalMarkers = [
    /Background command "\$\{[^}]+\}" /,
    /\$\{[$\w]+\}"\$\{[$\w]+\}" completed/,
  ];

  let best = null;
  for (const markerRegex of originalMarkers) {
    const originalBlock = locateNotificationBlockByMarker(text, markerRegex, startIndex);
    if (originalBlock) {
      if (!best || originalBlock.markerIndex < best.markerIndex) {
        best = { kind: 'original', ...originalBlock };
      }
    }
  }

  return best;
}

function hasPatchedNotificationBlock(text) {
  const alreadyPatchedMarkers = [
    /Background command completed/,
    /Background command failed/,
    /Background command was stopped/,
    /\$\{[$\w]+\}completed/,
    /\$\{[$\w]+\}failed/,
    /\$\{[$\w]+\}was stopped/,
  ];

  for (const markerRegex of alreadyPatchedMarkers) {
    if (locateNotificationBlockByMarker(text, markerRegex)) {
      return true;
    }
  }

  return false;
}

function patchBlock(block) {
  let next = block.replace(/Background command "\$\{[^}]+\}" /g, 'Background command ');

  // v2.1.75+ moved the shared "Background command " prefix into a variable and now
  // builds the message like `${prefix}"${command}" completed`. Remove only the raw
  // command interpolation while keeping the shared prefix and status text intact.
  next = next.replace(/(\$\{[$\w]+\})"\$\{[$\w]+\}" (?=completed|failed|was stopped)/g, '$1');

  return next;
}

function padRightSpaces(str, targetLength) {
  if (str.length > targetLength) return null;
  if (str.length === targetLength) return str;
  return str + ' '.repeat(targetLength - str.length);
}

function applyPatchToText(text) {
  let next = text;
  let patchedCount = 0;
  let cursor = 0;

  while (true) {
    const located = locateOriginalNotificationBlock(next, cursor);
    if (!located) break;

    const patchedBlock = patchBlock(located.block);
    if (patchedBlock === located.block) {
      cursor = located.end;
      continue;
    }

    next = next.slice(0, located.start) + patchedBlock + next.slice(located.end);
    cursor = located.start + patchedBlock.length;
    patchedCount += 1;
  }

  return { patched: patchedCount > 0, alreadyPatched: patchedCount === 0 && hasPatchedNotificationBlock(text), next };
}

function applyPatchToNativeBinary(buf) {
  const text = buf.toString('latin1');
  let next = text;
  let patchedCount = 0;
  let cursor = 0;

  while (true) {
    const located = locateOriginalNotificationBlock(next, cursor);
    if (!located) break;

    const patchedBlock = patchBlock(located.block);
    if (patchedBlock === located.block) {
      cursor = located.end;
      continue;
    }

    const paddedBlock = padRightSpaces(patchedBlock, located.block.length);
    if (paddedBlock === null) {
      throw new Error(`Refusing to patch native/binary: replacement grew (${located.block.length} -> ${patchedBlock.length}).`);
    }

    next = next.slice(0, located.start) + paddedBlock + next.slice(located.end);
    cursor = located.start + paddedBlock.length;
    patchedCount += 1;
  }

  const out = Buffer.from(next, 'latin1');
  if (out.length !== buf.length) {
    throw new Error(`Refusing to patch native/binary: size changed (${buf.length} -> ${out.length}).`);
  }

  return { patched: patchedCount > 0, alreadyPatched: patchedCount === 0 && hasPatchedNotificationBlock(text), out };
}

console.log('Claude Code background command format patcher');
console.log('==============================================\n');

const target = resolveClaudeTarget();
if (!target) {
  console.error('❌ Could not find Claude Code installation.');
  console.error('   Make sure `claude` is on PATH, or pass --file /path/to/cli.js (or native claude binary).');

  const attempted = resolveClaudeTarget.attempted || [];
  if (attempted.length > 0) {
    console.error('\nSearched using the following methods:\n');
    const byMethod = {};
    for (const { path: attemptedPath, method } of attempted) {
      if (!byMethod[method]) byMethod[method] = [];
      byMethod[method].push(attemptedPath);
    }
    for (const [method, paths] of Object.entries(byMethod)) {
      console.error(`  [${method}]`);
      for (const attemptedPath of paths) console.error(`    - ${attemptedPath}`);
    }
  }
  process.exit(1);
}

const targetPath = target.path;
const targetKind = target.kind;

if (!fs.existsSync(targetPath)) {
  console.error(`❌ File not found: ${targetPath}`);
  process.exit(1);
}

if (targetKind === 'unknown') {
  console.error(`❌ Target is not a recognized Claude Code install: ${targetPath}`);
  process.exit(1);
}

console.log(`Target: ${targetPath}`);
console.log(`Installation type: ${targetKind === 'native-binary' ? 'native/binary' : 'npm/local (cli.js)'}\n`);
if (isDryRun) console.log('Mode: dry-run (no files will be modified)');

if (isRestore) {
  restoreFromBackup(targetPath);
  process.exit(0);
}

if (targetKind === 'js') {
  const originalText = fs.readFileSync(targetPath, 'utf8');
  const { patched, alreadyPatched, next } = applyPatchToText(originalText);

  if (alreadyPatched) {
    console.log('✅ Already patched (background command text is already shortened)');
    process.exit(0);
  }

  if (!patched) {
    console.error('❌ Patch pattern not found.');
    console.error('   The Claude Code build may have changed.');
    console.error('   Try searching for this in the target file and paste ~1 line around it:');
    console.error('   Background command "${q}"');
    process.exit(1);
  }

  if (!isDryRun) {
    const backupPath = backupPathFor(targetPath);
    const hadBackup = fs.existsSync(backupPath);
    ensureBackup(targetPath);
    fs.writeFileSync(targetPath, next, 'utf8');
    console.log(`✅ ${hadBackup ? 'Backup already exists' : 'Backup created'}: ${backupPath}`);
    console.log('✅ Patch applied');
  } else {
    console.log('✅ Patch would apply cleanly');
  }
} else if (targetKind === 'native-binary') {
  const originalBuf = fs.readFileSync(targetPath);
  const { patched, alreadyPatched, out } = applyPatchToNativeBinary(originalBuf);

  if (alreadyPatched) {
    console.log('✅ Already patched (background command text is already shortened)');
    process.exit(0);
  }

  if (!patched) {
    console.error('❌ Patch pattern not found.');
    console.error('   The Claude Code build may have changed.');
    console.error('   Try searching for this in the target file and paste ~1 line around it:');
    console.error('   Background command "${q}"');
    process.exit(1);
  }

  if (!isDryRun) {
    const backupPath = backupPathFor(targetPath);
    const hadBackup = fs.existsSync(backupPath);
    ensureBackup(targetPath);
    fs.writeFileSync(targetPath, out);
    console.log(`✅ ${hadBackup ? 'Backup already exists' : 'Backup created'}: ${backupPath}`);
    console.log('✅ Patch applied');
    adHocCodesignIfNeeded(targetPath, targetKind);
  } else {
    console.log('✅ Patch would apply cleanly');
  }
} else {
  console.error(`❌ Unsupported target kind: ${targetKind}`);
  process.exit(1);
}

console.log('\nNext: restart Claude Code and verify background command completion notifications are shorter.');
