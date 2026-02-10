#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Parse command line arguments
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

// Display help
if (showHelp) {
  console.log(
    'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11, 2.1.12, 2.1.14, 2.1.15, 2.1.17, 2.1.19, 2.1.20, 2.1.22, 2.1.23, 2.1.27, 2.1.30, 2.1.31, 2.1.32, 2.1.33, 2.1.34, 2.1.36, 2.1.37, 2.1.38)'
  );
  console.log('==============================================\n');
  console.log('Usage: node patch-thinking.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
  console.log('  --file PATH  Patch a specific cli.js file or native claude binary (skip auto-detection)');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node patch-thinking.js              # Apply patches');
  console.log('  node patch-thinking.js --dry-run    # Preview changes');
  console.log('  node patch-thinking.js --restore    # Restore original');
  console.log('  node patch-thinking.js --file PATH  # Patch a downloaded cli.js');
  process.exit(0);
}

console.log(
  'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11, 2.1.12, 2.1.14, 2.1.15, 2.1.17, 2.1.19, 2.1.20, 2.1.22, 2.1.23, 2.1.27, 2.1.30, 2.1.31, 2.1.32, 2.1.33, 2.1.34, 2.1.36, 2.1.37, 2.1.38)'
);
console.log('==============================================\n');

// Helper function to safely execute shell commands
function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    return null;
  }
}

function shellQuotePosix(str) {
  // Minimal safe quoting for POSIX shells (zsh/bash).
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
}

