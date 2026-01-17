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
    'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11)'
  );
  console.log('==============================================\n');
  console.log('Usage: node patch-thinking.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
  console.log('  --file PATH  Patch a specific cli.js file (skip auto-detection)');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node patch-thinking.js              # Apply patches');
  console.log('  node patch-thinking.js --dry-run    # Preview changes');
  console.log('  node patch-thinking.js --restore    # Restore original');
  console.log('  node patch-thinking.js --file PATH  # Patch a downloaded cli.js');
  process.exit(0);
}

console.log(
  'Claude Code Thinking Visibility Patcher (supports 2.0.62, 2.0.71, 2.0.74, 2.0.75, 2.0.76, 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.1.6, 2.1.7, 2.1.9, 2.1.11)'
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

// Auto-detect Claude Code installation path
function getClaudeCodePath() {
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
          return realPath;
        } catch (e) {
          return testPath;
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
    if (found) return found;
  }

  // PRIORITY 2: Global npm installation via 'npm root -g'
  const npmGlobalRoot = safeExec('npm root -g');
  if (npmGlobalRoot) {
    const npmGlobalPath = path.join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    const found = checkPath(npmGlobalPath, 'npm root -g');
    if (found) return found;
  }

  // PRIORITY 3: Derive from process.execPath
  // Global modules are typically in ../lib/node_modules relative to node binary
  const nodeDir = path.dirname(process.execPath);
  const derivedGlobalPath = path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
  if (found) return found;

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
          if (foundDirect) return foundDirect;
        }

        // Otherwise, navigate from bin/claude to lib/node_modules/@anthropic-ai/claude-code/cli.js
        const binDir = path.dirname(realBinary);
        const nodeModulesPath = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        const foundFromBinary = checkPath(nodeModulesPath, 'which claude');
        if (foundFromBinary) return foundFromBinary;
      } catch (e) {
        // Failed to resolve, continue
      }
    }
  }

  // No installation found, return null and include attempted paths for error reporting
  getClaudeCodePath.attemptedPaths = attemptedPaths;
  return null;
}

function resolveTargetPath() {
  const overridePath = fileArgPath || process.env.CLAUDE_CODE_CLI_PATH;
  if (overridePath) {
    const attemptedPaths = [];
    getClaudeCodePath.attemptedPaths = attemptedPaths;

    const resolved = path.resolve(overridePath);
    attemptedPaths.push({
      path: resolved,
      method: fileArgPath ? '--file' : 'CLAUDE_CODE_CLI_PATH',
    });

    if (!fs.existsSync(resolved)) return null;
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  return getClaudeCodePath();
}

const targetPath = resolveTargetPath();

if (!targetPath) {
  console.error('❌ Error: Could not find Claude Code installation\n');
  console.error('Searched using the following methods:\n');

  const attemptedPaths = getClaudeCodePath.attemptedPaths || [];

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
  }

  console.error('\n💡 Troubleshooting:');
  console.error('  1. Verify Claude Code is installed: claude --version');
  console.error('  2. For local install: Check ~/.claude/local or ~/.config/claude/local');
  console.error('  3. For global install: Ensure "npm install -g @anthropic-ai/claude-code" succeeded');
  console.error('  4. Check that npm is in your PATH if using global install');
  process.exit(1);
}

console.log(`Found Claude Code at: ${targetPath}\n`);

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
console.log('Reading cli.js...');
if (!fs.existsSync(targetPath)) {
  console.error('❌ Error: cli.js not found at:', targetPath);
  process.exit(1);
}

let content = fs.readFileSync(targetPath, 'utf8');

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

let patch1Applied = false;
let patch2Applied = false;
const patch2PlannedSteps = [];

// Check if patches can be applied
console.log('Checking patches...\n');

