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
    'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11, 2.1.12, 2.1.14, 2.1.15, 2.1.17, 2.1.19, 2.1.20, 2.1.22, 2.1.23, 2.1.27, 2.1.30)'
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
  'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11, 2.1.12, 2.1.14, 2.1.15, 2.1.17, 2.1.19, 2.1.20, 2.1.22, 2.1.23, 2.1.27, 2.1.30)'
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

function applyRegexPatches_v21114(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteRegex_v21114.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteRegex_v21114,
      (_m, casePrefix, returnExpr) => `${casePrefix}${returnExpr}`,
      'v2.1.14 redacted_thinking call site (regex)'
    );
    steps.push('v2.1.14 redacted_thinking call site (regex)');
  }

  if (thinkingCallsiteRegex_v21114.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteRegex_v21114,
      (_m, casePrefix, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey) => {
        return `${casePrefix}{return ${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1})}`;
      },
      'v2.1.14 thinking call site (regex)'
    );
    steps.push('v2.1.14 thinking call site (regex)');
  }

  return { out, steps };
}

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

function applyRegexPatches_v21115(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21115.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21115,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.15 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.15 redacted_thinking call site gate (regex)');
  }

  if (thinkingCallsiteGateRegex_v21115.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteGateRegex_v21115,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.15 thinking call site gate (regex)'
    );
    steps.push('v2.1.15 thinking call site gate (regex)');
  }

  if (thinkingCallsiteArgsRegex_v21115.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteArgsRegex_v21115,
      (_m, casePrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideVar, suffix) => {
        return `${casePrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`;
      },
      'v2.1.15 thinking call site args (regex)'
    );
    steps.push('v2.1.15 thinking call site args (regex)');
  }

  return { out, steps };
}

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

function applyRegexPatches_v21117(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21117.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21117,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.17 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.17 redacted_thinking call site gate (regex)');
  }

  if (thinkingCallsiteGateRegex_v21117.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteGateRegex_v21117,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.17 thinking call site gate (regex)'
    );
    steps.push('v2.1.17 thinking call site gate (regex)');
  }

  if (thinkingCallsiteArgsRegex_v21117.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteArgsRegex_v21117,
      (_m, casePrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideVar, suffix) => {
        return `${casePrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`;
      },
      'v2.1.17 thinking call site args (regex)'
    );
    steps.push('v2.1.17 thinking call site args (regex)');
  }

  return { out, steps };
}

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

function applyRegexPatches_v21119(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21119.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21119,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.19 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.19 redacted_thinking call site gate (regex)');
  }

  if (thinkingCallsiteGateRegex_v21119.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteGateRegex_v21119,
      (_m, casePrefix) => `${casePrefix}{`,
      'v2.1.19 thinking call site gate (regex)'
    );
    steps.push('v2.1.19 thinking call site gate (regex)');
  }

  if (thinkingCallsiteArgsRegex_v21119.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingCallsiteArgsRegex_v21119,
      (_m, casePrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideVar, suffix) => {
        return `${casePrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`;
      },
      'v2.1.19 thinking call site args (regex)'
    );
    steps.push('v2.1.19 thinking call site args (regex)');
  }

  return { out, steps };
}

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

function applyRegexPatches_v21120(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21120.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21120,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.20 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.20 redacted_thinking call site gate (regex)');
  }

  if (thinkingVisibilityRegex_v21120.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingVisibilityRegex_v21120,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.20 thinking visibility (regex)'
    );
    steps.push('v2.1.20 thinking visibility (regex)');
  }

  return { out, steps };
}

function applyRegexPatches_v21120_native(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyRegexPatches_v21120_native expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const gateRe = new RegExp(redactedThinkingCallsiteGateRegex_v21120.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      gateRe,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.20 redacted_thinking call site gate (native regex)'
    );
    text = out;
    if (replacedCount > 0) {
      steps.push(`v2.1.20 redacted_thinking call site gate (native regex) x${replacedCount}`);
    }
  }

  {
    const visRe = new RegExp(thinkingVisibilityRegex_v21120.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      visRe,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.20 thinking visibility (native regex)'
    );
    text = out;
    if (replacedCount > 0) steps.push(`v2.1.20 thinking visibility (native regex) x${replacedCount}`);
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

// Regex-based fallback for v2.1.22 (tweakcc-style unified patch).
// NOTE: The caller gates this on `content.includes('VERSION:"2.1.22"')`.
// 2.1.22 uses the same structural patterns as 2.1.20.
const redactedThinkingCallsiteGateRegex_v21122 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21122 = thinkingVisibilityRegex_v21120;

function applyRegexPatches_v21122(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21122.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21122,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.22 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.22 redacted_thinking call site gate (regex)');
  }

  if (thinkingVisibilityRegex_v21122.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingVisibilityRegex_v21122,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.22 thinking visibility (regex)'
    );
    steps.push('v2.1.22 thinking visibility (regex)');
  }

  return { out, steps };
}