function adHocCodesignIfNeeded(filePath) {
  if (!isNativeBinary) return;
  if (process.platform !== 'darwin') return;

  // macOS hardened runtime + Developer ID binaries will be killed if modified.
  // Re-signing ad-hoc allows the patched binary to run again.
  try {
    execSync(`codesign --force --deep --sign - ${shellQuotePosix(filePath)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    console.log('✅ macOS codesign: re-signed patched native binary (ad-hoc)');
  } catch (error) {
    console.error('⚠️  macOS codesign failed. The patched binary may be killed when executed.');
    console.error('   You can try manually:');
    console.error(`   codesign --force --deep --sign - ${shellQuotePosix(filePath)}`);
  }
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

  // If it starts with a shebang, treat as script (npm-installed cli.js wrappers sometimes omit .js).
  const asUtf8 = prefix.toString('utf8');
  if (asUtf8.startsWith('#!')) return 'js';

  return 'unknown';
}

function getNativeCandidatePaths(homeDir) {
  const candidates = [];

  candidates.push(path.join(homeDir, '.local', 'bin', 'claude'));

  // Official native installer stores versioned binaries here (filenames are versions like 2.0.65).
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
        .filter(entry => {
          // Avoid accidentally patching backups created by this script or by users.
          // Native installs often contain both `2.1.20` and `2.1.20.backup`.
          return !String(entry).endsWith('.backup');
        })
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
          // Ignore entries we can't stat
        }
      }
    }
  } catch {
    // Ignore
  }

  return candidates;
}

// Auto-detect Claude Code installation (cli.js or native claude binary)
function getClaudeCodeTarget() {
  const homeDir = os.homedir();
  const attemptedPaths = [];

  // Helper to check and return path if it exists
  function checkPath(testPath, method) {
    if (!testPath) return null;

    attemptedPaths.push({ path: testPath, method });

    try {
      if (fs.existsSync(testPath)) {
        // Resolve symlinks for global npm installs
        try {
          const realPath = fs.realpathSync(testPath);
          const kind = detectClaudeTargetKind(realPath);
          if (kind === 'unknown') return null;
          return { path: realPath, kind, method };
        } catch (e) {
          const kind = detectClaudeTargetKind(testPath);
          if (kind === 'unknown') return null;
          return { path: testPath, kind, method };
        }
      }
    } catch (error) {
      // Path check failed, continue
    }
    return null;
  }

  // PRIORITY 1: Local installations (existing behavior - user overrides)
  const localPaths = [
    path.join(homeDir, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(homeDir, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];

  for (const localPath of localPaths) {
    const found = checkPath(localPath, 'local installation');
    if (found && found.kind === 'js') return found;
  }

  // PRIORITY 2: Global npm installation via 'npm root -g'
  const npmGlobalRoot = safeExec('npm root -g');
  if (npmGlobalRoot) {
    const npmGlobalPath = path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    const found = checkPath(npmGlobalPath, 'npm root -g');
    if (found && found.kind === 'js') return found;
  }

  // PRIORITY 3: Derive from process.execPath
  // Global modules are typically in ../lib/node_modules relative to node binary
  const nodeDir = path.dirname(process.execPath);
  const derivedGlobalPath = path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
  if (found && found.kind === 'js') return found;

  // PRIORITY 4: Unix systems - try 'which claude' to find binary
  if (process.platform !== 'win32') {
    const claudeBinary = safeExec('which claude');
    if (claudeBinary) {
      try {
        // Resolve symlinks
        const realBinary = fs.realpathSync(claudeBinary);

        // Some installs (e.g. nvs) symlink `claude` directly to `cli.js`.
        // In that case, treat it as the target file instead of deriving a lib/ path.
        if (realBinary.endsWith(path.join('@anthropic-ai', 'claude-code', 'cli.js'))) {
          const foundDirect = checkPath(realBinary, 'which claude (direct cli.js)');
          if (foundDirect && foundDirect.kind === 'js') return foundDirect;
        }

        // Otherwise, navigate from bin/claude to lib/node_modules/@anthropic-ai/claude-code/cli.js
        const binDir = path.dirname(realBinary);
        const nodeModulesPath = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        const foundFromBinary = checkPath(nodeModulesPath, 'which claude');
        if (foundFromBinary && foundFromBinary.kind === 'js') return foundFromBinary;

        // If we didn't find a JS install, the `claude` on PATH may itself be a native/binary install.
        const nativeFromWhich = checkPath(realBinary, 'which claude (native)');
        if (nativeFromWhich && nativeFromWhich.kind === 'native-binary') return nativeFromWhich;
      } catch (e) {
        // Failed to resolve, continue
      }
    }
  }

  // PRIORITY 5: Native/binary installation default paths (official installer)
  for (const candidate of getNativeCandidatePaths(homeDir)) {
    const native = checkPath(candidate, 'native/binary default paths');
    if (native && native.kind === 'native-binary') return native;
  }

  // No installation found, return null and include attempted paths for error reporting
  getClaudeCodeTarget.attemptedPaths = attemptedPaths;
  return null;
}

function resolveTarget() {
  const overridePath = fileArgPath || process.env.CLAUDE_CODE_CLI_PATH;
  if (overridePath) {
    const attemptedPaths = [];
    getClaudeCodeTarget.attemptedPaths = attemptedPaths;

    const resolved = path.resolve(overridePath);
    attemptedPaths.push({
      path: resolved,
      method: fileArgPath ? '--file' : 'CLAUDE_CODE_CLI_PATH',
    });

    if (!fs.existsSync(resolved)) return null;
    try {
      const real = fs.realpathSync(resolved);
      const kind = detectClaudeTargetKind(real);
      if (kind === 'unknown') return null;
      return { path: real, kind, method: fileArgPath ? '--file' : 'CLAUDE_CODE_CLI_PATH' };
    } catch {
      const kind = detectClaudeTargetKind(resolved);
      if (kind === 'unknown') return null;
      return { path: resolved, kind, method: fileArgPath ? '--file' : 'CLAUDE_CODE_CLI_PATH' };
    }
  }

  return getClaudeCodeTarget();
}

const target = resolveTarget();
const targetPath = target ? target.path : null;
const isNativeBinary = target ? target.kind === 'native-binary' : false;

function padRightSpaces(str, targetLen) {
  if (str.length > targetLen) return null;
  if (str.length === targetLen) return str;
  return str + ' '.repeat(targetLen - str.length);
}

function replaceOnceExact(source, search, replacement, label) {
  if (!isNativeBinary) return source.replace(search, replacement);

  const srcBuf = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  const searchBuf = Buffer.from(search, 'utf8');
  const replacementBuf = Buffer.from(replacement, 'utf8');

  if (replacementBuf.length > searchBuf.length) {
    throw new Error(
      `Native/binary install patch too large for in-place replacement (${label}): ` +
        `replacement bytes ${replacementBuf.length} > search bytes ${searchBuf.length}`
    );
  }

  const idx = srcBuf.indexOf(searchBuf);
  if (idx < 0) return srcBuf;

  const out = Buffer.from(srcBuf);
  replacementBuf.copy(out, idx);
  if (replacementBuf.length < searchBuf.length) {
    out.fill(0x20, idx + replacementBuf.length, idx + searchBuf.length);
  }
  return out;
}

function replaceRegexPreserveLength(source, regex, replacer, label) {
  if (!isNativeBinary) return source.replace(regex, replacer);
  if (Buffer.isBuffer(source)) {
    throw new Error(`Regex patches are not supported for native/binary installs (${label})`);
  }
  return source.replace(regex, (...args) => {
    const match = args[0];
    const replacement = typeof replacer === 'function' ? replacer(...args) : replacer;
    if (typeof replacement !== 'string') {
      throw new Error(`Unexpected non-string regex replacement for ${label}`);
    }
    const padded = padRightSpaces(replacement, match.length);
    if (padded === null) {
      throw new Error(
        `Native/binary install patch too large for in-place regex replacement (${label}): ` +
          `replacement length ${replacement.length} > match length ${match.length}`
      );
    }
    return padded;
  });
}

function replaceRegexPreserveLengthNativeString(source, regex, replacer, label) {
  if (typeof source !== 'string') {
    throw new Error(`Expected string for native regex replacement (${label})`);
  }

  let replacedCount = 0;
  const out = source.replace(regex, (...args) => {
    replacedCount += 1;
    const match = args[0];
    const replacement = typeof replacer === 'function' ? replacer(...args) : replacer;
    if (typeof replacement !== 'string') {
      throw new Error(`Unexpected non-string regex replacement for ${label}`);
    }
    const padded = padRightSpaces(replacement, match.length);
    if (padded === null) {
      throw new Error(
        `Native/binary install patch too large for in-place regex replacement (${label}): ` +
          `replacement length ${replacement.length} > match length ${match.length}`
      );
    }
    return padded;
  });

  return { out, replacedCount };
}

// Lightweight native/binary regex fallback (no extraction/repack):
// - Decode the binary as latin1 (1 byte per code unit)
// - Do length-preserving replacements in-place (pad with spaces)
// - Re-encode to latin1 bytes (same file size)
//
// This is less robust than true repacking, but avoids extra dependencies (e.g. node-lief).
const nativeRedactedThinkingCallsiteRegex_noBraces =
  /(case"redacted_thinking":)if\(![$\w]+&&![$\w]+(?:&&![$\w]+)?\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+\}\);)/g;
const nativeRedactedThinkingCallsiteRegex_withBraces =
  /(case"redacted_thinking":)\{if\(![$\w]+&&![$\w]+(?:&&![$\w]+)?\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+\}\);)\}/g;

// New-format thinking call site (2.0.77+ style), works for both npm and native bundles.
// We also preserve any props after hideInTranscript by capturing the tail.
const nativeThinkingCallsiteRegex_newFormat =
  /(case"thinking":)\{if\(![$\w]+&&![$\w]+(?:&&![$\w]+)?\)return null;return ([$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(,hideInTranscript:)([^,}]+)([^}]*)(\}\)\;?\})/g;

const nativeThinkingCallsiteRegex_oldFormat =
  /(case"thinking":)if\(![$\w]+&&![$\w]+(?:&&![$\w]+)?\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(\}\);?)/g;

function detectNativeRegexPatches(sourceBuf) {
  const text = Buffer.isBuffer(sourceBuf) ? sourceBuf.toString('latin1') : String(sourceBuf);
  const steps = [];

  // Avoid .test() with /g regex (lastIndex side effects); use a fresh regex each time.
  if (/case"redacted_thinking":/.test(text)) {
    if (
      new RegExp(nativeRedactedThinkingCallsiteRegex_noBraces.source).test(text) ||
      new RegExp(nativeRedactedThinkingCallsiteRegex_withBraces.source).test(text)
    ) {
      steps.push('native redacted_thinking call site (regex)');
    }
  }

  if (/case"thinking":/.test(text)) {
    if (
      new RegExp(nativeThinkingCallsiteRegex_newFormat.source).test(text) ||
      new RegExp(nativeThinkingCallsiteRegex_oldFormat.source).test(text)
    ) {
      steps.push('native thinking call site (regex)');
    }
  }

  return steps;
}

function applyNativeRegexPatches(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyNativeRegexPatches expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      nativeRedactedThinkingCallsiteRegex_noBraces,
      (_m, casePrefix, returnExpr) => `${casePrefix}${returnExpr}`,
      'native redacted_thinking call site (regex, no braces)'
    );
    if (replacedCount > 0) {
      text = out;
      steps.push(`native redacted_thinking call site (regex) x${replacedCount}`);
    }
  }

  {
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      nativeRedactedThinkingCallsiteRegex_withBraces,
      (_m, casePrefix, returnExpr) => `${casePrefix}{${returnExpr}}`,
      'native redacted_thinking call site (regex, braces)'
    );
    if (replacedCount > 0) {
      text = out;
      steps.push(`native redacted_thinking call site (regex, braces) x${replacedCount}`);
    }
  }

  {
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      nativeThinkingCallsiteRegex_newFormat,
      (
        _m,
        casePrefix,
        createPrefix,
        _oldIsTranscriptMode,
        verboseKey,
        verboseVar,
        hideKey,
        _oldHideValue,
        tail,
        suffix
      ) => {
        return `${casePrefix}{return ${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${tail}${suffix}`;
      },
      'native thinking call site (regex, new format)'
    );
    if (replacedCount > 0) {
      text = out;
      steps.push(`native thinking call site (regex, new format) x${replacedCount}`);
    }
  }

  {
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      nativeThinkingCallsiteRegex_oldFormat,
      (_m, casePrefix, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, suffix) => {
        return `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${suffix}`;
      },
      'native thinking call site (regex, old format)'
    );
    if (replacedCount > 0) {
      text = out;
      steps.push(`native thinking call site (regex, old format) x${replacedCount}`);
    }
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

function detectNativeAlreadyPatched(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) return false;
  const text = sourceBuf.toString('latin1');

  // Heuristic: patched call site forces transcript mode + disables hideInTranscript.
  const hasPatchedThinking =
    /case"thinking":\{[\s\S]{0,1400}?isTranscriptMode:!0[\s\S]{0,1400}?hideInTranscript:!1/.test(text) ||
    /case"thinking":return[\s\S]{0,1400}?isTranscriptMode:!0[\s\S]{0,1400}?hideInTranscript:!1/.test(text);

  // Heuristic: redacted_thinking no longer has the short-circuit gate.
  const hasUnGatedRedacted =
    /case"redacted_thinking":\{?return[\s\S]{0,500}?addMargin:/.test(text) &&
    !/case"redacted_thinking":\{?if\(!/.test(text);

  return hasPatchedThinking || hasUnGatedRedacted;
}

function detectJsAlreadyPatched(sourceText) {
  if (typeof sourceText !== 'string') return false;

  // Heuristic: patched call site forces transcript mode + disables hideInTranscript.
  const hasPatchedThinking =
    /case"thinking":\{[\s\S]{0,1400}?isTranscriptMode:!0[\s\S]{0,1400}?hideInTranscript:!1/.test(sourceText) ||
    /case"thinking":return[\s\S]{0,1400}?isTranscriptMode:!0[\s\S]{0,1400}?hideInTranscript:!1/.test(sourceText);

  // Heuristic: redacted_thinking no longer has the short-circuit gate.
  const hasUnGatedRedacted =
    /case"redacted_thinking":\{?return[\s\S]{0,500}?addMargin:/.test(sourceText) &&
    !/case"redacted_thinking":\{?if\(!/.test(sourceText);

  return hasPatchedThinking || hasUnGatedRedacted;
}

if (!targetPath) {
  console.error('❌ Error: Could not find Claude Code installation\n');
  console.error('Searched using the following methods:\n');

  const attemptedPaths = getClaudeCodeTarget.attemptedPaths || [];

  if (attemptedPaths.length > 0) {
    // Group by method for cleaner output
    const byMethod = {};
    attemptedPaths.forEach(({ path, method }) => {
      if (!byMethod[method]) byMethod[method] = [];
      byMethod[method].push(path);
    });

    Object.entries(byMethod).forEach(([method, paths]) => {
      console.error(`  [${method}]`);
      paths.forEach(p => console.error(`    - ${p}`));
    });
  } else {
    console.error('  - ~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js');
    console.error('  - ~/.config/claude/local/node_modules/@anthropic-ai/claude-code/cli.js');
    console.error('  - Global npm installation (npm root -g)');
    console.error('  - Native/binary installation (~/.local/bin/claude, ~/.local/share/claude/versions/*)');
  }

  console.error('\n💡 Troubleshooting:');
  console.error('  1. Verify Claude Code is installed: claude --version');
  console.error('  2. For local install: Check ~/.claude/local or ~/.config/claude/local');
  console.error('  3. For global install: Ensure "npm install -g @anthropic-ai/claude-code" succeeded');
  console.error('  4. Check that npm is in your PATH if using global install');
  console.error('  5. For native/binary install: Check ~/.local/bin/claude and ~/.local/share/claude/versions');
  process.exit(1);
}

console.log(`Found Claude Code at: ${targetPath}`);
console.log(`Installation type: ${isNativeBinary ? 'native/binary' : 'npm/local (cli.js)'}\n`);

const backupPath = targetPath + '.backup';

// Restore from backup
if (isRestore) {
  if (!fs.existsSync(backupPath)) {
    console.error('❌ Error: Backup file not found at:', backupPath);
    process.exit(1);
  }

  console.log('Restoring from backup...');
  fs.copyFileSync(backupPath, targetPath);
  console.log('✅ Restored successfully!');
  console.log('\nPlease restart Claude Code for changes to take effect.');
  process.exit(0);
}

// Read file
console.log(`Reading ${isNativeBinary ? 'claude binary' : 'cli.js'}...`);
if (!fs.existsSync(targetPath)) {
  console.error(`❌ Error: target not found at: ${targetPath}`);
  process.exit(1);
}

const fileEncoding = 'utf8';
let content = isNativeBinary ? fs.readFileSync(targetPath) : fs.readFileSync(targetPath, fileEncoding);
const originalContentLength = content.length;

// Patch patterns by Claude Code version.
// We keep exact-string matching because cli.js is heavily minified and patterns are version-specific.

// Patch 1: Remove the old collapsed thinking banner (present in older versions; kept for v2.0.62).
const bannerSearchPattern_v2062 =
  'function ZT2({streamMode:A}){let[Q,B]=rTA.useState(null),[G,Z]=rTA.useState(null);if(rTA.useEffect(()=>{if(A==="thinking"&&Q===null)B(Date.now());else if(A!=="thinking"&&Q!==null)Z(Date.now()-Q),B(null)},[A,Q]),A==="thinking")return GP.createElement(P,{marginTop:1},GP.createElement($,{dimColor:!0},"∴ Thinking…"));if(G!==null)return GP.createElement(P,{marginTop:1},GP.createElement($,{dimColor:!0},"∴ Thought for ",Math.max(1,Math.round(G/1000)),"s (",GP.createElement($,{dimColor:!0,bold:!0},"ctrl+o")," ","to show thinking)"));return null}';
const bannerReplacement_v2062 = 'function ZT2({streamMode:A}){return null}';

// Patch 2a: Force thinking visibility at the "case \"thinking\"" call site (v2.0.62).
const thinkingSearchPattern_v2062 =
  'case"thinking":if(!F&&!G)return null;return J3.createElement(X59,{addMargin:Q,param:A,isTranscriptMode:F,verbose:G});';
const thinkingReplacement_v2062 =
  'case"thinking":return J3.createElement(X59,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:G});';

// Patch 2b: Force thinking visibility (v2.0.74 / v2.0.75).
// In 2.0.74 and 2.0.75, thinking visibility is controlled in two places:
// 1) The message renderer call site can short-circuit and return null (hiding thinking entirely)
// 2) The thinking renderer (`co2`) can show a collapsed banner branch
//
// We patch both, so thinking renders inline by default (without ctrl+o).
const redactedThinkingCallsiteSearchPattern_v2074 =
  'case"redacted_thinking":if(!D&&!Z)return null;return J5.createElement(io2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v2074 = 'case"redacted_thinking":return J5.createElement(io2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v2074 =
  'case"thinking":if(!D&&!Z)return null;return J5.createElement(co2,{addMargin:Q,param:A,isTranscriptMode:D,verbose:Z});';
const thinkingCallsiteReplacement_v2074 =
  'case"thinking":return J5.createElement(co2,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z});';
//
// Note: we keep two exact-string variants because Anthropic occasionally tweaks the collapsed branch
// while keeping the expanded rendering stable.
const thinkingRendererSearchPattern_v2074_variantCollapsedBanner =
  'function co2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return Vs.default.createElement(T,{marginTop:Q?1:0},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (ctrl+o to expand)"));return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';
const thinkingRendererSearchPattern_v2074_variantNullGate =
  'function co2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return null;return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';
const thinkingRendererReplacement_v2074 =
  'function co2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';

// Patch 2d: Force thinking visibility (v2.0.76).
// In 2.0.76, the identifiers changed:
// - thinking renderer: `lo2` (was `co2`)
// - redacted_thinking renderer: `no2` (was `io2`)
//
// The visibility logic is otherwise identical to 2.0.74/2.0.75 (call-site gate + collapsed banner branch).
const redactedThinkingCallsiteSearchPattern_v2076 =
  'case"redacted_thinking":if(!D&&!Z)return null;return J5.createElement(no2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v2076 = 'case"redacted_thinking":return J5.createElement(no2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v2076 =
  'case"thinking":if(!D&&!Z)return null;return J5.createElement(lo2,{addMargin:Q,param:A,isTranscriptMode:D,verbose:Z});';
const thinkingCallsiteReplacement_v2076 =
  'case"thinking":return J5.createElement(lo2,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z});';
const thinkingRendererSearchPattern_v2076_variantCollapsedBanner =
  'function lo2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return Vs.default.createElement(T,{marginTop:Q?1:0},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (ctrl+o to expand)"));return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';
const thinkingRendererSearchPattern_v2076_variantNullGate =
  'function lo2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return null;return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';
const thinkingRendererReplacement_v2076 =
  'function lo2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;return Vs.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},Vs.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),Vs.default.createElement(T,{paddingLeft:2},Vs.default.createElement(C,{dimColor:!0,italic:!0},Vs.default.createElement(T$,null,A))))}';

// Patch 2c: Force thinking visibility (v2.0.71).
// In 2.0.71 the thinking renderer function is `mn2` and uses different minified identifiers.
const thinkingRendererSearchPattern_v2071_variantCollapsedBanner =
  'function mn2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return nr.default.createElement(T,{marginTop:Q?1:0},nr.default.createElement(z,{dimColor:!0,italic:!0},"∴ Thinking (ctrl+o to expand)"));return nr.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},nr.default.createElement(z,{dimColor:!0,italic:!0},"∴ Thinking…"),nr.default.createElement(T,{paddingLeft:2},nr.default.createElement(z,{dimColor:!0,italic:!0},nr.default.createElement(fE,null,A))))}';
const thinkingRendererSearchPattern_v2071_variantNullGate =
  'function mn2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;if(!(B||G))return null;return nr.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},nr.default.createElement(z,{dimColor:!0,italic:!0},"∴ Thinking…"),nr.default.createElement(T,{paddingLeft:2},nr.default.createElement(z,{dimColor:!0,italic:!0},nr.default.createElement(fE,null,A))))}';
const thinkingRendererReplacement_v2071 =
  'function mn2({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G}){if(!A)return null;return nr.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},nr.default.createElement(z,{dimColor:!0,italic:!0},"∴ Thinking…"),nr.default.createElement(T,{paddingLeft:2},nr.default.createElement(z,{dimColor:!0,italic:!0},nr.default.createElement(fE,null,A))))}';

// Patch 2e: Force thinking visibility (v2.1.1).
// In 2.1.1, thinking is still controlled in two places:
// 1) The message renderer call site can short-circuit and return null (hiding thinking entirely)
// 2) The thinking renderer (`NbA`) has BOTH a transcript hiding gate and a collapsed banner branch
//
// We patch all of them so thinking renders inline by default (without ctrl+o).
const redactedThinkingCallsiteSearchPattern_v2111 =
  'case"redacted_thinking":if(!D&&!Z)return null;return o8.createElement(ya2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v2111 = 'case"redacted_thinking":return o8.createElement(ya2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v2111 =
  'case"thinking":{if(!D&&!Z)return null;return o8.createElement(NbA,{addMargin:Q,param:A,isTranscriptMode:D,verbose:Z,hideInTranscript:D&&!(!$||z===$)})}';
const thinkingCallsiteReplacement_v2111 =
  'case"thinking":{return o8.createElement(NbA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v2111_variantCollapsedBanner =
  'function NbA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;if(Z)return null;if(!(B||G))return $6A.default.createElement(T,{marginTop:Q?1:0},$6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (ctrl+o to expand)"));return $6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},$6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),$6A.default.createElement(T,{paddingLeft:2},$6A.default.createElement(uV,null,A)))}';
const thinkingRendererSearchPattern_v2111_variantNullGate =
  'function NbA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;if(Z)return null;if(!(B||G))return null;return $6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},$6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),$6A.default.createElement(T,{paddingLeft:2},$6A.default.createElement(uV,null,A)))}';
const thinkingRendererReplacement_v2111 =
  'function NbA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return $6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},$6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),$6A.default.createElement(T,{paddingLeft:2},$6A.default.createElement(uV,null,A)))}';

// Patch 2f: Force thinking visibility (v2.1.2).
// In 2.1.2, the logic matches 2.1.1, but identifiers changed:
// - thinking renderer: `ybA` (was `NbA`)
// - redacted_thinking renderer: `Vo2` (was `ya2`)
const redactedThinkingCallsiteSearchPattern_v212 =
  'case"redacted_thinking":if(!F&&!Z)return null;return o8.createElement(Vo2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v212 = 'case"redacted_thinking":return o8.createElement(Vo2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v212 =
  'case"thinking":{if(!F&&!Z)return null;return o8.createElement(ybA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!z||C===z)})}';
const thinkingCallsiteReplacement_v212 =
  'case"thinking":{return o8.createElement(ybA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v212_variantCollapsedBanner =
  'function ybA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;if(Z)return null;if(!(B||G))return q6A.default.createElement(T,{marginTop:Q?1:0},q6A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (ctrl+o to expand)"));return q6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},q6A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),q6A.default.createElement(T,{paddingLeft:2},q6A.default.createElement(gK,null,A)))}';
const thinkingRendererSearchPattern_v212_variantNullGate =
  'function ybA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;if(Z)return null;if(!(B||G))return null;return q6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},q6A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),q6A.default.createElement(T,{paddingLeft:2},q6A.default.createElement(gK,null,A)))}';
const thinkingRendererReplacement_v212 =
  'function ybA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return q6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},q6A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),q6A.default.createElement(T,{paddingLeft:2},q6A.default.createElement(gK,null,A)))}';

// Patch 2g: Force thinking visibility (v2.1.3).
// In 2.1.3, the overall control structure is still:
// - call site short-circuit gate (transcript/verbose)
// - thinking renderer has hideInTranscript + collapsed banner branch
// Identifiers changed again:
// - thinking renderer: `dvA`
// - redacted_thinking renderer: `Z_2`
const redactedThinkingCallsiteSearchPattern_v213 =
  'case"redacted_thinking":if(!F&&!Z)return null;return J5.createElement(Z_2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v213 = 'case"redacted_thinking":return J5.createElement(Z_2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v213 =
  'case"thinking":{if(!F&&!Z)return null;return J5.createElement(dvA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!C||z===C)})}';
const thinkingCallsiteReplacement_v213 =
  'case"thinking":{return J5.createElement(dvA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v213_variantCollapsedBanner =
  'function dvA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=g4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return s4A.default.createElement(T,{marginTop:Q?1:0},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return s4A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),s4A.default.createElement(T,{paddingLeft:2},s4A.default.createElement(QV,null,A)))}';
const thinkingRendererSearchPattern_v213_variantNullGate =
  'function dvA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=g4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return s4A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),s4A.default.createElement(T,{paddingLeft:2},s4A.default.createElement(QV,null,A)))}';
const thinkingRendererReplacement_v213 =
  'function dvA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return s4A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),s4A.default.createElement(T,{paddingLeft:2},s4A.default.createElement(QV,null,A)))}';

// Patch 2h: Force thinking visibility (v2.1.4).
// In 2.1.4, the overall structure matches 2.1.3, but:
// - redacted_thinking renderer: `X_2` (was `Z_2`)
// - thinking renderer `dvA` uses `u4(...)` (was `g4(...)`) for the dynamic shortcut label
const redactedThinkingCallsiteSearchPattern_v214 =
  'case"redacted_thinking":if(!F&&!Z)return null;return J5.createElement(X_2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v214 = 'case"redacted_thinking":return J5.createElement(X_2,{addMargin:Q});';
const thinkingRendererSearchPattern_v214_variantCollapsedBanner =
  'function dvA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=u4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return s4A.default.createElement(T,{marginTop:Q?1:0},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return s4A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),s4A.default.createElement(T,{paddingLeft:2},s4A.default.createElement(QV,null,A)))}';
const thinkingRendererSearchPattern_v214_variantNullGate =
  'function dvA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=u4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return s4A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},s4A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),s4A.default.createElement(T,{paddingLeft:2},s4A.default.createElement(QV,null,A)))}';
const thinkingRendererReplacement_v214 = thinkingRendererReplacement_v213;

// Patch 2i: Force thinking visibility (v2.1.6).
// In 2.1.6, identifiers changed again:
// - thinking renderer: `_bA` (was `dvA`)
// - redacted_thinking renderer: `$g2`
// - createElement namespace: `Z5`
// - dynamic shortcut label helper: `s6(...)`
const redactedThinkingCallsiteSearchPattern_v216 =
  'case"redacted_thinking":if(!F&&!Z)return null;return Z5.createElement($g2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v216 = 'case"redacted_thinking":return Z5.createElement($g2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v216 =
  'case"thinking":{if(!F&&!Z)return null;return Z5.createElement(_bA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!$||z===$)})}';
const thinkingCallsiteReplacement_v216 =
  'case"thinking":{return Z5.createElement(_bA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v216_variantCollapsedBanner =
  'function _bA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=s6("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return k6A.default.createElement(T,{marginTop:Q?1:0},k6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return k6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},k6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),k6A.default.createElement(T,{paddingLeft:2},k6A.default.createElement(tK,null,A)))}';
const thinkingRendererSearchPattern_v216_variantNullGate =
  'function _bA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=s6("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return k6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},k6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),k6A.default.createElement(T,{paddingLeft:2},k6A.default.createElement(tK,null,A)))}';
const thinkingRendererReplacement_v216 =
  'function _bA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return k6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},k6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),k6A.default.createElement(T,{paddingLeft:2},k6A.default.createElement(tK,null,A)))}';

// Patch 2j: Force thinking visibility (v2.1.7).
// In 2.1.7, identifiers changed again:
// - thinking renderer: `gkA`
// - redacted_thinking renderer: `hT2`
// - createElement namespace: `K5`
// - dynamic shortcut label helper: `J3(...)`
// - react default namespace: `T6A.default`
const redactedThinkingCallsiteSearchPattern_v217 =
  'case"redacted_thinking":if(!F&&!Z)return null;return K5.createElement(hT2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v217 = 'case"redacted_thinking":return K5.createElement(hT2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v217 =
  'case"thinking":{if(!F&&!Z)return null;return K5.createElement(gkA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!$||z===$)})}';
const thinkingCallsiteReplacement_v217 =
  'case"thinking":{return K5.createElement(gkA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v217_variantCollapsedBanner =
  'function gkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=J3("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return T6A.default.createElement(T,{marginTop:Q?1:0},T6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return T6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},T6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),T6A.default.createElement(T,{paddingLeft:2},T6A.default.createElement(JV,null,A)))}';
const thinkingRendererSearchPattern_v217_variantNullGate =
  'function gkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=J3("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return T6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},T6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),T6A.default.createElement(T,{paddingLeft:2},T6A.default.createElement(JV,null,A)))}';
const thinkingRendererReplacement_v217 =
  'function gkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return T6A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},T6A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),T6A.default.createElement(T,{paddingLeft:2},T6A.default.createElement(JV,null,A)))}';

// Patch 2k: Force thinking visibility (v2.1.9).
// In 2.1.9, identifiers changed again:
// - thinking renderer: `NfA` (was `gkA`)
// - redacted_thinking renderer: `Cu2`
// - createElement namespace: `_8`
// - dynamic shortcut label helper: `v6(...)`
// - react default namespace: `V3A.default`
const redactedThinkingCallsiteSearchPattern_v219 =
  'case"redacted_thinking":if(!F&&!Z)return null;return _8.createElement(Cu2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v219 = 'case"redacted_thinking":return _8.createElement(Cu2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v219 =
  'case"thinking":{if(!F&&!Z)return null;return _8.createElement(NfA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!$||z===$)})}';
const thinkingCallsiteReplacement_v219 =
  'case"thinking":{return _8.createElement(NfA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
//
// Note: keep two exact-string variants because Anthropic occasionally tweaks the collapsed branch.
const thinkingRendererSearchPattern_v219_variantCollapsedBanner =
  'function NfA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=v6("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return V3A.default.createElement(T,{marginTop:Q?1:0},V3A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return V3A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},V3A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),V3A.default.createElement(T,{paddingLeft:2},V3A.default.createElement(VK,null,A)))}';
const thinkingRendererSearchPattern_v219_variantNullGate =
  'function NfA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=v6("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return V3A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},V3A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),V3A.default.createElement(T,{paddingLeft:2},V3A.default.createElement(VK,null,A)))}';
const thinkingRendererReplacement_v219 =
  'function NfA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return V3A.default.createElement(T,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},V3A.default.createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…"),V3A.default.createElement(T,{paddingLeft:2},V3A.default.createElement(VK,null,A)))}';

// Patch 2l: Force thinking visibility (v2.1.11).
// In 2.1.11, identifiers changed again:
// - thinking renderer: `FkA` (was `NfA`)
// - redacted_thinking renderer: `cu2`
// - createElement namespace: `N3`
// - dynamic shortcut label helper: `x4(...)`
// - react default namespace: `U9A.default`
const redactedThinkingCallsiteSearchPattern_v21111 =
  'case"redacted_thinking":if(!F&&!Z)return null;return N3.createElement(cu2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v21111 = 'case"redacted_thinking":return N3.createElement(cu2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v21111 =
  'case"thinking":{if(!F&&!Z)return null;return N3.createElement(FkA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!C||z===C)})}';
const thinkingCallsiteReplacement_v21111 =
  'case"thinking":{return N3.createElement(FkA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
//
// Note: keep two exact-string variants because Anthropic occasionally tweaks the collapsed branch.
const thinkingRendererSearchPattern_v21111_variantCollapsedBanner =
  'function FkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=x4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return U9A.default.createElement(j,{marginTop:Q?1:0},U9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return U9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},U9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),U9A.default.createElement(j,{paddingLeft:2},U9A.default.createElement($D,null,A)))}';
const thinkingRendererSearchPattern_v21111_variantNullGate =
  'function FkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=x4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return U9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},U9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),U9A.default.createElement(j,{paddingLeft:2},U9A.default.createElement($D,null,A)))}';
const thinkingRendererReplacement_v21111 =
  'function FkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return U9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},U9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),U9A.default.createElement(j,{paddingLeft:2},U9A.default.createElement($D,null,A)))}';

// Patch 2m: Force thinking visibility (v2.1.12).
// In 2.1.12, identifiers changed again:
// - thinking renderer: `WkA` (was `FkA`)
// - redacted_thinking renderer: `ju2` (was `cu2`)
// - dynamic shortcut label helper: `S4(...)` (was `x4(...)`)
// - react default namespace: `z9A.default` (was `U9A.default`)
//
// The overall control structure is the same as 2.1.11:
// - call site short-circuit gate (transcript/verbose)
// - thinking renderer has hideInTranscript + collapsed banner branch
const redactedThinkingCallsiteSearchPattern_v21112 =
  'case"redacted_thinking":if(!F&&!Z)return null;return N3.createElement(ju2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v21112 = 'case"redacted_thinking":return N3.createElement(ju2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v21112 =
  'case"thinking":{if(!F&&!Z)return null;return N3.createElement(WkA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!C||z===C)})}';
const thinkingCallsiteReplacement_v21112 =
  'case"thinking":{return N3.createElement(WkA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
//
// Note: keep two exact-string variants because Anthropic occasionally tweaks the collapsed branch.
const thinkingRendererSearchPattern_v21112_variantCollapsedBanner =
  'function WkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=S4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return z9A.default.createElement(j,{marginTop:Q?1:0},z9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return z9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},z9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),z9A.default.createElement(j,{paddingLeft:2},z9A.default.createElement($D,null,A)))}';
const thinkingRendererSearchPattern_v21112_variantNullGate =
  'function WkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=S4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return z9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},z9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),z9A.default.createElement(j,{paddingLeft:2},z9A.default.createElement($D,null,A)))}';
const thinkingRendererReplacement_v21112 =
  'function WkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return z9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},z9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),z9A.default.createElement(j,{paddingLeft:2},z9A.default.createElement($D,null,A)))}';

// Patch 2n: Force thinking visibility (v2.1.14).
// In 2.1.14, identifiers changed again:
// - thinking renderer: `zkA` (was `WkA`)
// - redacted_thinking renderer: `ru2` (was `ju2`)
// - createElement namespace: `q3` (was `N3`)
// - dynamic shortcut label helper: `T4(...)` (was `S4(...)`)
// - react default namespace: `L9A.default` (was `z9A.default`)
//
// The overall control structure is still:
// - call site short-circuit gate (transcript/verbose)
// - thinking renderer has hideInTranscript + collapsed banner branch
const redactedThinkingCallsiteSearchPattern_v21114 =
  'case"redacted_thinking":if(!F&&!Z)return null;return q3.createElement(ru2,{addMargin:Q});';
const redactedThinkingCallsiteReplacement_v21114 = 'case"redacted_thinking":return q3.createElement(ru2,{addMargin:Q});';
const thinkingCallsiteSearchPattern_v21114 =
  'case"thinking":{if(!F&&!Z)return null;return q3.createElement(zkA,{addMargin:Q,param:A,isTranscriptMode:F,verbose:Z,hideInTranscript:F&&!(!C||z===C)})}';
const thinkingCallsiteReplacement_v21114 =
  'case"thinking":{return q3.createElement(zkA,{addMargin:Q,param:A,isTranscriptMode:!0,verbose:Z,hideInTranscript:!1})}';
const thinkingRendererSearchPattern_v21114_variantCollapsedBanner =
  'function zkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=T4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return L9A.default.createElement(j,{marginTop:Q?1:0},L9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking (",Y," to expand)"));return L9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},L9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),L9A.default.createElement(j,{paddingLeft:2},L9A.default.createElement(FD,null,A)))}';
const thinkingRendererSearchPattern_v21114_variantNullGate =
  'function zkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){let Y=T4("app:toggleTranscript","Global","ctrl+o");if(!A)return null;if(Z)return null;if(!(B||G))return null;return L9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},L9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),L9A.default.createElement(j,{paddingLeft:2},L9A.default.createElement(FD,null,A)))}';
const thinkingRendererReplacement_v21114 =
  'function zkA({param:{thinking:A},addMargin:Q=!1,isTranscriptMode:B,verbose:G,hideInTranscript:Z=!1}){if(!A)return null;return L9A.default.createElement(j,{flexDirection:"column",gap:1,marginTop:Q?1:0,width:"100%"},L9A.default.createElement($,{dimColor:!0,italic:!0},"∴ Thinking…"),L9A.default.createElement(j,{paddingLeft:2},L9A.default.createElement(FD,null,A)))}';

// Regex-based fallback for v2.1.14 (inspired by tweakcc's thinkingVisibility.ts).
// cli.js is heavily minified and identifiers can change between builds; when the
// exact-string patterns fail, we use these more flexible patterns (scoped to 2.1.14).
//
// For 2.1.14, patching the call sites is sufficient:
// - removes the short-circuit gate (so thinking isn't dropped)
// - forces isTranscriptMode=true (so the renderer takes the expanded branch)
// - forces hideInTranscript=false (so transcript-mode hiding can't suppress it)
const redactedThinkingCallsiteRegex_v21114 =
  /(case"redacted_thinking":)if\(![$\w]+&&![$\w]+\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+\}\);)/;
const thinkingCallsiteRegex_v21114 =
  /(case"thinking":)\{if\(![$\w]+&&![$\w]+\)return null;return ([$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(,hideInTranscript:)([^}]+)\}\)\}/;

// Patch 2o: Force thinking visibility (v2.1.15).
// In 2.1.15, the call sites use a memo-cache branch (K[...] comparisons) and
// the thinking renderer is now `k_1`. The key bits are still the same:
// - call-site short-circuit: if(!isTranscriptMode && !verbose) return null
// - renderer short-circuit: hideInTranscript and a collapsed banner branch
//
// We patch only the call sites:
// - remove the short-circuit gate (so thinking isn't dropped)
// - force isTranscriptMode=true (so renderer takes expanded branch)
// - force hideInTranscript=false (so transcript-mode hiding can't suppress it)
const redactedThinkingCallsiteSearchPattern_v21115 =
  'case"redacted_thinking":{if(!D&&!H)return null;let f;if(K[20]!==Y)f=g3.createElement(wU7,{addMargin:Y}),K[20]=Y,K[21]=f;else f=K[21];return f}';
const redactedThinkingCallsiteReplacement_v21115 =
  'case"redacted_thinking":{let f;if(K[20]!==Y)f=g3.createElement(wU7,{addMargin:Y}),K[20]=Y,K[21]=f;else f=K[21];return f}';
const thinkingCallsiteSearchPattern_v21115 =
  'case"thinking":{if(!D&&!H)return null;let T=D&&!(!V||P===V),k;if(K[22]!==Y||K[23]!==D||K[24]!==q||K[25]!==T||K[26]!==H)k=g3.createElement(k_1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:T}),K[22]=Y,K[23]=D,K[24]=q,K[25]=T,K[26]=H,K[27]=k;else k=K[27];return k}';
const thinkingCallsiteReplacement_v21115 =
  'case"thinking":{let T=D&&!(!V||P===V),k;if(K[22]!==Y||K[23]!==D||K[24]!==q||K[25]!==T||K[26]!==H)k=g3.createElement(k_1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[22]=Y,K[23]=D,K[24]=q,K[25]=T,K[26]=H,K[27]=k;else k=K[27];return k}';

// Regex-based fallback for v2.1.15 (also inspired by tweakcc's thinkingVisibility.ts).
// We keep this scoped to VERSION:"2.1.15" because the memo-cache structure and
// identifiers change frequently across versions.
const redactedThinkingCallsiteGateRegex_v21115 =
  /(case"redacted_thinking":)\{if\(![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteGateRegex_v21115 = /(case"thinking":)\{if\(![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteArgsRegex_v21115 =
  /(case"thinking":[\s\S]{0,800}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(,hideInTranscript:)([$\w]+)(\}\))/;

// Patch 2p: Force thinking visibility (v2.1.17).
// In 2.1.17, identifiers changed again:
// - createElement namespace: `Y9`
// - redacted_thinking renderer: `aU7`
// - thinking renderer: `YW1`
//
// The underlying control structure remains:
// - call-site short-circuit: if(!isTranscriptMode && !verbose) return null
// - renderer has hideInTranscript + collapsed banner branch
//
// Like v2.1.15, patching only the call sites is sufficient:
// - remove the short-circuit gate (so thinking isn't dropped)
// - force isTranscriptMode=true (so renderer takes expanded branch)
// - force hideInTranscript=false (so transcript-mode hiding can't suppress it)
const redactedThinkingCallsiteSearchPattern_v21117 =
  'case"redacted_thinking":{if(!D&&!H)return null;let N;if(K[20]!==Y)N=Y9.createElement(aU7,{addMargin:Y}),K[20]=Y,K[21]=N;else N=K[21];return N}';
const redactedThinkingCallsiteReplacement_v21117 =
  'case"redacted_thinking":{let N;if(K[20]!==Y)N=Y9.createElement(aU7,{addMargin:Y}),K[20]=Y,K[21]=N;else N=K[21];return N}';
const thinkingCallsiteSearchPattern_v21117 =
  'case"thinking":{if(!D&&!H)return null;let T=D&&!(!P||f===P),k;if(K[22]!==Y||K[23]!==D||K[24]!==q||K[25]!==T||K[26]!==H)k=Y9.createElement(YW1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:T}),K[22]=Y,K[23]=D,K[24]=q,K[25]=T,K[26]=H,K[27]=k;else k=K[27];return k}';
const thinkingCallsiteReplacement_v21117 =
  'case"thinking":{let T=D&&!(!P||f===P),k;if(K[22]!==Y||K[23]!==D||K[24]!==q||K[25]!==T||K[26]!==H)k=Y9.createElement(YW1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[22]=Y,K[23]=D,K[24]=q,K[25]=T,K[26]=H,K[27]=k;else k=K[27];return k}';

// Native/binary variant for v2.1.17.
// The native build for 2.1.17 uses a simpler switch-case shape (no memo-cache),
// and different identifiers:
// - createElement namespace: `t9`
// - redacted_thinking renderer: `j_1`
// - thinking renderer: `FKA`
// - transcript/verbose vars: `X` / `E`
// - hideInTranscript expression: `X&&!(!K||J===K)`
//
// We patch only the call sites, same rationale as npm builds:
// - remove the short-circuit gate
// - force isTranscriptMode=true
// - force hideInTranscript=false
const redactedThinkingCallsiteSearchPattern_v21117_native =
  'case"redacted_thinking":if(!X&&!E)return null;return t9.createElement(j_1,{addMargin:A});';
const redactedThinkingCallsiteReplacement_v21117_native =
  'case"redacted_thinking":return t9.createElement(j_1,{addMargin:A});';
const thinkingCallsiteSearchPattern_v21117_native =
  'case"thinking":{if(!X&&!E)return null;return t9.createElement(FKA,{addMargin:A,param:H,isTranscriptMode:X,verbose:E,hideInTranscript:X&&!(!K||J===K)})}';
const thinkingCallsiteReplacement_v21117_native =
  'case"thinking":{return t9.createElement(FKA,{addMargin:A,param:H,isTranscriptMode:!0,verbose:E,hideInTranscript:!1})}';

// Regex-based fallback for v2.1.17 (inspired by tweakcc's thinkingVisibility.ts).
// Keep this scoped to VERSION:"2.1.17" to avoid accidental matches across versions.
const redactedThinkingCallsiteGateRegex_v21117 =
  /(case"redacted_thinking":)\{if\(![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteGateRegex_v21117 = /(case"thinking":)\{if\(![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteArgsRegex_v21117 =
  /(case"thinking":[\s\S]{0,800}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(,hideInTranscript:)([$\w]+)(\}\))/;

// Patch 2q: Force thinking visibility (v2.1.19).
// In 2.1.19 (npm build), the call-site gate adds a third condition:
// - if(!isTranscriptMode && !verbose && !T) return null
// Like v2.1.15 and v2.1.17, patching only the call sites is sufficient:
// - remove the short-circuit gate (so thinking isn't dropped)
// - force isTranscriptMode=true (so renderer takes expanded branch)
// - force hideInTranscript=false (so transcript-mode hiding can't suppress it)
const redactedThinkingCallsiteSearchPattern_v21119 =
  'case"redacted_thinking":{if(!D&&!H&&!T)return null;let k;if(K[21]!==Y)k=H9.createElement(OU7,{addMargin:Y}),K[21]=Y,K[22]=k;else k=K[22];return k}';
const redactedThinkingCallsiteReplacement_v21119 =
  'case"redacted_thinking":{let k;if(K[21]!==Y)k=H9.createElement(OU7,{addMargin:Y}),K[21]=Y,K[22]=k;else k=K[22];return k}';
const thinkingCallsiteSearchPattern_v21119 =
  'case"thinking":{if(!D&&!H&&!T)return null;let R=D&&!(!V||P===V)&&!T,x;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)x=H9.createElement(oG1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:R}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=x;else x=K[28];return x}';
const thinkingCallsiteReplacement_v21119 =
  'case"thinking":{let R=D&&!(!V||P===V)&&!T,x;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)x=H9.createElement(oG1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=x;else x=K[28];return x}';

// Regex-based fallback for v2.1.19 (inspired by tweakcc's thinkingVisibility.ts).
// Keep this scoped to VERSION:"2.1.19" to avoid accidental matches across versions.
const redactedThinkingCallsiteGateRegex_v21119 =
  /(case"redacted_thinking":)\{if\(![$\w]+&&![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteGateRegex_v21119 = /(case"thinking":)\{if\(![$\w]+&&![$\w]+&&![$\w]+\)return null;/;
const thinkingCallsiteArgsRegex_v21119 =
  /(case"thinking":[\s\S]{0,900}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:)([$\w]+)(,hideInTranscript:)([$\w]+)(\}\))/;

const thinkingCallsiteReplacer_v21114 =
  (_m, casePrefix, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey) =>
    `${casePrefix}{return ${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1})}`;

const applyRegexPatches_v21114 = source =>
  applyJsRegexPatchRules(source, [
    {
      regex: redactedThinkingCallsiteRegex_v21114,
      replacer: (_m, casePrefix, returnExpr) => `${casePrefix}${returnExpr}`,
      label: 'v2.1.14 redacted_thinking call site (regex)',
      step: 'v2.1.14 redacted_thinking call site (regex)',
    },
    {
      regex: thinkingCallsiteRegex_v21114,
      replacer: thinkingCallsiteReplacer_v21114,
      label: 'v2.1.14 thinking call site (regex)',
      step: 'v2.1.14 thinking call site (regex)',
    },
  ]);

const thinkingCallsiteArgsVisibilityReplacer =
  (_m, casePrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideVar, suffix) =>
    `${casePrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`;

function buildCallsiteGateAndArgsRegexPatch(version, redactedGateRegex, thinkingGateRegex, thinkingArgsRegex) {
  const versionLabel = `v${version}`;
  const addOpeningBraceReplacer = (_m, casePrefix) => `${casePrefix}{`;

  return source =>
    applyJsRegexPatchRules(source, [
      {
        regex: redactedGateRegex,
        replacer: addOpeningBraceReplacer,
        label: `${versionLabel} redacted_thinking call site gate (regex)`,
        step: `${versionLabel} redacted_thinking call site gate (regex)`,
      },
      {
        regex: thinkingGateRegex,
        replacer: addOpeningBraceReplacer,
        label: `${versionLabel} thinking call site gate (regex)`,
        step: `${versionLabel} thinking call site gate (regex)`,
      },
      {
        regex: thinkingArgsRegex,
        replacer: thinkingCallsiteArgsVisibilityReplacer,
        label: `${versionLabel} thinking call site args (regex)`,
        step: `${versionLabel} thinking call site args (regex)`,
      },
    ]);
}

const applyRegexPatches_v21115 = buildCallsiteGateAndArgsRegexPatch(
  '2.1.15',
  redactedThinkingCallsiteGateRegex_v21115,
  thinkingCallsiteGateRegex_v21115,
  thinkingCallsiteArgsRegex_v21115
);

const applyRegexPatches_v21117 = buildCallsiteGateAndArgsRegexPatch(
  '2.1.17',
  redactedThinkingCallsiteGateRegex_v21117,
  thinkingCallsiteGateRegex_v21117,
  thinkingCallsiteArgsRegex_v21117
);

const applyRegexPatches_v21119 = buildCallsiteGateAndArgsRegexPatch(
  '2.1.19',
  redactedThinkingCallsiteGateRegex_v21119,
  thinkingCallsiteGateRegex_v21119,
  thinkingCallsiteArgsRegex_v21119
);

// Patch 2r: Force thinking visibility (v2.1.20).
// In 2.1.20 (npm build), the call-site shape matches v2.1.19:
// - if(!isTranscriptMode && !verbose && !T) return null
// Patching only the call sites is sufficient:
// - remove the short-circuit gate (so thinking isn't dropped)
// - force isTranscriptMode=true (so renderer takes expanded branch)
// - force hideInTranscript=false (so transcript-mode hiding can't suppress it)
const redactedThinkingCallsiteSearchPattern_v21120 =
  'case"redacted_thinking":{if(!D&&!H&&!T)return null;let k;if(K[21]!==Y)k=H9.createElement(i6K,{addMargin:Y}),K[21]=Y,K[22]=k;else k=K[22];return k}';
const redactedThinkingCallsiteReplacement_v21120 =
  'case"redacted_thinking":{let k;if(K[21]!==Y)k=H9.createElement(i6K,{addMargin:Y}),K[21]=Y,K[22]=k;else k=K[22];return k}';
const thinkingCallsiteSearchPattern_v21120 =
  'case"thinking":{if(!D&&!H&&!T)return null;let R=D&&!(!V||P===V)&&!T,b;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)b=H9.createElement(Ej1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:R}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=b;else b=K[28];return b}';
const thinkingCallsiteReplacement_v21120 =
  'case"thinking":{let R=D&&!(!V||P===V)&&!T,b;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)b=H9.createElement(Ej1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=b;else b=K[28];return b}';

// Patch 2s: Force thinking visibility (v2.1.22).
// 2.1.22 matches the same overall call-site structure as 2.1.20, but identifiers changed:
// - createElement callee + renderer component differ
// We still patch only the call sites:
// - remove the short-circuit gate
// - force isTranscriptMode=true
// - force hideInTranscript=false
const redactedThinkingCallsiteSearchPattern_v21122 =
  'case"redacted_thinking":{if(!D&&!H&&!T)return null;let E;if(K[21]!==Y)E=Y9.createElement(c8K,{addMargin:Y}),K[21]=Y,K[22]=E;else E=K[22];return E}';
const redactedThinkingCallsiteReplacement_v21122 =
  'case"redacted_thinking":{let E;if(K[21]!==Y)E=Y9.createElement(c8K,{addMargin:Y}),K[21]=Y,K[22]=E;else E=K[22];return E}';
const thinkingCallsiteSearchPattern_v21122 =
  'case"thinking":{if(!D&&!H&&!T)return null;let R=D&&!(!V||P===V)&&!T,b;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)b=Y9.createElement(iM1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:R}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=b;else b=K[28];return b}';
const thinkingCallsiteReplacement_v21122 =
  'case"thinking":{let R=D&&!(!V||P===V)&&!T,b;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)b=Y9.createElement(iM1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=b;else b=K[28];return b}';

// Patch 2t: Force thinking visibility (v2.1.23).
// 2.1.23 matches the same overall call-site structure as 2.1.22, but identifiers changed:
// - createElement namespace: `z9`
// - redacted_thinking renderer: `q7K`
// - thinking renderer: `NP1`
// We patch only the call sites:
// - remove the short-circuit gate
// - force isTranscriptMode=true
// - force hideInTranscript=false
const redactedThinkingCallsiteSearchPattern_v21123 =
  'case"redacted_thinking":{if(!D&&!H&&!T)return null;let C;if(K[21]!==Y)C=z9.createElement(q7K,{addMargin:Y}),K[21]=Y,K[22]=C;else C=K[22];return C}';
const redactedThinkingCallsiteReplacement_v21123 =
  'case"redacted_thinking":{let C;if(K[21]!==Y)C=z9.createElement(q7K,{addMargin:Y}),K[21]=Y,K[22]=C;else C=K[22];return C}';
const thinkingCallsiteSearchPattern_v21123 =
  'case"thinking":{if(!D&&!H&&!T)return null;let R=D&&!(!f||P===f)&&!T,x;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)x=z9.createElement(NP1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:R}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=x;else x=K[28];return x}';
const thinkingCallsiteReplacement_v21123 =
  'case"thinking":{let R=D&&!(!f||P===f)&&!T,x;if(K[23]!==Y||K[24]!==D||K[25]!==q||K[26]!==R||K[27]!==H)x=z9.createElement(NP1,{addMargin:Y,param:q,isTranscriptMode:!0,verbose:H,hideInTranscript:!1}),K[23]=Y,K[24]=D,K[25]=q,K[26]=R,K[27]=H,K[28]=x;else x=K[28];return x}';

// Regex-based fallback for v2.1.20 (inspired by tweakcc's thinkingVisibility.ts).
// NOTE: The caller gates this on `content.includes('VERSION:"2.1.20"')`.
// We keep the regex itself relatively general to handle minor minifier diffs.
const redactedThinkingCallsiteGateRegex_v21120 = /(case"redacted_thinking":\{?)(if\([^)]*\)return null;)/;

// Unified pattern (tweakcc-style) that:
// - removes the early-return gate `if(...)return null;`
// - forces `isTranscriptMode:!0`
// - forces `hideInTranscript:!1` (needed in 2.1.20 to prevent transcript hiding)
const thinkingVisibilityRegex_v21120 =
  /(case"thinking":\{?)(if\([^)]*\)return null;)([\s\S]{0,1200}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([^,}]+)(,verbose:)([^,}]+)(,hideInTranscript:)([^,}]+)(\}\))/;

// Regex-based fallback for v2.1.22/v2.1.23/v2.1.27 share 2.1.20 structure.
const redactedThinkingCallsiteGateRegex_v21122 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21122 = thinkingVisibilityRegex_v21120;
const redactedThinkingCallsiteGateRegex_v21123 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21123 = thinkingVisibilityRegex_v21120;
const redactedThinkingCallsiteGateRegex_v21127 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21127 = thinkingVisibilityRegex_v21120;

// In v2.1.30+, thinking call site no longer passes `verbose:` at this point.
const redactedThinkingCallsiteGateRegex_v2130 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2130 =
  /(case"thinking":\{?)(if\([^)]*\)return null;)([\s\S]{0,1400}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([^,}]+)(,hideInTranscript:)([^,}]+)(\}\))/;
const redactedThinkingCallsiteGateRegex_v2131 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2131 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2132 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2132 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2133 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2133 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2134 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2134 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2136 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2136 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2137 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2137 = thinkingVisibilityRegex_v2130;
const redactedThinkingCallsiteGateRegex_v2138 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2138 = thinkingVisibilityRegex_v2130;

function applyJsRegexPatchRules(source, rules) {
  let out = source;
  const steps = [];

  for (const rule of rules) {
    const detectRegex = new RegExp(rule.regex.source, rule.regex.flags.replace(/g/g, ''));
    if (!detectRegex.test(out)) continue;
    out = replaceRegexPreserveLength(out, rule.regex, rule.replacer, rule.label);
    steps.push(rule.step);
  }

  return { out, steps };
}

function applyNativeRegexPatchRules(sourceBuf, fnName, rules) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error(`${fnName} expected a Buffer`);
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  for (const rule of rules) {
    const flags = rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`;
    const regex = new RegExp(rule.regex.source, flags);
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(text, regex, rule.replacer, rule.label);
    text = out;
    if (replacedCount > 0) {
      steps.push(`${rule.step} x${replacedCount}`);
    }
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }

  return { out: outBuf, steps };
}

function buildThinkingVisibilityRegexPatchPair(version, gateRegex, thinkingRegex, thinkingReplacer, nativeFnName) {
  const versionLabel = `v${version}`;
  const stripRedactedGateReplacer = (_m, casePrefix) => `${casePrefix}`;

  const jsRules = [
    {
      regex: gateRegex,
      replacer: stripRedactedGateReplacer,
      label: `${versionLabel} redacted_thinking call site gate (regex)`,
      step: `${versionLabel} redacted_thinking call site gate (regex)`,
    },
    {
      regex: thinkingRegex,
      replacer: thinkingReplacer,
      label: `${versionLabel} thinking visibility (regex)`,
      step: `${versionLabel} thinking visibility (regex)`,
    },
  ];

  const nativeRules = [
    {
      regex: gateRegex,
      replacer: stripRedactedGateReplacer,
      label: `${versionLabel} redacted_thinking call site gate (native regex)`,
      step: `${versionLabel} redacted_thinking call site gate (native regex)`,
    },
    {
      regex: thinkingRegex,
      replacer: thinkingReplacer,
      label: `${versionLabel} thinking visibility (native regex)`,
      step: `${versionLabel} thinking visibility (native regex)`,
    },
  ];

  return {
    jsFn: source => applyJsRegexPatchRules(source, jsRules),
    nativeFn: sourceBuf => applyNativeRegexPatchRules(sourceBuf, nativeFnName, nativeRules),
  };
}

const thinkingVisibilityReplacer_withVerbose =
  (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
    `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`;

const thinkingVisibilityReplacer_withoutVerbose =
  (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, hideKey, _oldHideValue, suffix) =>
    `${casePrefix}${createPrefix}!0${hideKey}!1${suffix}`;

const { jsFn: applyRegexPatches_v21120, nativeFn: applyRegexPatches_v21120_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.20',
    redactedThinkingCallsiteGateRegex_v21120,
    thinkingVisibilityRegex_v21120,
    thinkingVisibilityReplacer_withVerbose,
    'applyRegexPatches_v21120_native'
  );

const { jsFn: applyRegexPatches_v21122, nativeFn: applyRegexPatches_v21122_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.22',
    redactedThinkingCallsiteGateRegex_v21122,
    thinkingVisibilityRegex_v21122,
    thinkingVisibilityReplacer_withVerbose,
    'applyRegexPatches_v21122_native'
  );

const { jsFn: applyRegexPatches_v21123, nativeFn: applyRegexPatches_v21123_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.23',
    redactedThinkingCallsiteGateRegex_v21123,
    thinkingVisibilityRegex_v21123,
    thinkingVisibilityReplacer_withVerbose,
    'applyRegexPatches_v21123_native'
  );

const { jsFn: applyRegexPatches_v21127, nativeFn: applyRegexPatches_v21127_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.27',
    redactedThinkingCallsiteGateRegex_v21127,
    thinkingVisibilityRegex_v21127,
    thinkingVisibilityReplacer_withVerbose,
    'applyRegexPatches_v21127_native'
  );

const { jsFn: applyRegexPatches_v2130, nativeFn: applyRegexPatches_v2130_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.30',
    redactedThinkingCallsiteGateRegex_v2130,
    thinkingVisibilityRegex_v2130,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2130_native'
  );

const { jsFn: applyRegexPatches_v2131, nativeFn: applyRegexPatches_v2131_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.31',
    redactedThinkingCallsiteGateRegex_v2131,
    thinkingVisibilityRegex_v2131,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2131_native'
  );

const { jsFn: applyRegexPatches_v2132, nativeFn: applyRegexPatches_v2132_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.32',
    redactedThinkingCallsiteGateRegex_v2132,
    thinkingVisibilityRegex_v2132,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2132_native'
  );

const { jsFn: applyRegexPatches_v2133, nativeFn: applyRegexPatches_v2133_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.33',
    redactedThinkingCallsiteGateRegex_v2133,
    thinkingVisibilityRegex_v2133,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2133_native'
  );

const { jsFn: applyRegexPatches_v2134, nativeFn: applyRegexPatches_v2134_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.34',
    redactedThinkingCallsiteGateRegex_v2134,
    thinkingVisibilityRegex_v2134,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2134_native'
  );

const { jsFn: applyRegexPatches_v2136, nativeFn: applyRegexPatches_v2136_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.36',
    redactedThinkingCallsiteGateRegex_v2136,
    thinkingVisibilityRegex_v2136,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2136_native'
  );

const { jsFn: applyRegexPatches_v2137, nativeFn: applyRegexPatches_v2137_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.37',
    redactedThinkingCallsiteGateRegex_v2137,
    thinkingVisibilityRegex_v2137,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2137_native'
  );

const { jsFn: applyRegexPatches_v2138, nativeFn: applyRegexPatches_v2138_native } =
  buildThinkingVisibilityRegexPatchPair(
    '2.1.38',
    redactedThinkingCallsiteGateRegex_v2138,
    thinkingVisibilityRegex_v2138,
    thinkingVisibilityReplacer_withoutVerbose,
    'applyRegexPatches_v2138_native'
  );


let patch1Applied = false;
let patch2Applied = false;
let patch1AlreadyApplied = false;
let patch2AlreadyApplied = false;
const patch2PlannedSteps = [];

const regexPatchRegistry = [
  { version: '2.1.14', js: applyRegexPatches_v21114 },
  { version: '2.1.15', js: applyRegexPatches_v21115 },
  { version: '2.1.17', js: applyRegexPatches_v21117 },
  { version: '2.1.19', js: applyRegexPatches_v21119 },
  { version: '2.1.20', js: applyRegexPatches_v21120, native: applyRegexPatches_v21120_native },
  { version: '2.1.22', js: applyRegexPatches_v21122, native: applyRegexPatches_v21122_native },
  { version: '2.1.23', js: applyRegexPatches_v21123, native: applyRegexPatches_v21123_native },
  {
    version: '2.1.27',
    js: applyRegexPatches_v21127,
    native: applyRegexPatches_v21127_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.30',
    js: applyRegexPatches_v2130,
    native: applyRegexPatches_v2130_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.31',
    js: applyRegexPatches_v2131,
    native: applyRegexPatches_v2131_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.32',
    js: applyRegexPatches_v2132,
    native: applyRegexPatches_v2132_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.33',
    js: applyRegexPatches_v2133,
    native: applyRegexPatches_v2133_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.34',
    js: applyRegexPatches_v2134,
    native: applyRegexPatches_v2134_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.36',
    js: applyRegexPatches_v2136,
    native: applyRegexPatches_v2136_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.37',
    js: applyRegexPatches_v2137,
    native: applyRegexPatches_v2137_native,
    jsStandaloneDetect: true,
  },
  {
    version: '2.1.38',
    js: applyRegexPatches_v2138,
    native: applyRegexPatches_v2138_native,
    jsStandaloneDetect: true,
  },
];

const jsRegexVersionPatches = regexPatchRegistry.map(({ version, js }) => ({ version, fn: js }));

const nativeRegexVersionPatches = regexPatchRegistry
  .filter(({ native }) => typeof native === 'function')
  .map(({ version, native }) => ({ version, fn: native }));

const jsRegexDetectCache = new Map();
function getJsRegexDetectSteps(version, applyFn) {
  if (isNativeBinary || !content.includes(`VERSION:"${version}"`)) return [];
  if (!jsRegexDetectCache.has(version)) {
    jsRegexDetectCache.set(version, applyFn(content).steps);
  }
  return jsRegexDetectCache.get(version);
}

const jsRegexStandaloneDetectVersions = new Set(
  regexPatchRegistry.filter(({ jsStandaloneDetect }) => jsStandaloneDetect).map(({ version }) => version)
);

const standaloneJsRegexVersionPatches = jsRegexVersionPatches.filter(({ version }) =>
  jsRegexStandaloneDetectVersions.has(version)
);

function markPatch2Detected(step) {
  patch2Applied = true;
  patch2PlannedSteps.push(step);
}

function markPatch2DetectedSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return;
  patch2Applied = true;
  patch2PlannedSteps.push(...steps);
}

function detectExactPatchState(searchPattern, replacementPattern, plannedStep, alreadyLabel) {
  if (content.includes(searchPattern)) {
    markPatch2Detected(plannedStep);
    return 'found';
  }
  if (content.includes(replacementPattern)) {
    console.log(`  ⚠️  Already applied (${alreadyLabel})`);
    return 'already';
  }
  return 'none';
}

function detectAnyExactPatchState(searchPatterns, replacementPattern, plannedStep, alreadyLabel) {
  if (searchPatterns.some(searchPattern => content.includes(searchPattern))) {
    markPatch2Detected(plannedStep);
    return 'found';
  }
  if (content.includes(replacementPattern)) {
    console.log(`  ⚠️  Already applied (${alreadyLabel})`);
    return 'already';
  }
  return 'none';
}

function applyExactPatch(searchPattern, replacementPattern, replaceLabel, successMessage) {
  if (!content.includes(searchPattern)) return;
  content = replaceOnceExact(content, searchPattern, replacementPattern, replaceLabel);
  console.log(successMessage);
}

function applyAnyExactPatch(searchPatterns, replacementPattern, replaceLabels, successMessage) {
  searchPatterns.forEach((searchPattern, idx) => {
    if (!content.includes(searchPattern)) return;
    const replaceLabel = Array.isArray(replaceLabels)
      ? replaceLabels[Math.min(idx, replaceLabels.length - 1)]
      : replaceLabels;
    content = replaceOnceExact(content, searchPattern, replacementPattern, replaceLabel);
    console.log(successMessage);
  });
}

function hasVersionTag(version) {
  return content.includes(`VERSION:"${version}"`);
}

function detectJsRegexStep(version, applyFn, regexStepNames, plannedStep) {
  if (isNativeBinary || !hasVersionTag(version)) return;
  const steps = getJsRegexDetectSteps(version, applyFn);
  if (regexStepNames.some(stepName => steps.includes(stepName))) {
    markPatch2Detected(plannedStep);
  }
}

const legacyExactPatchRules = [
  {
    kind: 'exact',
    searchPattern: thinkingSearchPattern_v2062,
    replacementPattern: thinkingReplacement_v2062,
    plannedStep: 'v2.0.62 call site',
    alreadyLabel: 'v2.0.62 call site',
    replaceLabel: 'v2.0.62 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.0.62 call site)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v2074,
    replacementPattern: redactedThinkingCallsiteReplacement_v2074,
    plannedStep: 'v2.0.74 redacted_thinking call site',
    alreadyLabel: 'v2.0.74 redacted_thinking call site',
    replaceLabel: 'v2.0.74 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.0.74 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v2074,
    replacementPattern: thinkingCallsiteReplacement_v2074,
    plannedStep: 'v2.0.74 thinking call site',
    alreadyLabel: 'v2.0.74 thinking call site',
    replaceLabel: 'v2.0.74 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.0.74 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v2074_variantCollapsedBanner, thinkingRendererSearchPattern_v2074_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v2074,
    plannedStep: 'v2.0.74 thinking renderer',
    alreadyLabel: 'v2.0.74 thinking renderer',
    replaceLabels: ['v2.0.74 thinking renderer (collapsed banner)', 'v2.0.74 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.0.74 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v2076,
    replacementPattern: redactedThinkingCallsiteReplacement_v2076,
    plannedStep: 'v2.0.76 redacted_thinking call site',
    alreadyLabel: 'v2.0.76 redacted_thinking call site',
    replaceLabel: 'v2.0.76 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.0.76 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v2076,
    replacementPattern: thinkingCallsiteReplacement_v2076,
    plannedStep: 'v2.0.76 thinking call site',
    alreadyLabel: 'v2.0.76 thinking call site',
    replaceLabel: 'v2.0.76 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.0.76 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v2076_variantCollapsedBanner, thinkingRendererSearchPattern_v2076_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v2076,
    plannedStep: 'v2.0.76 thinking renderer',
    alreadyLabel: 'v2.0.76 thinking renderer',
    replaceLabels: ['v2.0.76 thinking renderer (collapsed banner)', 'v2.0.76 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.0.76 thinking renderer)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v2071_variantCollapsedBanner, thinkingRendererSearchPattern_v2071_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v2071,
    plannedStep: 'v2.0.71 thinking renderer',
    alreadyLabel: 'v2.0.71 thinking renderer',
    replaceLabels: ['v2.0.71 thinking renderer (collapsed banner)', 'v2.0.71 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.0.71 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v2111,
    replacementPattern: redactedThinkingCallsiteReplacement_v2111,
    plannedStep: 'v2.1.1 redacted_thinking call site',
    alreadyLabel: 'v2.1.1 redacted_thinking call site',
    replaceLabel: 'v2.1.1 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.1 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v2111,
    replacementPattern: thinkingCallsiteReplacement_v2111,
    plannedStep: 'v2.1.1 thinking call site',
    alreadyLabel: 'v2.1.1 thinking call site',
    replaceLabel: 'v2.1.1 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.1 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v2111_variantCollapsedBanner, thinkingRendererSearchPattern_v2111_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v2111,
    plannedStep: 'v2.1.1 thinking renderer',
    alreadyLabel: 'v2.1.1 thinking renderer',
    replaceLabels: ['v2.1.1 thinking renderer (collapsed banner)', 'v2.1.1 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.1 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v212,
    replacementPattern: redactedThinkingCallsiteReplacement_v212,
    plannedStep: 'v2.1.2 redacted_thinking call site',
    alreadyLabel: 'v2.1.2 redacted_thinking call site',
    replaceLabel: 'v2.1.2 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.2 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v212,
    replacementPattern: thinkingCallsiteReplacement_v212,
    plannedStep: 'v2.1.2 thinking call site',
    alreadyLabel: 'v2.1.2 thinking call site',
    replaceLabel: 'v2.1.2 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.2 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v212_variantCollapsedBanner, thinkingRendererSearchPattern_v212_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v212,
    plannedStep: 'v2.1.2 thinking renderer',
    alreadyLabel: 'v2.1.2 thinking renderer',
    replaceLabels: ['v2.1.2 thinking renderer (collapsed banner)', 'v2.1.2 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.2 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v213,
    replacementPattern: redactedThinkingCallsiteReplacement_v213,
    plannedStep: 'v2.1.3 redacted_thinking call site',
    alreadyLabel: 'v2.1.3 redacted_thinking call site',
    replaceLabel: 'v2.1.3 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.3 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v213,
    replacementPattern: thinkingCallsiteReplacement_v213,
    plannedStep: 'v2.1.3 thinking call site',
    alreadyLabel: 'v2.1.3 thinking call site',
    replaceLabel: 'v2.1.3 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.3 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v213_variantCollapsedBanner, thinkingRendererSearchPattern_v213_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v213,
    plannedStep: 'v2.1.3 thinking renderer',
    alreadyLabel: 'v2.1.3 thinking renderer',
    replaceLabels: ['v2.1.3 thinking renderer (collapsed banner)', 'v2.1.3 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.3 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v214,
    replacementPattern: redactedThinkingCallsiteReplacement_v214,
    plannedStep: 'v2.1.4 redacted_thinking call site',
    alreadyLabel: 'v2.1.4 redacted_thinking call site',
    replaceLabel: 'v2.1.4 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.4 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v214_variantCollapsedBanner, thinkingRendererSearchPattern_v214_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v214,
    plannedStep: 'v2.1.4 thinking renderer',
    alreadyLabel: 'v2.1.4 thinking renderer',
    replaceLabels: ['v2.1.4 thinking renderer (collapsed banner)', 'v2.1.4 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.4 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v216,
    replacementPattern: redactedThinkingCallsiteReplacement_v216,
    plannedStep: 'v2.1.6 redacted_thinking call site',
    alreadyLabel: 'v2.1.6 redacted_thinking call site',
    replaceLabel: 'v2.1.6 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.6 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v216,
    replacementPattern: thinkingCallsiteReplacement_v216,
    plannedStep: 'v2.1.6 thinking call site',
    alreadyLabel: 'v2.1.6 thinking call site',
    replaceLabel: 'v2.1.6 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.6 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v216_variantCollapsedBanner, thinkingRendererSearchPattern_v216_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v216,
    plannedStep: 'v2.1.6 thinking renderer',
    alreadyLabel: 'v2.1.6 thinking renderer',
    replaceLabels: ['v2.1.6 thinking renderer (collapsed banner)', 'v2.1.6 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.6 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v217,
    replacementPattern: redactedThinkingCallsiteReplacement_v217,
    plannedStep: 'v2.1.7 redacted_thinking call site',
    alreadyLabel: 'v2.1.7 redacted_thinking call site',
    replaceLabel: 'v2.1.7 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.7 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v217,
    replacementPattern: thinkingCallsiteReplacement_v217,
    plannedStep: 'v2.1.7 thinking call site',
    alreadyLabel: 'v2.1.7 thinking call site',
    replaceLabel: 'v2.1.7 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.7 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v217_variantCollapsedBanner, thinkingRendererSearchPattern_v217_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v217,
    plannedStep: 'v2.1.7 thinking renderer',
    alreadyLabel: 'v2.1.7 thinking renderer',
    replaceLabels: ['v2.1.7 thinking renderer (collapsed banner)', 'v2.1.7 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.7 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v219,
    replacementPattern: redactedThinkingCallsiteReplacement_v219,
    plannedStep: 'v2.1.9 redacted_thinking call site',
    alreadyLabel: 'v2.1.9 redacted_thinking call site',
    replaceLabel: 'v2.1.9 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.9 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v219,
    replacementPattern: thinkingCallsiteReplacement_v219,
    plannedStep: 'v2.1.9 thinking call site',
    alreadyLabel: 'v2.1.9 thinking call site',
    replaceLabel: 'v2.1.9 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.9 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v219_variantCollapsedBanner, thinkingRendererSearchPattern_v219_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v219,
    plannedStep: 'v2.1.9 thinking renderer',
    alreadyLabel: 'v2.1.9 thinking renderer',
    replaceLabels: ['v2.1.9 thinking renderer (collapsed banner)', 'v2.1.9 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.9 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v21111,
    replacementPattern: redactedThinkingCallsiteReplacement_v21111,
    plannedStep: 'v2.1.11 redacted_thinking call site',
    alreadyLabel: 'v2.1.11 redacted_thinking call site',
    replaceLabel: 'v2.1.11 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.11 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v21111,
    replacementPattern: thinkingCallsiteReplacement_v21111,
    plannedStep: 'v2.1.11 thinking call site',
    alreadyLabel: 'v2.1.11 thinking call site',
    replaceLabel: 'v2.1.11 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.11 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v21111_variantCollapsedBanner, thinkingRendererSearchPattern_v21111_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v21111,
    plannedStep: 'v2.1.11 thinking renderer',
    alreadyLabel: 'v2.1.11 thinking renderer',
    replaceLabels: ['v2.1.11 thinking renderer (collapsed banner)', 'v2.1.11 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.11 thinking renderer)',
  },
  {
    kind: 'exact',
    searchPattern: redactedThinkingCallsiteSearchPattern_v21112,
    replacementPattern: redactedThinkingCallsiteReplacement_v21112,
    plannedStep: 'v2.1.12 redacted_thinking call site',
    alreadyLabel: 'v2.1.12 redacted_thinking call site',
    replaceLabel: 'v2.1.12 redacted_thinking call site',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.12 call site)',
  },
  {
    kind: 'exact',
    searchPattern: thinkingCallsiteSearchPattern_v21112,
    replacementPattern: thinkingCallsiteReplacement_v21112,
    plannedStep: 'v2.1.12 thinking call site',
    alreadyLabel: 'v2.1.12 thinking call site',
    replaceLabel: 'v2.1.12 thinking call site',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.12 call site)',
  },
  {
    kind: 'any',
    searchPatterns: [thinkingRendererSearchPattern_v21112_variantCollapsedBanner, thinkingRendererSearchPattern_v21112_variantNullGate],
    replacementPattern: thinkingRendererReplacement_v21112,
    plannedStep: 'v2.1.12 thinking renderer',
    alreadyLabel: 'v2.1.12 thinking renderer',
    replaceLabels: ['v2.1.12 thinking renderer (collapsed banner)', 'v2.1.12 thinking renderer (null gate)'],
    successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.12 thinking renderer)',
  },
];

function detectLegacyExactPatchRule(rule) {
  if (rule.kind === 'any') {
    detectAnyExactPatchState(rule.searchPatterns, rule.replacementPattern, rule.plannedStep, rule.alreadyLabel);
    return;
  }

  detectExactPatchState(rule.searchPattern, rule.replacementPattern, rule.plannedStep, rule.alreadyLabel);
}

function applyLegacyExactPatchRule(rule) {
  if (rule.kind === 'any') {
    applyAnyExactPatch(rule.searchPatterns, rule.replacementPattern, rule.replaceLabels, rule.successMessage);
    return;
  }

  applyExactPatch(rule.searchPattern, rule.replacementPattern, rule.replaceLabel, rule.successMessage);
}

const jsHybridPatchRules = [
  {
    version: '2.1.14',
    regexFn: applyRegexPatches_v21114,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21114,
        replacementPattern: redactedThinkingCallsiteReplacement_v21114,
        plannedStep: 'v2.1.14 redacted_thinking call site',
        alreadyLabel: 'v2.1.14 redacted_thinking call site',
        regexStepNames: ['v2.1.14 redacted_thinking call site (regex)'],
        regexPlannedStep: 'v2.1.14 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21114,
        replacementPattern: thinkingCallsiteReplacement_v21114,
        plannedStep: 'v2.1.14 thinking call site',
        alreadyLabel: 'v2.1.14 thinking call site',
        regexStepNames: ['v2.1.14 thinking call site (regex)'],
        regexPlannedStep: 'v2.1.14 thinking call site (regex)',
      },
      {
        kind: 'any',
        searchPatterns: [
          thinkingRendererSearchPattern_v21114_variantCollapsedBanner,
          thinkingRendererSearchPattern_v21114_variantNullGate,
        ],
        replacementPattern: thinkingRendererReplacement_v21114,
        plannedStep: 'v2.1.14 thinking renderer',
        alreadyLabel: 'v2.1.14 thinking renderer',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21114,
        replacementPattern: redactedThinkingCallsiteReplacement_v21114,
        replaceLabel: 'v2.1.14 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.14 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21114,
        replacementPattern: thinkingCallsiteReplacement_v21114,
        replaceLabel: 'v2.1.14 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.14 call site)',
      },
      {
        kind: 'any',
        searchPatterns: [
          thinkingRendererSearchPattern_v21114_variantCollapsedBanner,
          thinkingRendererSearchPattern_v21114_variantNullGate,
        ],
        replacementPattern: thinkingRendererReplacement_v21114,
        replaceLabels: ['v2.1.14 thinking renderer (collapsed banner)', 'v2.1.14 thinking renderer (null gate)'],
        successMessage: '✅ Patch 2 applied: thinking content forced visible (v2.1.14 thinking renderer)',
      },
    ],
  },
  {
    version: '2.1.15',
    regexFn: applyRegexPatches_v21115,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21115,
        replacementPattern: redactedThinkingCallsiteReplacement_v21115,
        plannedStep: 'v2.1.15 redacted_thinking call site',
        alreadyLabel: 'v2.1.15 redacted_thinking call site',
        regexStepNames: ['v2.1.15 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.15 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21115,
        replacementPattern: thinkingCallsiteReplacement_v21115,
        plannedStep: 'v2.1.15 thinking call site',
        alreadyLabel: 'v2.1.15 thinking call site',
        regexStepNames: ['v2.1.15 thinking call site gate (regex)', 'v2.1.15 thinking call site args (regex)'],
        regexPlannedStep: 'v2.1.15 thinking call site (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21115,
        replacementPattern: redactedThinkingCallsiteReplacement_v21115,
        replaceLabel: 'v2.1.15 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.15 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21115,
        replacementPattern: thinkingCallsiteReplacement_v21115,
        replaceLabel: 'v2.1.15 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.15 call site)',
      },
    ],
  },
  {
    version: '2.1.17',
    regexFn: applyRegexPatches_v21117,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21117,
        replacementPattern: redactedThinkingCallsiteReplacement_v21117,
        plannedStep: 'v2.1.17 redacted_thinking call site',
        alreadyLabel: 'v2.1.17 redacted_thinking call site',
        regexStepNames: ['v2.1.17 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.17 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21117,
        replacementPattern: thinkingCallsiteReplacement_v21117,
        plannedStep: 'v2.1.17 thinking call site',
        alreadyLabel: 'v2.1.17 thinking call site',
        regexStepNames: ['v2.1.17 thinking call site gate (regex)', 'v2.1.17 thinking call site args (regex)'],
        regexPlannedStep: 'v2.1.17 thinking call site (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21117,
        replacementPattern: redactedThinkingCallsiteReplacement_v21117,
        replaceLabel: 'v2.1.17 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.17 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21117,
        replacementPattern: thinkingCallsiteReplacement_v21117,
        replaceLabel: 'v2.1.17 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.17 call site)',
      },
    ],
  },
  {
    version: '2.1.19',
    regexFn: applyRegexPatches_v21119,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21119,
        replacementPattern: redactedThinkingCallsiteReplacement_v21119,
        plannedStep: 'v2.1.19 redacted_thinking call site',
        alreadyLabel: 'v2.1.19 redacted_thinking call site',
        regexStepNames: ['v2.1.19 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.19 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21119,
        replacementPattern: thinkingCallsiteReplacement_v21119,
        plannedStep: 'v2.1.19 thinking call site',
        alreadyLabel: 'v2.1.19 thinking call site',
        regexStepNames: ['v2.1.19 thinking call site gate (regex)', 'v2.1.19 thinking call site args (regex)'],
        regexPlannedStep: 'v2.1.19 thinking call site (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21119,
        replacementPattern: redactedThinkingCallsiteReplacement_v21119,
        replaceLabel: 'v2.1.19 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.19 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21119,
        replacementPattern: thinkingCallsiteReplacement_v21119,
        replaceLabel: 'v2.1.19 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.19 call site)',
      },
    ],
  },
  {
    version: '2.1.20',
    regexFn: applyRegexPatches_v21120,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21120,
        replacementPattern: redactedThinkingCallsiteReplacement_v21120,
        plannedStep: 'v2.1.20 redacted_thinking call site',
        alreadyLabel: 'v2.1.20 redacted_thinking call site',
        regexStepNames: ['v2.1.20 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.20 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21120,
        replacementPattern: thinkingCallsiteReplacement_v21120,
        plannedStep: 'v2.1.20 thinking call site',
        alreadyLabel: 'v2.1.20 thinking call site',
        regexStepNames: ['v2.1.20 thinking visibility (regex)'],
        regexPlannedStep: 'v2.1.20 thinking visibility (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21120,
        replacementPattern: redactedThinkingCallsiteReplacement_v21120,
        replaceLabel: 'v2.1.20 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.20 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21120,
        replacementPattern: thinkingCallsiteReplacement_v21120,
        replaceLabel: 'v2.1.20 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.20 call site)',
      },
    ],
  },
  {
    version: '2.1.22',
    regexFn: applyRegexPatches_v21122,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21122,
        replacementPattern: redactedThinkingCallsiteReplacement_v21122,
        plannedStep: 'v2.1.22 redacted_thinking call site',
        alreadyLabel: 'v2.1.22 redacted_thinking call site',
        regexStepNames: ['v2.1.22 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.22 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21122,
        replacementPattern: thinkingCallsiteReplacement_v21122,
        plannedStep: 'v2.1.22 thinking call site',
        alreadyLabel: 'v2.1.22 thinking call site',
        regexStepNames: ['v2.1.22 thinking visibility (regex)'],
        regexPlannedStep: 'v2.1.22 thinking visibility (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21122,
        replacementPattern: redactedThinkingCallsiteReplacement_v21122,
        replaceLabel: 'v2.1.22 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.22 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21122,
        replacementPattern: thinkingCallsiteReplacement_v21122,
        replaceLabel: 'v2.1.22 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.22 call site)',
      },
    ],
  },
  {
    version: '2.1.23',
    regexFn: applyRegexPatches_v21123,
    detectEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21123,
        replacementPattern: redactedThinkingCallsiteReplacement_v21123,
        plannedStep: 'v2.1.23 redacted_thinking call site',
        alreadyLabel: 'v2.1.23 redacted_thinking call site',
        regexStepNames: ['v2.1.23 redacted_thinking call site gate (regex)'],
        regexPlannedStep: 'v2.1.23 redacted_thinking call site (regex)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21123,
        replacementPattern: thinkingCallsiteReplacement_v21123,
        plannedStep: 'v2.1.23 thinking call site',
        alreadyLabel: 'v2.1.23 thinking call site',
        regexStepNames: ['v2.1.23 thinking visibility (regex)'],
        regexPlannedStep: 'v2.1.23 thinking visibility (regex)',
      },
    ],
    applyEntries: [
      {
        kind: 'exact',
        searchPattern: redactedThinkingCallsiteSearchPattern_v21123,
        replacementPattern: redactedThinkingCallsiteReplacement_v21123,
        replaceLabel: 'v2.1.23 redacted_thinking call site',
        successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.23 call site)',
      },
      {
        kind: 'exact',
        searchPattern: thinkingCallsiteSearchPattern_v21123,
        replacementPattern: thinkingCallsiteReplacement_v21123,
        replaceLabel: 'v2.1.23 thinking call site',
        successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.23 call site)',
      },
    ],
  },
];

function detectJsHybridPatchRule(rule) {
  for (const entry of rule.detectEntries) {
    if (entry.kind === 'any') {
      detectAnyExactPatchState(entry.searchPatterns, entry.replacementPattern, entry.plannedStep, entry.alreadyLabel);
      continue;
    }

    const state = detectExactPatchState(
      entry.searchPattern,
      entry.replacementPattern,
      entry.plannedStep,
      entry.alreadyLabel
    );
    if (state !== 'none' || !entry.regexStepNames || !entry.regexPlannedStep) continue;

    detectJsRegexStep(rule.version, rule.regexFn, entry.regexStepNames, entry.regexPlannedStep);
  }
}

function applyJsHybridPatchRule(rule) {
  for (const entry of rule.applyEntries) {
    if (entry.kind === 'any') {
      applyAnyExactPatch(entry.searchPatterns, entry.replacementPattern, entry.replaceLabels, entry.successMessage);
      continue;
    }

    applyExactPatch(entry.searchPattern, entry.replacementPattern, entry.replaceLabel, entry.successMessage);
  }

  applyJsRegexFallback(rule.version, rule.regexFn);
}

function detectStandaloneJsRegexPatches() {
  if (isNativeBinary) return;
  for (const { version, fn } of standaloneJsRegexVersionPatches) {
    const steps = getJsRegexDetectSteps(version, fn);
    markPatch2DetectedSteps(steps);
  }
}

function applyStandaloneJsRegexPatches() {
  for (const { version, fn } of standaloneJsRegexVersionPatches) {
    applyJsRegexFallback(version, fn);
  }
}

const nativeExactPatchRules = [
  {
    searchPattern: redactedThinkingCallsiteSearchPattern_v21117_native,
    replacementPattern: redactedThinkingCallsiteReplacement_v21117_native,
    plannedStep: 'v2.1.17 redacted_thinking call site (native)',
    alreadyLabel: 'v2.1.17 redacted_thinking call site (native)',
    replaceLabel: 'v2.1.17 redacted_thinking call site (native)',
    successMessage: '✅ Patch 2 applied: redacted_thinking forced visible (v2.1.17 native call site)',
  },
  {
    searchPattern: thinkingCallsiteSearchPattern_v21117_native,
    replacementPattern: thinkingCallsiteReplacement_v21117_native,
    plannedStep: 'v2.1.17 thinking call site (native)',
    alreadyLabel: 'v2.1.17 thinking call site (native)',
    replaceLabel: 'v2.1.17 thinking call site (native)',
    successMessage: '✅ Patch 2 applied: thinking forced visible (v2.1.17 native call site)',
  },
];

function collectReplacementPatternsFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => entry?.replacementPattern)
    .filter(pattern => typeof pattern === 'string' && pattern.length > 0);
}