console.log('Patch 1: collapsed thinking banner removal (older versions)');
if (content.includes(bannerSearchPattern_v2062)) {
  patch1Applied = true;
  console.log('  ✅ Pattern found (v2.0.62) - ready to apply');
} else if (content.includes(bannerReplacement_v2062)) {
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

if (patch2PlannedSteps.length > 0) {
  console.log(`  ✅ Pattern found (${patch2PlannedSteps.join(', ')}) - ready to apply`);
} else {
  const patch2AlreadyApplied =
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
    content.includes(thinkingRendererReplacement_v21111);

  if (!patch2AlreadyApplied) {
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
  content = content.replace(bannerSearchPattern_v2062, bannerReplacement_v2062);
  console.log('✅ Patch 1 applied: ZT2 function now returns null');
}

// Apply Patch 2
if (patch2Applied) {
  if (content.includes(thinkingSearchPattern_v2062)) {
    content = content.replace(thinkingSearchPattern_v2062, thinkingReplacement_v2062);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.62 call site)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2074)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v2074, redactedThinkingCallsiteReplacement_v2074);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.0.74 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2074)) {
    content = content.replace(thinkingCallsiteSearchPattern_v2074, thinkingCallsiteReplacement_v2074);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.0.74 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2074_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v2074_variantCollapsedBanner, thinkingRendererReplacement_v2074);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.74 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2074_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v2074_variantNullGate, thinkingRendererReplacement_v2074);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.74 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2076)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v2076, redactedThinkingCallsiteReplacement_v2076);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.0.76 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2076)) {
    content = content.replace(thinkingCallsiteSearchPattern_v2076, thinkingCallsiteReplacement_v2076);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.0.76 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2076_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v2076_variantCollapsedBanner, thinkingRendererReplacement_v2076);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.76 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2076_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v2076_variantNullGate, thinkingRendererReplacement_v2076);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.76 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2071_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v2071_variantCollapsedBanner, thinkingRendererReplacement_v2071);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.71 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2071_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v2071_variantNullGate, thinkingRendererReplacement_v2071);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.0.71 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v2111)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v2111, redactedThinkingCallsiteReplacement_v2111);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.1 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v2111)) {
    content = content.replace(thinkingCallsiteSearchPattern_v2111, thinkingCallsiteReplacement_v2111);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.1 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2111_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v2111_variantCollapsedBanner, thinkingRendererReplacement_v2111);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.1 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v2111_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v2111_variantNullGate, thinkingRendererReplacement_v2111);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.1 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v212)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v212, redactedThinkingCallsiteReplacement_v212);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.2 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v212)) {
    content = content.replace(thinkingCallsiteSearchPattern_v212, thinkingCallsiteReplacement_v212);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.2 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v212_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v212_variantCollapsedBanner, thinkingRendererReplacement_v212);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.2 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v212_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v212_variantNullGate, thinkingRendererReplacement_v212);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.2 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v213)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v213, redactedThinkingCallsiteReplacement_v213);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.3 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v213)) {
    content = content.replace(thinkingCallsiteSearchPattern_v213, thinkingCallsiteReplacement_v213);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.3 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v213_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v213_variantCollapsedBanner, thinkingRendererReplacement_v213);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.3 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v213_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v213_variantNullGate, thinkingRendererReplacement_v213);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.3 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v214)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v214, redactedThinkingCallsiteReplacement_v214);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.4 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v214_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v214_variantCollapsedBanner, thinkingRendererReplacement_v214);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.4 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v214_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v214_variantNullGate, thinkingRendererReplacement_v214);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.4 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v216)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v216, redactedThinkingCallsiteReplacement_v216);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.6 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v216)) {
    content = content.replace(thinkingCallsiteSearchPattern_v216, thinkingCallsiteReplacement_v216);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.6 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v216_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v216_variantCollapsedBanner, thinkingRendererReplacement_v216);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.6 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v216_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v216_variantNullGate, thinkingRendererReplacement_v216);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.6 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v217)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v217, redactedThinkingCallsiteReplacement_v217);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.7 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v217)) {
    content = content.replace(thinkingCallsiteSearchPattern_v217, thinkingCallsiteReplacement_v217);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.7 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v217_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v217_variantCollapsedBanner, thinkingRendererReplacement_v217);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.7 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v217_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v217_variantNullGate, thinkingRendererReplacement_v217);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.7 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v219)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v219, redactedThinkingCallsiteReplacement_v219);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.9 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v219)) {
    content = content.replace(thinkingCallsiteSearchPattern_v219, thinkingCallsiteReplacement_v219);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.9 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v219_variantCollapsedBanner)) {
    content = content.replace(thinkingRendererSearchPattern_v219_variantCollapsedBanner, thinkingRendererReplacement_v219);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.9 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v219_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v219_variantNullGate, thinkingRendererReplacement_v219);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.9 thinking renderer)');
  }

  if (content.includes(redactedThinkingCallsiteSearchPattern_v21111)) {
    content = content.replace(redactedThinkingCallsiteSearchPattern_v21111, redactedThinkingCallsiteReplacement_v21111);
    console.log('✅ Patch 2 applied: redacted_thinking forced visible (v2.1.11 call site)');
  }

  if (content.includes(thinkingCallsiteSearchPattern_v21111)) {
    content = content.replace(thinkingCallsiteSearchPattern_v21111, thinkingCallsiteReplacement_v21111);
    console.log('✅ Patch 2 applied: thinking forced visible (v2.1.11 call site)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21111_variantCollapsedBanner)) {
    content = content.replace(
      thinkingRendererSearchPattern_v21111_variantCollapsedBanner,
      thinkingRendererReplacement_v21111
    );
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.11 thinking renderer)');
  }

  if (content.includes(thinkingRendererSearchPattern_v21111_variantNullGate)) {
    content = content.replace(thinkingRendererSearchPattern_v21111_variantNullGate, thinkingRendererReplacement_v21111);
    console.log('✅ Patch 2 applied: thinking content forced visible (v2.1.11 thinking renderer)');
  }
}

// Write file
console.log('\nWriting patched file...');
fs.writeFileSync(targetPath, content, 'utf8');
console.log('✅ File written successfully\n');

console.log('Summary:');
console.log(`- Patch 1 (banner): ${patch1Applied ? 'APPLIED' : 'SKIPPED'}`);
console.log(`- Patch 2 (visibility): ${patch2Applied ? 'APPLIED' : 'SKIPPED'}`);
console.log('\n🎉 Patches applied! Please restart Claude Code for changes to take effect.');
console.log('\nTo restore original behavior, run: node patch-thinking.js --restore');
process.exit(0);
