#!/usr/bin/env node

/**
 * Claude Code Task Output waiting format patcher
 *
 * Shortens waiting UI like:
 *   Task Output abc123
 *     <very long or multi-line task description>
 *        Waiting for task (esc to give additional instructions)
 *
 * by removing the embedded task description line from the waiting renderer.
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
  console.error('Error: --file requires a path argument');
  process.exit(1);
}

if (showHelp) {
  console.log('Claude Code Task Output waiting format patcher');
  console.log('================================================\n');
  console.log('Usage: node patch-task-output-format.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
  console.log('  --file PATH  Patch a specific cli.js file or native claude binary');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node patch-task-output-format.js');
  console.log('  node patch-task-output-format.js --dry-run');
  console.log('  node patch-task-output-format.js --restore');
  console.log('  node patch-task-output-format.js --file /path/to/cli.js');
  console.log('  node patch-task-output-format.js --file /path/to/claude');
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
    path.join(home, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const candidate of localPaths) {
    const found = checkPath(candidate, 'local installation');
    if (found && found.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  const npmGlobalRoot = safeExec('npm root -g');
  if (npmGlobalRoot) {
    const found = checkPath(path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js'), 'npm root -g');
    if (found && found.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  const nodeDir = path.dirname(process.execPath);
  {
    const derivedGlobalPath = path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
    if (found && found.kind === 'js') {
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
    console.log('macOS codesign: re-signed patched native binary (ad-hoc)');
  } catch {
    console.error('macOS codesign failed. The patched binary may be killed when executed.');
    console.error('You can try manually:');
    console.error(`codesign --force --deep --sign - ${shellQuotePosix(filePath)}`);
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
    console.error(`Backup not found: ${backupPath}`);
    process.exit(1);
  }
  if (!isDryRun) fs.copyFileSync(backupPath, targetPath);
  console.log(`Restored from backup: ${backupPath}`);
}

function locateTaskOutputProgressBlock(text) {
  let startIndex = 0;
  while (true) {
    const start = text.indexOf('renderToolUseProgressMessage(', startIndex);
    if (start < 0) return null;

    const end = text.indexOf('},renderToolResultMessage(', start);
    if (end < 0) return null;

    const block = text.slice(start, end);
    if (block.includes('Waiting for task') && block.includes('additional instructions')) {
      return { start, end, block };
    }

    startIndex = end + 1;
  }
}

function isAlreadyPatchedBlock(block) {
  if (!block.includes('Waiting for task')) return false;
  if (/taskDescription&&[\s\S]*?taskDescription\),/.test(block)) return false;
  return /createElement\([\w$]+,\{flexDirection:"column"\},null,\s*[\w$]+\.default\.createElement\([\w$]+,null,"[^"]*Waiting for task"/.test(
    block
  );
}

function patchBlock(block) {
  return block.replace(
    /[\w$]+\?\.taskDescription&&[\w$]+\.default\.createElement\([\w$]+,null,"[^"]*",[\w$]+\.taskDescription\),/,
    'null,'
  );
}

function padRightSpaces(str, targetLength) {
  if (str.length > targetLength) return null;
  if (str.length === targetLength) return str;
  return str + ' '.repeat(targetLength - str.length);
}

function applyPatchToText(text, preserveLength) {
  const located = locateTaskOutputProgressBlock(text);
  if (!located) return { patched: false, alreadyPatched: false, next: text };
  if (isAlreadyPatchedBlock(located.block)) return { patched: false, alreadyPatched: true, next: text };

  const patchedBlock = patchBlock(located.block);
  if (patchedBlock === located.block) {
    return { patched: false, alreadyPatched: false, next: text };
  }

  const finalBlock = preserveLength ? padRightSpaces(patchedBlock, located.block.length) : patchedBlock;
  if (finalBlock === null) {
    throw new Error(`Refusing to patch: replacement grew (${located.block.length} -> ${patchedBlock.length}).`);
  }

  const next = text.slice(0, located.start) + finalBlock + text.slice(located.end);
  return { patched: true, alreadyPatched: false, next };
}

function applyPatchToNativeBinary(buf) {
  const text = buf.toString('latin1');
  const { patched, alreadyPatched, next } = applyPatchToText(text, true);
  if (!patched) return { patched, alreadyPatched, out: buf };

  const out = Buffer.from(next, 'latin1');
  if (out.length !== buf.length) {
    throw new Error(`Refusing to patch native/binary: size changed (${buf.length} -> ${out.length}).`);
  }

  return { patched: true, alreadyPatched: false, out };
}

console.log('Claude Code Task Output waiting format patcher');
console.log('================================================\n');

const target = resolveClaudeTarget();
if (!target) {
  console.error('Could not find Claude Code installation.');
  console.error('Make sure `claude` is on PATH, or pass --file /path/to/cli.js (or native claude binary).');

  const attempted = resolveClaudeTarget.attempted || [];
  if (attempted.length > 0) {
    console.error('\nSearched using the following methods:\n');
    const byMethod = {};
    for (const { path: attemptedPath, method } of attempted) {
      if (!byMethod[method]) byMethod[method] = [];
      byMethod[method].push(attemptedPath);
    }
    for (const [method, paths] of Object.entries(byMethod)) {
      console.error(`[${method}]`);
      for (const attemptedPath of paths) console.error(`  - ${attemptedPath}`);
    }
  }
  process.exit(1);
}

const targetPath = target.path;
const targetKind = target.kind;

if (!fs.existsSync(targetPath)) {
  console.error(`File not found: ${targetPath}`);
  process.exit(1);
}

if (targetKind === 'unknown') {
  console.error(`Target is not a recognized Claude Code install: ${targetPath}`);
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
  const { patched, alreadyPatched, next } = applyPatchToText(originalText, false);

  if (alreadyPatched) {
    console.log('Already patched (Task Output waiting view is already shortened)');
    process.exit(0);
  }

  if (!patched) {
    console.error('Patch pattern not found.');
    console.error('The Claude Code build may have changed.');
    console.error('Try searching for this in the target file and paste the nearby code:');
    console.error('renderToolUseProgressMessage');
    console.error('Waiting for task');
    process.exit(1);
  }

  if (!isDryRun) {
    const backupPath = backupPathFor(targetPath);
    const hadBackup = fs.existsSync(backupPath);
    ensureBackup(targetPath);
    fs.writeFileSync(targetPath, next, 'utf8');
    console.log(`${hadBackup ? 'Backup already exists' : 'Backup created'}: ${backupPath}`);
    console.log('Patch applied');
  } else {
    console.log('Patch would apply cleanly');
  }
} else if (targetKind === 'native-binary') {
  const originalBuf = fs.readFileSync(targetPath);
  const { patched, alreadyPatched, out } = applyPatchToNativeBinary(originalBuf);

  if (alreadyPatched) {
    console.log('Already patched (Task Output waiting view is already shortened)');
    process.exit(0);
  }

  if (!patched) {
    console.error('Patch pattern not found.');
    console.error('The Claude Code build may have changed.');
    console.error('Try searching for this in the target file and paste the nearby code:');
    console.error('renderToolUseProgressMessage');
    console.error('Waiting for task');
    process.exit(1);
  }

  if (!isDryRun) {
    const backupPath = backupPathFor(targetPath);
    const hadBackup = fs.existsSync(backupPath);
    ensureBackup(targetPath);
    fs.writeFileSync(targetPath, out);
    console.log(`${hadBackup ? 'Backup already exists' : 'Backup created'}: ${backupPath}`);
    console.log('Patch applied');
    adHocCodesignIfNeeded(targetPath, targetKind);
  } else {
    console.log('Patch would apply cleanly');
  }
} else {
  console.error(`Unsupported target kind: ${targetKind}`);
  process.exit(1);
}

console.log('\nNext: restart Claude Code and verify Task Output waiting messages no longer print the raw task description.');
