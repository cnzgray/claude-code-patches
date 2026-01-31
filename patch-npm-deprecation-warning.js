#!/usr/bin/env node

/**
 * Claude Code npm deprecation warning patcher
 *
 * Removes the notification:
 * "Claude Code has switched from npm to native installer..."
 *
 * This patch targets:
 * - npm/local installs: patch the compiled `@anthropic-ai/claude-code/cli.js`
 * - native/binary installs: patch the `claude` binary in-place (length-preserving)
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
  console.log('Claude Code npm deprecation warning patcher');
  console.log('========================================\n');
  console.log('Usage: node patch-npm-deprecation-warning.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
  console.log('  --file PATH  Patch a specific cli.js file or native claude binary (skip auto-detection)');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node patch-npm-deprecation-warning.js');
  console.log('  node patch-npm-deprecation-warning.js --dry-run');
  console.log('  node patch-npm-deprecation-warning.js --restore');
  console.log('  node patch-npm-deprecation-warning.js --file /path/to/cli.js');
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
  // Minimal safe quoting for POSIX shells (zsh/bash).
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
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

  // Heuristic: NUL bytes in prefix usually means a binary (Mach-O/ELF/PE, etc.)
  if (prefix.includes(0)) return 'native-binary';

  // Detect common native binary headers.
  // - ELF: 0x7F 'E' 'L' 'F'
  if (
    prefix.length >= 4 &&
    prefix[0] === 0x7f &&
    prefix[1] === 0x45 &&
    prefix[2] === 0x4c &&
    prefix[3] === 0x46
  ) {
    return 'native-binary';
  }
  // - PE/COFF: 'MZ'
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) return 'native-binary';
  // - Mach-O: FE ED FA CE / FE ED FA CF / CF FA ED FE / CA FE BA BE (fat)
  if (prefix.length >= 4) {
    const m = prefix.readUInt32BE(0);
    if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcffaedfe || m === 0xcafebabe) return 'native-binary';
  }

  // If it starts with a shebang, treat as script (npm-installed wrappers sometimes omit .js).
  const asUtf8 = prefix.toString('utf8');
  if (asUtf8.startsWith('#!')) return 'js';

  return 'unknown';
}

function getNativeCandidatePaths(homeDir) {
  const candidates = [];

  candidates.push(path.join(homeDir, '.local', 'bin', 'claude'));

  // Official native installer stores versioned binaries here (filenames are versions like 2.1.27).
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

  function checkPath(p, method) {
    if (!p) return null;
    attempted.push({ path: p, method });
    try {
      if (!fs.existsSync(p)) return null;
      const real = fs.realpathSync(p);
      const kind = detectClaudeTargetKind(real);
      if (kind === 'unknown') return null;
      return { path: real, kind, method };
    } catch {
      const kind = detectClaudeTargetKind(p);
      if (kind === 'unknown') return null;
      return { path: p, kind, method };
    }
  }

  if (fileArgPath) {
    const resolved = path.resolve(fileArgPath);
    const found = checkPath(resolved, '--file');
    resolveClaudeTarget.attempted = attempted;
    return found;
  }

  // PRIORITY 1: Local installations
  const localPaths = [
    path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const p of localPaths) {
    const found = checkPath(p, 'local installation');
    if (found && found.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  // PRIORITY 2: Global npm installation via 'npm root -g'
  const npmGlobalRoot = safeExec('npm root -g');
  if (npmGlobalRoot) {
    const found = checkPath(path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js'), 'npm root -g');
    if (found && found.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  // PRIORITY 3: Derive from process.execPath (common for nvm/asdf/etc)
  const nodeDir = path.dirname(process.execPath);
  const derivedGlobalPath = path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  {
    const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
    if (found && found.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return found;
    }
  }

  // PRIORITY 4: which/command -v claude (npm wrapper or native binary)
  const whichClaude = safeExec('command -v claude');
  if (whichClaude) {
    let realBinary = whichClaude;
    try {
      realBinary = fs.realpathSync(whichClaude);
    } catch {
      // ignore
    }

    // If the PATH entry is a direct cli.js, patch it.
    if (realBinary.endsWith(path.join('@anthropic-ai', 'claude-code', 'cli.js'))) {
      const foundDirect = checkPath(realBinary, 'command -v claude (direct cli.js)');
      if (foundDirect && foundDirect.kind === 'js') {
        resolveClaudeTarget.attempted = attempted;
        return foundDirect;
      }
    }

    // Try deriving cli.js from bin/claude -> lib/node_modules/.../cli.js
    const binDir = path.dirname(realBinary);
    const derivedFromBin = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const foundFromBin = checkPath(derivedFromBin, 'command -v claude (derived)');
    if (foundFromBin && foundFromBin.kind === 'js') {
      resolveClaudeTarget.attempted = attempted;
      return foundFromBin;
    }

    // Otherwise patch the PATH entry itself if it's a native binary.
    const foundNative = checkPath(realBinary, 'command -v claude (native)');
    if (foundNative && foundNative.kind === 'native-binary') {
      resolveClaudeTarget.attempted = attempted;
      return foundNative;
    }
  }

  // PRIORITY 5: Native/binary default paths (official installer)
  for (const p of getNativeCandidatePaths(home)) {
    const found = checkPath(p, 'native/binary default paths');
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

function applyPatchToText(text) {
  // Safer approach (no wide regex across the whole bundle):
  // 1) Locate `key:"npm-deprecation-warning"`
  // 2) Find the exact call that contains it (e.g. `K({timeoutMs:15000,...})`)
  // 3) Remove `,K({..})` if comma-expression, otherwise replace `K({..})` with `void 0`

  function isIdentChar(ch) {
    return /[A-Za-z0-9_$\.]/.test(ch);
  }

  function findMatchingParen(str, openParenIndex) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = openParenIndex; i < str.length; i++) {
      const ch = str[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (inSingle) {
        if (ch === '\\\\') escaped = true;
        else if (ch === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (ch === '\\\\') escaped = true;
        else if (ch === '"') inDouble = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\\\') escaped = true;
        else if (ch === '`') inTemplate = false;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function patchOnce(str) {
    const keyNeedle = 'key:"npm-deprecation-warning"';
    const idxKey = str.indexOf(keyNeedle);
    if (idxKey === -1) return { did: false, next: str };

    // Find a nearby "({" that likely begins the object literal passed to the notification call.
    // Limit search window to avoid jumping to unrelated occurrences.
    const windowStart = Math.max(0, idxKey - 2500);
    const searchSpace = str.slice(windowStart, idxKey + keyNeedle.length);
    const relObj = searchSpace.lastIndexOf('({');
    if (relObj === -1) return { did: false, next: str };

    const openParenIndex = windowStart + relObj; // points to '(' in '({'
    const closeParenIndex = findMatchingParen(str, openParenIndex);
    if (closeParenIndex === -1) return { did: false, next: str };

    // Walk backwards to find the callee name right before '('
    let i = openParenIndex - 1;
    while (i >= 0 && /\s/.test(str[i])) i--;
    const identEnd = i + 1;
    while (i >= 0 && isIdentChar(str[i])) i--;
    const identStart = i + 1;
    if (identStart >= identEnd) return { did: false, next: str };

    // Optional leading comma (comma operator)
    let j = identStart - 1;
    while (j >= 0 && /\s/.test(str[j])) j--;
    const hasLeadingComma = j >= 0 && str[j] === ',';
    const removalStart = hasLeadingComma ? j : identStart;
    const removalEnd = closeParenIndex + 1;

    const replacement = hasLeadingComma ? '' : 'void 0';
    const next = str.slice(0, removalStart) + replacement + str.slice(removalEnd);
    return { did: true, next };
  }

  let next = text;
  let did = false;
  // In case there are multiple occurrences (unlikely), patch a few times.
  for (let n = 0; n < 5; n++) {
    const r = patchOnce(next);
    if (!r.did) break;
    next = r.next;
    did = true;
  }

  return { patched: did, next };
}

function applyPatchToNativeBinary(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('applyPatchToNativeBinary expected a Buffer');

  const keyNeedle = 'key:"npm-deprecation-warning"';
  const windowSize = 2500;

  function isIdentChar(ch) {
    return /[A-Za-z0-9_$\.]/.test(ch);
  }

  function findMatchingParen(str, openParenIndex) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = openParenIndex; i < str.length; i++) {
      const ch = str[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (inSingle) {
        if (ch === '\\\\') escaped = true;
        else if (ch === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (ch === '\\\\') escaped = true;
        else if (ch === '"') inDouble = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\\\') escaped = true;
        else if (ch === '`') inTemplate = false;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function padRightSpaces(str, targetLen) {
    if (str.length > targetLen) return null;
    if (str.length === targetLen) return str;
    return str + ' '.repeat(targetLen - str.length);
  }

  function patchOnce(str) {
    const idxKey = str.indexOf(keyNeedle);
    if (idxKey === -1) return { did: false, next: str };

    const windowStart = Math.max(0, idxKey - windowSize);
    const searchSpace = str.slice(windowStart, idxKey + keyNeedle.length);
    const relObj = searchSpace.lastIndexOf('({');
    if (relObj === -1) return { did: false, next: str };

    const openParenIndex = windowStart + relObj; // points to '(' in '({'
    const closeParenIndex = findMatchingParen(str, openParenIndex);
    if (closeParenIndex === -1) return { did: false, next: str };

    // Walk backwards to find the callee name right before '('
    let i = openParenIndex - 1;
    while (i >= 0 && /\s/.test(str[i])) i--;
    const identEnd = i + 1;
    while (i >= 0 && isIdentChar(str[i])) i--;
    const identStart = i + 1;
    if (identStart >= identEnd) return { did: false, next: str };

    const removalStart = identStart;
    const removalEnd = closeParenIndex + 1;
    const removalLen = removalEnd - removalStart;
    if (removalLen <= 0) return { did: false, next: str };

    // Native/binary: length-preserving neutralization.
    // Replace the whole call expression `callee({..})` with `0` + spaces.
    const replacement = padRightSpaces('0', removalLen);
    if (replacement === null) return { did: false, next: str };
    const next = str.slice(0, removalStart) + replacement + str.slice(removalEnd);
    return { did: true, next };
  }

  let text = buf.toString('latin1');
  let did = false;

  // Patch a few times just in case there are multiple bundles.
  for (let n = 0; n < 5; n++) {
    const r = patchOnce(text);
    if (!r.did) break;
    text = r.next;
    did = true;
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== buf.length) {
    throw new Error(`Refusing to patch native/binary: size changed (${buf.length} -> ${outBuf.length}).`);
  }
  return { patched: did, out: outBuf };
}

console.log('Claude Code npm deprecation warning patcher');
console.log('========================================\n');

const target = resolveClaudeTarget();
if (!target) {
  console.error('❌ Could not find Claude Code installation.');
  console.error('   Make sure `claude` is on PATH, or pass --file /path/to/cli.js (or native claude binary).');

  const attempted = resolveClaudeTarget.attempted || [];
  if (attempted.length > 0) {
    console.error('\nSearched using the following methods:\n');
    const byMethod = {};
    for (const { path: p, method } of attempted) {
      if (!byMethod[method]) byMethod[method] = [];
      byMethod[method].push(p);
    }
    for (const [method, paths] of Object.entries(byMethod)) {
      console.error(`  [${method}]`);
      for (const p of paths) console.error(`    - ${p}`);
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
  const alreadyGone = !originalText.includes('key:"npm-deprecation-warning"');
  if (alreadyGone) {
    console.log('✅ Already patched (npm deprecation warning not found)');
    process.exit(0);
  }

  const { patched, next } = applyPatchToText(originalText);
  if (!patched) {
    console.error('❌ Patch pattern not found.');
    console.error('   The Claude Code build may have changed.');
    console.error('   I did find key:"npm-deprecation-warning" but could not match the surrounding call shape.');
    console.error('   Try searching for this in the target file and paste ~1 line around it:');
    console.error('   key:"npm-deprecation-warning"');
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
  const originalLatin1 = originalBuf.toString('latin1');
  const alreadyGone = !originalLatin1.includes('key:"npm-deprecation-warning"');
  if (alreadyGone) {
    console.log('✅ Already patched (npm deprecation warning not found)');
    process.exit(0);
  }

  const { patched, out } = applyPatchToNativeBinary(originalBuf);
  if (!patched) {
    console.error('❌ Patch pattern not found.');
    console.error('   The Claude Code build may have changed.');
    console.error('   I did find key:"npm-deprecation-warning" but could not match the surrounding call shape.');
    console.error('   Try searching for this in the target file and paste ~1 line around it:');
    console.error('   key:"npm-deprecation-warning"');
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

console.log('\nNext: restart Claude Code to confirm the banner no longer appears.');