const patch2KnownReplacementPatterns = Array.from(
  new Set([
    ...collectReplacementPatternsFromEntries(legacyExactPatchRules),
    ...jsHybridPatchRules.flatMap(rule => collectReplacementPatternsFromEntries(rule.applyEntries)),
    ...collectReplacementPatternsFromEntries(nativeExactPatchRules),
  ])
);

function detectNativeExactPatchRule(rule) {
  if (!isNativeBinary) return;
  detectExactPatchState(rule.searchPattern, rule.replacementPattern, rule.plannedStep, rule.alreadyLabel);
}

function applyNativeExactPatchRule(rule) {
  while (isNativeBinary && content.includes(rule.searchPattern)) {
    content = replaceOnceExact(content, rule.searchPattern, rule.replacementPattern, rule.replaceLabel);
    console.log(rule.successMessage);
  }
}

function getMatchedNativeRegexPatch() {
  return nativeRegexVersionPatches.find(({ version }) => hasVersionTag(version));
}

// Check if patches can be applied
console.log('Checking patches...\n');

console.log('Patch 1: collapsed thinking banner removal (older versions)');
if (content.includes(bannerSearchPattern_v2062)) {
  patch1Applied = true;
  console.log('  ✅ Pattern found (v2.0.62) - ready to apply');
} else if (content.includes(bannerReplacement_v2062)) {
  patch1AlreadyApplied = true;
  console.log('  ⚠️  Already applied');
} else {
  console.log('  ℹ️  Not applicable / pattern not found');
}