function applyRegexPatches_v21122_native(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyRegexPatches_v21122_native expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const gateRe = new RegExp(redactedThinkingCallsiteGateRegex_v21122.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      gateRe,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.22 redacted_thinking call site gate (native regex)'
    );
    text = out;
    if (replacedCount > 0) {
      steps.push(`v2.1.22 redacted_thinking call site gate (native regex) x${replacedCount}`);
    }
  }

  {
    const visRe = new RegExp(thinkingVisibilityRegex_v21122.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      visRe,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.22 thinking visibility (native regex)'
    );
    text = out;
    if (replacedCount > 0) steps.push(`v2.1.22 thinking visibility (native regex) x${replacedCount}`);
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

// Regex-based fallback for v2.1.23 (tweakcc-style unified patch).
// NOTE: The caller gates this on `content.includes('VERSION:"2.1.23"')`.
// 2.1.23 uses the same structural patterns as 2.1.20/2.1.22.
const redactedThinkingCallsiteGateRegex_v21123 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21123 = thinkingVisibilityRegex_v21120;

function applyRegexPatches_v21123(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21123.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21123,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.23 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.23 redacted_thinking call site gate (regex)');
  }

  if (thinkingVisibilityRegex_v21123.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingVisibilityRegex_v21123,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.23 thinking visibility (regex)'
    );
    steps.push('v2.1.23 thinking visibility (regex)');
  }

  return { out, steps };
}

function applyRegexPatches_v21123_native(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyRegexPatches_v21123_native expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const gateRe = new RegExp(redactedThinkingCallsiteGateRegex_v21123.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      gateRe,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.23 redacted_thinking call site gate (native regex)'
    );
    text = out;
    if (replacedCount > 0) {
      steps.push(`v2.1.23 redacted_thinking call site gate (native regex) x${replacedCount}`);
    }
  }

  {
    const visRe = new RegExp(thinkingVisibilityRegex_v21123.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      visRe,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.23 thinking visibility (native regex)'
    );
    text = out;
    if (replacedCount > 0) steps.push(`v2.1.23 thinking visibility (native regex) x${replacedCount}`);
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

// Regex-based fallback for v2.1.27 (tweakcc-style unified patch).
// NOTE: The caller gates this on `content.includes('VERSION:"2.1.27"')`.
// 2.1.27 uses the same structural patterns as 2.1.20/2.1.22/2.1.23.
const redactedThinkingCallsiteGateRegex_v21127 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v21127 = thinkingVisibilityRegex_v21120;

function applyRegexPatches_v21127(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v21127.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v21127,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.27 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.27 redacted_thinking call site gate (regex)');
  }

  if (thinkingVisibilityRegex_v21127.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingVisibilityRegex_v21127,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.27 thinking visibility (regex)'
    );
    steps.push('v2.1.27 thinking visibility (regex)');
  }

  return { out, steps };
}

function applyRegexPatches_v21127_native(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyRegexPatches_v21127_native expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const gateRe = new RegExp(redactedThinkingCallsiteGateRegex_v21127.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      gateRe,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.27 redacted_thinking call site gate (native regex)'
    );
    text = out;
    if (replacedCount > 0) {
      steps.push(`v2.1.27 redacted_thinking call site gate (native regex) x${replacedCount}`);
    }
  }

  {
    const visRe = new RegExp(thinkingVisibilityRegex_v21127.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      visRe,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, verboseKey, verboseVar, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${verboseKey}${verboseVar}${hideKey}!1${suffix}`,
      'v2.1.27 thinking visibility (native regex)'
    );
    text = out;
    if (replacedCount > 0) steps.push(`v2.1.27 thinking visibility (native regex) x${replacedCount}`);
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

// Regex-based fallback for v2.1.30 (tweakcc-style unified patch, adjusted for 2.1.30 call site changes).
// NOTE: The caller gates this on `content.includes('VERSION:"2.1.30"')`.
// In 2.1.30 the thinking call site no longer includes `verbose:` in the createElement props.
const redactedThinkingCallsiteGateRegex_v2130 = redactedThinkingCallsiteGateRegex_v21120;
const thinkingVisibilityRegex_v2130 =
  /(case"thinking":\{?)(if\([^)]*\)return null;)([\s\S]{0,1400}?createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([^,}]+)(,hideInTranscript:)([^,}]+)(\}\))/;

function applyRegexPatches_v2130(source) {
  let out = source;
  const steps = [];

  if (redactedThinkingCallsiteGateRegex_v2130.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      redactedThinkingCallsiteGateRegex_v2130,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.30 redacted_thinking call site gate (regex)'
    );
    steps.push('v2.1.30 redacted_thinking call site gate (regex)');
  }

  if (thinkingVisibilityRegex_v2130.test(out)) {
    out = replaceRegexPreserveLength(
      out,
      thinkingVisibilityRegex_v2130,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${hideKey}!1${suffix}`,
      'v2.1.30 thinking visibility (regex)'
    );
    steps.push('v2.1.30 thinking visibility (regex)');
  }

  return { out, steps };
}