console.log('\nPatch 2: thinking visibility');
for (const rule of legacyExactPatchRules) {
  detectLegacyExactPatchRule(rule);
}

for (const rule of jsHybridPatchRules) {
  detectJsHybridPatchRule(rule);
}

// Version-scoped JS regex detection for versions that only use regex-style matching.
detectStandaloneJsRegexPatches();

for (const rule of nativeExactPatchRules) {
  detectNativeExactPatchRule(rule);
}

// Version-scoped native/binary regex detection (tweakcc-style unified patch).
// This improves robustness for bun-packed native binaries whose identifiers differ from npm builds.
// Only used when no exact-string patterns matched.
if (isNativeBinary && patch2PlannedSteps.length === 0) {
  const matchedNativeRegexPatch = getMatchedNativeRegexPatch();
  if (matchedNativeRegexPatch) {
    const { steps } = matchedNativeRegexPatch.fn(content);
    markPatch2DetectedSteps(steps);
  }
}

// Lightweight native/binary regex fallback (for versions whose identifiers differ).
// Only used when no exact-string patterns matched.
if (isNativeBinary && patch2PlannedSteps.length === 0) {
  const nativeSteps = detectNativeRegexPatches(content);
  markPatch2DetectedSteps(nativeSteps);
}

if (patch2PlannedSteps.length > 0) {
  console.log(`  ✅ Pattern found (${patch2PlannedSteps.join(', ')}) - ready to apply`);
} else {
  patch2AlreadyApplied =
    patch2KnownReplacementPatterns.some(pattern => content.includes(pattern)) ||
    (isNativeBinary && detectNativeAlreadyPatched(content)) ||
    (!isNativeBinary && detectJsAlreadyPatched(content));

  if (patch2AlreadyApplied) {
    console.log('  ⚠️  Already applied');
  } else {
    console.log('  ❌ Pattern not found - may need update for newer version');
  }
}

// Dry run mode - just preview
if (isDryRun) {
  console.log('\n📋 DRY RUN - No changes will be made\n');
  console.log('Summary:');
  console.log(`- Patch 1 (banner): ${patch1Applied ? 'WOULD APPLY' : 'SKIP'}`);
  console.log(`- Patch 2 (visibility): ${patch2Applied ? 'WOULD APPLY' : 'SKIP'}`);

  if (patch1Applied || patch2Applied) {
    console.log('\nRun without --dry-run to apply patches.');
  }
  process.exit(0);
}

// Apply patches
function applyJsRegexFallback(version, applyFn) {
  if (isNativeBinary || !content.includes(`VERSION:"${version}"`)) return;
  const result = applyFn(content);
  if (result.steps.length === 0) return;
  content = result.out;
  for (const step of result.steps) {
    console.log(`✅ Patch 2 applied: ${step}`);
  }
}

function applyMatchedNativeRegexFallback() {
  if (!isNativeBinary) return;
  const matchedNativeRegexPatch = getMatchedNativeRegexPatch();
  if (!matchedNativeRegexPatch) return;
  const result = matchedNativeRegexPatch.fn(content);
  if (result.steps.length === 0) return;
  content = result.out;
  markPatch2DetectedSteps(result.steps);
  for (const step of result.steps) {
    console.log(`✅ Patch 2 applied: ${step}`);
  }
}