function applyRegexPatches_v2130_native(sourceBuf) {
  if (!Buffer.isBuffer(sourceBuf)) {
    throw new Error('applyRegexPatches_v2130_native expected a Buffer');
  }

  let text = sourceBuf.toString('latin1');
  const steps = [];

  {
    const gateRe = new RegExp(redactedThinkingCallsiteGateRegex_v2130.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      gateRe,
      (_m, casePrefix) => `${casePrefix}`,
      'v2.1.30 redacted_thinking call site gate (native regex)'
    );
    text = out;
    if (replacedCount > 0) {
      steps.push(`v2.1.30 redacted_thinking call site gate (native regex) x${replacedCount}`);
    }
  }

  {
    const visRe = new RegExp(thinkingVisibilityRegex_v2130.source, 'g');
    const { out, replacedCount } = replaceRegexPreserveLengthNativeString(
      text,
      visRe,
      (_m, casePrefix, _gate, createPrefix, _oldIsTranscriptMode, hideKey, _oldHideValue, suffix) =>
        `${casePrefix}${createPrefix}!0${hideKey}!1${suffix}`,
      'v2.1.30 thinking visibility (native regex)'
    );
    text = out;
    if (replacedCount > 0) steps.push(`v2.1.30 thinking visibility (native regex) x${replacedCount}`);
  }

  const outBuf = Buffer.from(text, 'latin1');
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(
      `Refusing to patch native/binary: size changed (${sourceBuf.length} -> ${outBuf.length}).`
    );
  }
  return { out: outBuf, steps };
}