if (!patch1Applied && !patch2Applied) {
  if (patch1AlreadyApplied || patch2AlreadyApplied) {
    console.log('\n✅ Patches already applied - nothing to do.');
    process.exit(0);
  }
  console.error('\n❌ No patches to apply');
  console.error('Patches may already be applied or version may have changed.');
  console.error('Run with --dry-run to see details.');
  process.exit(1);
}

// Create backup if it doesn't exist
if (!fs.existsSync(backupPath)) {
  console.log('\nCreating backup...');
  fs.copyFileSync(targetPath, backupPath);
  console.log(`✅ Backup created: ${backupPath}`);
}

console.log('\nApplying patches...');

// Apply Patch 1
if (patch1Applied) {
  content = replaceOnceExact(content, bannerSearchPattern_v2062, bannerReplacement_v2062, 'Patch 1 v2.0.62 banner');
  console.log('✅ Patch 1 applied: ZT2 function now returns null');
}

// Apply Patch 2
if (patch2Applied) {
  for (const rule of legacyExactPatchRules) {
    applyLegacyExactPatchRule(rule);
  }

  for (const rule of jsHybridPatchRules) {
    applyJsHybridPatchRule(rule);
  }

  applyStandaloneJsRegexPatches();

  for (const rule of nativeExactPatchRules) {
    applyNativeExactPatchRule(rule);
  }

  // Version-scoped native/binary regex fallback.
  // This mirrors the tweakcc-style unified regex (remove gate + force isTranscriptMode/hideInTranscript).
  // Run before the generic native regex fallback so the logs are clearer and the match is tighter.
  applyMatchedNativeRegexFallback();

  // Lightweight native/binary regex fallback.
  // Use only when the binary still contains the short-circuit gate patterns.
  if (
    isNativeBinary &&
    (content.includes('case"thinking":{if(!') ||
      content.includes('case"thinking":if(!') ||
      content.includes('case"redacted_thinking":{if(!') ||
      content.includes('case"redacted_thinking":if(!'))
  ) {
    const result = applyNativeRegexPatches(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }
}

// Write file
console.log('\nWriting patched file...');
if (isNativeBinary && content.length !== originalContentLength) {
  console.error('\n❌ Refusing to write: native/binary install patch would change file size.');
  console.error(`Original length: ${originalContentLength}, patched length: ${content.length}`);
  console.error('This would likely corrupt the native binary. Please report this as a bug.');
  process.exit(1);
}
fs.writeFileSync(targetPath, content, fileEncoding);
console.log('✅ File written successfully\n');

adHocCodesignIfNeeded(targetPath);

console.log('Summary:');
console.log(`- Patch 1 (banner): ${patch1Applied ? 'APPLIED' : 'SKIPPED'}`);
console.log(`- Patch 2 (visibility): ${patch2Applied ? 'APPLIED' : 'SKIPPED'}`);
console.log('\n🎉 Patches applied! Please restart Claude Code for changes to take effect.');
console.log('\nTo restore original behavior, run: node patch-thinking.js --restore');
process.exit(0);