let patch1Applied = false;
let patch2Applied = false;
let patch1AlreadyApplied = false;
let patch2AlreadyApplied = false;
const patch2PlannedSteps = [];

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
if (content.includes(thinkingSearchPattern_v2062)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.62 call site');
} else if (content.includes(thinkingReplacement_v2062)) {
  console.log('  ⚠️  Already applied (v2.0.62 call site)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v2074)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.74 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v2074)) {
  console.log('  ⚠️  Already applied (v2.0.74 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v2074)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.74 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v2074)) {
  console.log('  ⚠️  Already applied (v2.0.74 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v2074_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v2074_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.74 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v2074)) {
  console.log('  ⚠️  Already applied (v2.0.74 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v2076)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.76 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v2076)) {
  console.log('  ⚠️  Already applied (v2.0.76 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v2076)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.76 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v2076)) {
  console.log('  ⚠️  Already applied (v2.0.76 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v2076_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v2076_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.76 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v2076)) {
  console.log('  ⚠️  Already applied (v2.0.76 thinking renderer)');
}

if (
  content.includes(thinkingRendererSearchPattern_v2071_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v2071_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.0.71 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v2071)) {
  console.log('  ⚠️  Already applied (v2.0.71 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v2111)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.1 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v2111)) {
  console.log('  ⚠️  Already applied (v2.1.1 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v2111)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.1 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v2111)) {
  console.log('  ⚠️  Already applied (v2.1.1 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v2111_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v2111_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.1 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v2111)) {
  console.log('  ⚠️  Already applied (v2.1.1 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v212)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.2 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v212)) {
  console.log('  ⚠️  Already applied (v2.1.2 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v212)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.2 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v212)) {
  console.log('  ⚠️  Already applied (v2.1.2 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v212_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v212_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.2 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v212)) {
  console.log('  ⚠️  Already applied (v2.1.2 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v213)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.3 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v213)) {
  console.log('  ⚠️  Already applied (v2.1.3 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v213)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.3 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v213)) {
  console.log('  ⚠️  Already applied (v2.1.3 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v213_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v213_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.3 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v213)) {
  console.log('  ⚠️  Already applied (v2.1.3 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v214)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.4 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v214)) {
  console.log('  ⚠️  Already applied (v2.1.4 redacted_thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v214_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v214_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.4 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v214)) {
  console.log('  ⚠️  Already applied (v2.1.4 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v216)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.6 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v216)) {
  console.log('  ⚠️  Already applied (v2.1.6 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v216)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.6 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v216)) {
  console.log('  ⚠️  Already applied (v2.1.6 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v216_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v216_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.6 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v216)) {
  console.log('  ⚠️  Already applied (v2.1.6 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v217)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.7 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v217)) {
  console.log('  ⚠️  Already applied (v2.1.7 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v217)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.7 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v217)) {
  console.log('  ⚠️  Already applied (v2.1.7 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v217_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v217_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.7 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v217)) {
  console.log('  ⚠️  Already applied (v2.1.7 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v219)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.9 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v219)) {
  console.log('  ⚠️  Already applied (v2.1.9 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v219)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.9 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v219)) {
  console.log('  ⚠️  Already applied (v2.1.9 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v219_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v219_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.9 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v219)) {
  console.log('  ⚠️  Already applied (v2.1.9 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21111)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.11 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21111)) {
  console.log('  ⚠️  Already applied (v2.1.11 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v21111)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.11 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21111)) {
  console.log('  ⚠️  Already applied (v2.1.11 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v21111_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v21111_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.11 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v21111)) {
  console.log('  ⚠️  Already applied (v2.1.11 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21112)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.12 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21112)) {
  console.log('  ⚠️  Already applied (v2.1.12 redacted_thinking call site)');
}

if (content.includes(thinkingCallsiteSearchPattern_v21112)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.12 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21112)) {
  console.log('  ⚠️  Already applied (v2.1.12 thinking call site)');
}

if (
  content.includes(thinkingRendererSearchPattern_v21112_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v21112_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.12 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v21112)) {
  console.log('  ⚠️  Already applied (v2.1.12 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21114)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.14 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21114)) {
  console.log('  ⚠️  Already applied (v2.1.14 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.14"')) {
  const { steps } = applyRegexPatches_v21114(content);
  if (steps.includes('v2.1.14 redacted_thinking call site (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.14 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21114)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.14 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21114)) {
  console.log('  ⚠️  Already applied (v2.1.14 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.14"')) {
  const { steps } = applyRegexPatches_v21114(content);
  if (steps.includes('v2.1.14 thinking call site (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.14 thinking call site (regex)');
  }
}

if (
  content.includes(thinkingRendererSearchPattern_v21114_variantCollapsedBanner) ||
  content.includes(thinkingRendererSearchPattern_v21114_variantNullGate)
) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.14 thinking renderer');
} else if (content.includes(thinkingRendererReplacement_v21114)) {
  console.log('  ⚠️  Already applied (v2.1.14 thinking renderer)');
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21115)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.15 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21115)) {
  console.log('  ⚠️  Already applied (v2.1.15 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.15"')) {
  const { steps } = applyRegexPatches_v21115(content);
  if (steps.includes('v2.1.15 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.15 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21115)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.15 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21115)) {
  console.log('  ⚠️  Already applied (v2.1.15 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.15"')) {
  const { steps } = applyRegexPatches_v21115(content);
  if (
    steps.includes('v2.1.15 thinking call site gate (regex)') ||
    steps.includes('v2.1.15 thinking call site args (regex)')
  ) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.15 thinking call site (regex)');
  }
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21117)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.17 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21117)) {
  console.log('  ⚠️  Already applied (v2.1.17 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.17"')) {
  const { steps } = applyRegexPatches_v21117(content);
  if (steps.includes('v2.1.17 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.17 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21117)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.17 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21117)) {
  console.log('  ⚠️  Already applied (v2.1.17 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.17"')) {
  const { steps } = applyRegexPatches_v21117(content);
  if (
    steps.includes('v2.1.17 thinking call site gate (regex)') ||
    steps.includes('v2.1.17 thinking call site args (regex)')
  ) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.17 thinking call site (regex)');
  }
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21119)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.19 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21119)) {
  console.log('  ⚠️  Already applied (v2.1.19 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.19"')) {
  const { steps } = applyRegexPatches_v21119(content);
  if (steps.includes('v2.1.19 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.19 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21119)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.19 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21119)) {
  console.log('  ⚠️  Already applied (v2.1.19 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.19"')) {
  const { steps } = applyRegexPatches_v21119(content);
  if (
    steps.includes('v2.1.19 thinking call site gate (regex)') ||
    steps.includes('v2.1.19 thinking call site args (regex)')
  ) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.19 thinking call site (regex)');
  }
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21120)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.20 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21120)) {
  console.log('  ⚠️  Already applied (v2.1.20 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.20"')) {
  const { steps } = applyRegexPatches_v21120(content);
  if (steps.includes('v2.1.20 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.20 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21120)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.20 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21120)) {
  console.log('  ⚠️  Already applied (v2.1.20 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.20"')) {
  const { steps } = applyRegexPatches_v21120(content);
  if (
    steps.includes('v2.1.20 thinking visibility (regex)')
  ) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.20 thinking visibility (regex)');
  }
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21122)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.22 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21122)) {
  console.log('  ⚠️  Already applied (v2.1.22 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.22"')) {
  const { steps } = applyRegexPatches_v21122(content);
  if (steps.includes('v2.1.22 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.22 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21122)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.22 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21122)) {
  console.log('  ⚠️  Already applied (v2.1.22 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.22"')) {
  const { steps } = applyRegexPatches_v21122(content);
  if (steps.includes('v2.1.22 thinking visibility (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.22 thinking visibility (regex)');
  }
}

if (content.includes(redactedThinkingCallsiteSearchPattern_v21123)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.23 redacted_thinking call site');
} else if (content.includes(redactedThinkingCallsiteReplacement_v21123)) {
  console.log('  ⚠️  Already applied (v2.1.23 redacted_thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.23"')) {
  const { steps } = applyRegexPatches_v21123(content);
  if (steps.includes('v2.1.23 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.23 redacted_thinking call site (regex)');
  }
}

if (content.includes(thinkingCallsiteSearchPattern_v21123)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.23 thinking call site');
} else if (content.includes(thinkingCallsiteReplacement_v21123)) {
  console.log('  ⚠️  Already applied (v2.1.23 thinking call site)');
} else if (!isNativeBinary && content.includes('VERSION:"2.1.23"')) {
  const { steps } = applyRegexPatches_v21123(content);
  if (steps.includes('v2.1.23 thinking visibility (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.23 thinking visibility (regex)');
  }
}

// v2.1.27: identifiers changed again, but the structural regex still matches.
if (!isNativeBinary && content.includes('VERSION:"2.1.27"')) {
  const { steps } = applyRegexPatches_v21127(content);
  if (steps.includes('v2.1.27 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.27 redacted_thinking call site (regex)');
  }
  if (steps.includes('v2.1.27 thinking visibility (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.27 thinking visibility (regex)');
  }
}

// v2.1.30: call site changed (no `verbose:` prop), so we use a dedicated version-scoped regex.
if (!isNativeBinary && content.includes('VERSION:"2.1.30"')) {
  const { steps } = applyRegexPatches_v2130(content);
  if (steps.includes('v2.1.30 redacted_thinking call site gate (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.30 redacted_thinking call site (regex)');
  }
  if (steps.includes('v2.1.30 thinking visibility (regex)')) {
    patch2Applied = true;
    patch2PlannedSteps.push('v2.1.30 thinking visibility (regex)');
  }
}

// Native/binary detection for v2.1.17 (exact-string only; regex not supported for native).
if (isNativeBinary && content.includes(redactedThinkingCallsiteSearchPattern_v21117_native)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.17 redacted_thinking call site (native)');
} else if (isNativeBinary && content.includes(redactedThinkingCallsiteReplacement_v21117_native)) {
  console.log('  ⚠️  Already applied (v2.1.17 redacted_thinking call site (native))');
}

if (isNativeBinary && content.includes(thinkingCallsiteSearchPattern_v21117_native)) {
  patch2Applied = true;
  patch2PlannedSteps.push('v2.1.17 thinking call site (native)');
} else if (isNativeBinary && content.includes(thinkingCallsiteReplacement_v21117_native)) {
  console.log('  ⚠️  Already applied (v2.1.17 thinking call site (native))');
}

// Version-scoped native/binary regex detection (tweakcc-style unified patch).
// This improves robustness for bun-packed native binaries whose identifiers differ from npm builds.
// Only used when no exact-string patterns matched.
if (isNativeBinary && patch2PlannedSteps.length === 0) {
  if (content.includes('VERSION:"2.1.20"')) {
    const { steps } = applyRegexPatches_v21120_native(content);
    if (steps.length > 0) {
      patch2Applied = true;
      patch2PlannedSteps.push(...steps);
    }
  } else if (content.includes('VERSION:"2.1.22"')) {
    const { steps } = applyRegexPatches_v21122_native(content);
    if (steps.length > 0) {
      patch2Applied = true;
      patch2PlannedSteps.push(...steps);
    }
  } else if (content.includes('VERSION:"2.1.23"')) {
    const { steps } = applyRegexPatches_v21123_native(content);
    if (steps.length > 0) {
      patch2Applied = true;
      patch2PlannedSteps.push(...steps);
    }
  } else if (content.includes('VERSION:"2.1.27"')) {
    const { steps } = applyRegexPatches_v21127_native(content);
    if (steps.length > 0) {
      patch2Applied = true;
      patch2PlannedSteps.push(...steps);
    }
  } else if (content.includes('VERSION:"2.1.30"')) {
    const { steps } = applyRegexPatches_v2130_native(content);
    if (steps.length > 0) {
      patch2Applied = true;
      patch2PlannedSteps.push(...steps);
    }
  }
}

// Lightweight native/binary regex fallback (for versions whose identifiers differ).
// Only used when no exact-string patterns matched.
if (isNativeBinary && patch2PlannedSteps.length === 0) {
  const nativeSteps = detectNativeRegexPatches(content);
  if (nativeSteps.length > 0) {
    patch2Applied = true;
    patch2PlannedSteps.push(...nativeSteps);
  }
}

if (patch2PlannedSteps.length > 0) {
  console.log(`  ✅ Pattern found (${patch2PlannedSteps.join(', ')}) - ready to apply`);
} else {
  patch2AlreadyApplied =
    content.includes(thinkingReplacement_v2062) ||
    content.includes(redactedThinkingCallsiteReplacement_v2074) ||
    content.includes(thinkingCallsiteReplacement_v2074) ||
    content.includes(thinkingRendererReplacement_v2074) ||
    content.includes(redactedThinkingCallsiteReplacement_v2076) ||
    content.includes(thinkingCallsiteReplacement_v2076) ||
    content.includes(thinkingRendererReplacement_v2076) ||
    content.includes(thinkingRendererReplacement_v2071) ||
    content.includes(redactedThinkingCallsiteReplacement_v2111) ||
    content.includes(thinkingCallsiteReplacement_v2111) ||
    content.includes(thinkingRendererReplacement_v2111) ||
    content.includes(redactedThinkingCallsiteReplacement_v212) ||
    content.includes(thinkingCallsiteReplacement_v212) ||
    content.includes(thinkingRendererReplacement_v212) ||
    content.includes(redactedThinkingCallsiteReplacement_v213) ||
    content.includes(thinkingCallsiteReplacement_v213) ||
    content.includes(thinkingRendererReplacement_v213) ||
    content.includes(redactedThinkingCallsiteReplacement_v214) ||
    content.includes(thinkingRendererReplacement_v214) ||
    content.includes(redactedThinkingCallsiteReplacement_v216) ||
    content.includes(thinkingCallsiteReplacement_v216) ||
    content.includes(thinkingRendererReplacement_v216) ||
    content.includes(redactedThinkingCallsiteReplacement_v217) ||
    content.includes(thinkingCallsiteReplacement_v217) ||
    content.includes(thinkingRendererReplacement_v217) ||
    content.includes(redactedThinkingCallsiteReplacement_v219) ||
    content.includes(thinkingCallsiteReplacement_v219) ||
    content.includes(thinkingRendererReplacement_v219) ||
    content.includes(redactedThinkingCallsiteReplacement_v21111) ||
    content.includes(thinkingCallsiteReplacement_v21111) ||
    content.includes(thinkingRendererReplacement_v21111) ||
    content.includes(redactedThinkingCallsiteReplacement_v21112) ||
    content.includes(thinkingCallsiteReplacement_v21112) ||
    content.includes(thinkingRendererReplacement_v21112) ||
    content.includes(redactedThinkingCallsiteReplacement_v21114) ||
    content.includes(thinkingCallsiteReplacement_v21114) ||
    content.includes(thinkingRendererReplacement_v21114) ||
    content.includes(redactedThinkingCallsiteReplacement_v21115) ||
	    content.includes(thinkingCallsiteReplacement_v21115) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21117) ||
	    content.includes(thinkingCallsiteReplacement_v21117) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21119) ||
	    content.includes(thinkingCallsiteReplacement_v21119) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21120) ||
	    content.includes(thinkingCallsiteReplacement_v21120) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21122) ||
	    content.includes(thinkingCallsiteReplacement_v21122) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21123) ||
	    content.includes(thinkingCallsiteReplacement_v21123) ||
	    content.includes(redactedThinkingCallsiteReplacement_v21117_native) ||
	    content.includes(thinkingCallsiteReplacement_v21117_native) ||
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
  if (content.includes(thinkingSearchPattern_v2062)) {
    content = replaceOnceExact(content, thinkingSearchPattern_v2062, thinkingReplacement_v2062, 'v2.0.62 thinking call site');
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.62 call site)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2074)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v2074,
      redactedThinkingCallsiteReplacement_v2074,
      'v2.0.74 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.0.74 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2074)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v2074,
      thinkingCallsiteReplacement_v2074,
      'v2.0.74 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.0.74 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2074_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2074_variantCollapsedBanner,
      thinkingRendererReplacement_v2074,
      'v2.0.74 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.74 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2074_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2074_variantNullGate,
      thinkingRendererReplacement_v2074,
      'v2.0.74 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.74 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2076)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v2076,
      redactedThinkingCallsiteReplacement_v2076,
      'v2.0.76 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.0.76 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2076)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v2076,
      thinkingCallsiteReplacement_v2076,
      'v2.0.76 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.0.76 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2076_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2076_variantCollapsedBanner,
      thinkingRendererReplacement_v2076,
      'v2.0.76 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.76 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2076_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2076_variantNullGate,
      thinkingRendererReplacement_v2076,
      'v2.0.76 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.76 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2071_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2071_variantCollapsedBanner,
      thinkingRendererReplacement_v2071,
      'v2.0.71 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.71 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2071_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2071_variantNullGate,
      thinkingRendererReplacement_v2071,
      'v2.0.71 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.71 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2111)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v2111,
      redactedThinkingCallsiteReplacement_v2111,
      'v2.1.1 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.1 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2111)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v2111,
      thinkingCallsiteReplacement_v2111,
      'v2.1.1 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.1 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2111_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2111_variantCollapsedBanner,
      thinkingRendererReplacement_v2111,
      'v2.1.1 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.1 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2111_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v2111_variantNullGate,
      thinkingRendererReplacement_v2111,
      'v2.1.1 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.1 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v212)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v212,
      redactedThinkingCallsiteReplacement_v212,
      'v2.1.2 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.2 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v212)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v212,
      thinkingCallsiteReplacement_v212,
      'v2.1.2 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.2 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v212_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v212_variantCollapsedBanner,
      thinkingRendererReplacement_v212,
      'v2.1.2 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.2 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v212_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v212_variantNullGate,
      thinkingRendererReplacement_v212,
      'v2.1.2 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.2 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v213)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v213,
      redactedThinkingCallsiteReplacement_v213,
      'v2.1.3 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.3 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v213)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v213,
      thinkingCallsiteReplacement_v213,
      'v2.1.3 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.3 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v213_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v213_variantCollapsedBanner,
      thinkingRendererReplacement_v213,
      'v2.1.3 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.3 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v213_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v213_variantNullGate,
      thinkingRendererReplacement_v213,
      'v2.1.3 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.3 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v214)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v214,
      redactedThinkingCallsiteReplacement_v214,
      'v2.1.4 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.4 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v214_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v214_variantCollapsedBanner,
      thinkingRendererReplacement_v214,
      'v2.1.4 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.4 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v214_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v214_variantNullGate,
      thinkingRendererReplacement_v214,
      'v2.1.4 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.4 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v216)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v216,
      redactedThinkingCallsiteReplacement_v216,
      'v2.1.6 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.6 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v216)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v216,
      thinkingCallsiteReplacement_v216,
      'v2.1.6 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.6 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v216_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v216_variantCollapsedBanner,
      thinkingRendererReplacement_v216,
      'v2.1.6 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.6 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v216_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v216_variantNullGate,
      thinkingRendererReplacement_v216,
      'v2.1.6 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.6 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v217)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v217,
      redactedThinkingCallsiteReplacement_v217,
      'v2.1.7 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.7 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v217)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v217,
      thinkingCallsiteReplacement_v217,
      'v2.1.7 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.7 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v217_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v217_variantCollapsedBanner,
      thinkingRendererReplacement_v217,
      'v2.1.7 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.7 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v217_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v217_variantNullGate,
      thinkingRendererReplacement_v217,
      'v2.1.7 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.7 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v219)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v219,
      redactedThinkingCallsiteReplacement_v219,
      'v2.1.9 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.9 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v219)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v219,
      thinkingCallsiteReplacement_v219,
      'v2.1.9 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.9 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v219_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v219_variantCollapsedBanner,
      thinkingRendererReplacement_v219,
      'v2.1.9 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.9 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v219_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v219_variantNullGate,
      thinkingRendererReplacement_v219,
      'v2.1.9 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.9 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21111)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21111,
      redactedThinkingCallsiteReplacement_v21111,
      'v2.1.11 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.11 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21111)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21111,
      thinkingCallsiteReplacement_v21111,
      'v2.1.11 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.11 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21111_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21111_variantCollapsedBanner,
      thinkingRendererReplacement_v21111,
      'v2.1.11 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.11 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21111_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21111_variantNullGate,
      thinkingRendererReplacement_v21111,
      'v2.1.11 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.11 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21112)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21112,
      redactedThinkingCallsiteReplacement_v21112,
      'v2.1.12 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.12 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21112)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21112,
      thinkingCallsiteReplacement_v21112,
      'v2.1.12 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.12 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21112_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21112_variantCollapsedBanner,
      thinkingRendererReplacement_v21112,
      'v2.1.12 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.12 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21112_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21112_variantNullGate,
      thinkingRendererReplacement_v21112,
      'v2.1.12 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.12 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21114)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21114,
      redactedThinkingCallsiteReplacement_v21114,
      'v2.1.14 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.14 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21114)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21114,
      thinkingCallsiteReplacement_v21114,
      'v2.1.14 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.14 call site)');
  }

  // Regex fallback for v2.1.14 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.14"')) {
    const result = applyRegexPatches_v21114(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(thinkingRendererSearchPattern_v21114_variantCollapsedBanner)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21114_variantCollapsedBanner,
      thinkingRendererReplacement_v21114,
      'v2.1.14 thinking renderer (collapsed banner)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.14 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21114_variantNullGate)) {
    content = replaceOnceExact(
      content,
      thinkingRendererSearchPattern_v21114_variantNullGate,
      thinkingRendererReplacement_v21114,
      'v2.1.14 thinking renderer (null gate)'
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.14 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21115)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21115,
      redactedThinkingCallsiteReplacement_v21115,
      'v2.1.15 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.15 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21115)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21115,
      thinkingCallsiteReplacement_v21115,
      'v2.1.15 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.15 call site)');
  }

  // Regex fallback for v2.1.15 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.15"')) {
    const result = applyRegexPatches_v21115(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21117)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21117,
      redactedThinkingCallsiteReplacement_v21117,
      'v2.1.17 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.17 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21117)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21117,
      thinkingCallsiteReplacement_v21117,
      'v2.1.17 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.17 call site)');
  }

  // Regex fallback for v2.1.17 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.17"')) {
    const result = applyRegexPatches_v21117(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21119)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21119,
      redactedThinkingCallsiteReplacement_v21119,
      'v2.1.19 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.19 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21119)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21119,
      thinkingCallsiteReplacement_v21119,
      'v2.1.19 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.19 call site)');
  }

  // Regex fallback for v2.1.19 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.19"')) {
    const result = applyRegexPatches_v21119(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21120)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21120,
      redactedThinkingCallsiteReplacement_v21120,
      'v2.1.20 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.20 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21120)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21120,
      thinkingCallsiteReplacement_v21120,
      'v2.1.20 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.20 call site)');
  }

  // Regex fallback for v2.1.20 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.20"')) {
    const result = applyRegexPatches_v21120(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21122)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21122,
      redactedThinkingCallsiteReplacement_v21122,
      'v2.1.22 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.22 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21122)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21122,
      thinkingCallsiteReplacement_v21122,
      'v2.1.22 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.22 call site)');
  }

  // Regex fallback for v2.1.22 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.22"')) {
    const result = applyRegexPatches_v21122(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21123)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21123,
      redactedThinkingCallsiteReplacement_v21123,
      'v2.1.23 redacted_thinking call site'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.23 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21123)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21123,
      thinkingCallsiteReplacement_v21123,
      'v2.1.23 thinking call site'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.23 call site)');
  }

  // Regex fallback for v2.1.23 call sites (only when exact patterns fail).
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.23"')) {
    const result = applyRegexPatches_v21123(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Regex fallback for v2.1.27 call sites.
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.27"')) {
    const result = applyRegexPatches_v21127(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Regex fallback for v2.1.30 call sites.
  // Run after the exact-string replacements so we don't double-apply.
  if (!isNativeBinary && content.includes('VERSION:"2.1.30"')) {
    const result = applyRegexPatches_v2130(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Native/binary exact-string patches for v2.1.17.
  // Apply in a loop in case the string appears more than once in the binary.
  while (isNativeBinary && content.includes(redactedThinkingCallsiteSearchPattern_v21117_native)) {
    content = replaceOnceExact(
      content,
      redactedThinkingCallsiteSearchPattern_v21117_native,
      redactedThinkingCallsiteReplacement_v21117_native,
      'v2.1.17 redacted_thinking call site (native)'
    );
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.17 native call site)');
  }

  while (isNativeBinary && content.includes(thinkingCallsiteSearchPattern_v21117_native)) {
    content = replaceOnceExact(
      content,
      thinkingCallsiteSearchPattern_v21117_native,
      thinkingCallsiteReplacement_v21117_native,
      'v2.1.17 thinking call site (native)'
    );
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.17 native call site)');
  }

  // Version-scoped native/binary regex fallback for v2.1.20.
  // This mirrors the tweakcc-style unified regex (remove gate + force isTranscriptMode/hideInTranscript).
  // Run before the generic native regex fallback so the logs are clearer and the match is tighter.
  if (isNativeBinary && content.includes('VERSION:"2.1.20"')) {
    const result = applyRegexPatches_v21120_native(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Version-scoped native/binary regex fallback for v2.1.22.
  if (isNativeBinary && content.includes('VERSION:"2.1.22"')) {
    const result = applyRegexPatches_v21122_native(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Version-scoped native/binary regex fallback for v2.1.23.
  if (isNativeBinary && content.includes('VERSION:"2.1.23"')) {
    const result = applyRegexPatches_v21123_native(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Version-scoped native/binary regex fallback for v2.1.27.
  if (isNativeBinary && content.includes('VERSION:"2.1.27"')) {
    const result = applyRegexPatches_v21127_native(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

  // Version-scoped native/binary regex fallback for v2.1.30.
  if (isNativeBinary && content.includes('VERSION:"2.1.30"')) {
    const result = applyRegexPatches_v2130_native(content);
    if (result.steps.length > 0) {
      content = result.out;
      for (const step of result.steps) {
        console.log(`✅ Patch 2 applied: ${step}`);
      }
    }
  }

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
