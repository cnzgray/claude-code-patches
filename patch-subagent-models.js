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
  console.log('Claude Code Subagent Model Configuration Patcher v2.0.33');
  console.log('=========================================================\n');
  console.log('Usage: node patch-subagent-models.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without applying them');
  console.log('  --restore    Restore from backup file');
   console.log('  --file PATH  Patch a specific cli.js file or native claude binary (skip auto-detection)');
  console.log('  --help, -h   Show this help message\n');
  console.log('Configuration:');
  console.log('  Create ~/.claude/subagent-models.json to configure models:\n');
  console.log('  {');
  console.log('    "Plan": "sonnet",');
  console.log('    "Explore": "haiku",');
  console.log('    "general-purpose": "sonnet"');
  console.log('  }\n');
  console.log('Examples:');
  console.log('  node patch-subagent-models.js              # Apply patches');
  console.log('  node patch-subagent-models.js --dry-run    # Preview changes');
  console.log('  node patch-subagent-models.js --restore    # Restore original');
  process.exit(0);
}

console.log('Claude Code Subagent Model Configuration Patcher v2.0.33');
console.log('=========================================================\n');

// Helper function to safely execute shell commands
function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    return null;
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
    const m = prefix.readUInt32BE(0);
    if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcffaedfe || m === 0xcafebabe) return 'native-binary';
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
      const entries = fs.readdirSync(versionsDir);
      for (const entry of entries) {
        candidates.push(path.join(versionsDir, entry));
      }
    }
  } catch {
    // Ignore
  }

  return candidates;
}

function padRightSpaces(str, targetLen) {
  if (str.length > targetLen) return null;
  if (str.length === targetLen) return str;
  return str + ' '.repeat(targetLen - str.length);
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

  // PRIORITY 1: Local installations
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
  const nodeDir = path.dirname(process.execPath);
  const derivedGlobalPath = path.join(nodeDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const found = checkPath(derivedGlobalPath, 'derived from process.execPath');
  if (found && found.kind === 'js') return found;

  // PRIORITY 4: Unix systems - try 'which claude' to find binary
  if (process.platform !== 'win32') {
    const claudeBinary = safeExec('which claude');
    if (claudeBinary) {
      try {
        const realBinary = fs.realpathSync(claudeBinary);
        const binDir = path.dirname(realBinary);
        const nodeModulesPath = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        const foundFromBinary = checkPath(nodeModulesPath, 'which claude');
        if (foundFromBinary && foundFromBinary.kind === 'js') return foundFromBinary;

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

  // No installation found
  getClaudeCodeTarget.attemptedPaths = attemptedPaths;
  return null;
}

// Read subagent-models.json for model configuration
function getModelConfiguration() {
  const homeDir = os.homedir();
  const configPaths = [
    path.join(homeDir, '.claude', 'subagent-models.json'),
    path.join(homeDir, '.config', 'claude', 'subagent-models.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configContent);

        console.log(`Found model configuration in: ${configPath}\n`);
        return config;
      } catch (error) {
        console.warn(`Warning: Could not parse ${configPath}: ${error.message}`);
      }
    }
  }

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

if (!targetPath) {
  console.error('❌ Error: Could not find Claude Code installation\n');
  console.error('Searched using the following methods:\n');

  const attemptedPaths = getClaudeCodeTarget.attemptedPaths || [];

  if (attemptedPaths.length > 0) {
    const byMethod = {};
    attemptedPaths.forEach(({ path, method }) => {
      if (!byMethod[method]) byMethod[method] = [];
      byMethod[method].push(path);
    });

    Object.entries(byMethod).forEach(([method, paths]) => {
      console.error(`  [${method}]`);
      paths.forEach(p => console.error(`    - ${p}`));
    });
  }

  console.error('\n💡 Troubleshooting:');
  console.error('  1. Verify Claude Code is installed: claude --version');
  console.error('  2. For local install: Check ~/.claude/local or ~/.config/claude/local');
  console.error('  3. For global install: Ensure "npm install -g @anthropic-ai/claude-code" succeeded');
  console.error('  4. For native/binary install: Check ~/.local/bin/claude and ~/.local/share/claude/versions');
  process.exit(1);
}

console.log(`Found Claude Code at: ${targetPath}`);
console.log(`Installation type: ${isNativeBinary ? 'native/binary' : 'npm/local (cli.js)'}\n`);

const backupPath = targetPath + '.subagent-models.backup';

// Restore from backup
if (isRestore) {
  if (!fs.existsSync(backupPath)) {
    console.error('❌ Error: Backup file not found at:', backupPath);
    console.error('\n💡 Tip: The backup is created when you first apply the patch.');
    process.exit(1);
  }

  console.log('Restoring from backup...');
  fs.copyFileSync(backupPath, targetPath);
  console.log('✅ Restored successfully!');
  console.log('\nPlease restart Claude Code for changes to take effect.');
  process.exit(0);
}

// Get model configuration
const modelConfig = getModelConfiguration();

if (!modelConfig) {
  console.log('ℹ️  No model configuration found\n');
  console.log('To configure subagent models, create ~/.claude/subagent-models.json:\n');
  console.log('{');
  console.log('  "Plan": "sonnet",');
  console.log('  "Explore": "haiku",');
  console.log('  "general-purpose": "sonnet"');
  console.log('}\n');
  console.log('Valid model values: "haiku", "sonnet", "opus"\n');
  console.log('Run with --help for more information.');
  process.exit(0);
}

console.log('Model Configuration:');
console.log(`  Plan: ${modelConfig.Plan || '(not set)'}`);
console.log(`  Explore: ${modelConfig.Explore || '(not set)'}`);
console.log(`  general-purpose: ${modelConfig['general-purpose'] || '(not set)'}`);
console.log('');

// Read file
console.log(`Reading ${isNativeBinary ? 'claude binary' : 'cli.js'}...`);
if (!fs.existsSync(targetPath)) {
  console.error(`❌ Error: target not found at: ${targetPath}`);
  process.exit(1);
}

const fileEncoding = isNativeBinary ? 'latin1' : 'utf8';
let content = fs.readFileSync(targetPath, fileEncoding);
const originalContentLength = content.length;

// Define patch patterns for v2.0.33
const patches = [];

// Patch 1: Plan agent (a3A)
if (modelConfig.Plan) {
  patches.push({
    name: 'Plan agent model',
    searchPattern: 'a3A={agentType:"Plan",whenToUse:Sw.whenToUse,disallowedTools:Sw.disallowedTools,systemPrompt:Sw.systemPrompt,source:"built-in",tools:Sw.tools,baseDir:"built-in",model:"sonnet"}',
    replacement: `a3A={agentType:"Plan",whenToUse:Sw.whenToUse,disallowedTools:Sw.disallowedTools,systemPrompt:Sw.systemPrompt,source:"built-in",tools:Sw.tools,baseDir:"built-in",model:"${modelConfig.Plan}"}`,
    currentValue: 'sonnet',
    newValue: modelConfig.Plan
  });
}

// Patch 2: Explore agent (Sw) - model appears at end of definition before }});
if (modelConfig.Explore) {
  patches.push({
    name: 'Explore agent model',
    searchPattern: 'Complete the user\'s search request efficiently and report your findings clearly.`,source:"built-in",baseDir:"built-in",model:"haiku"}});var a3A;',
    replacement: 'Complete the user\'s search request efficiently and report your findings clearly.`,source:"built-in",baseDir:"built-in",model:"' + modelConfig.Explore + '"}});var a3A;',
    currentValue: 'haiku',
    newValue: modelConfig.Explore
  });
}

// Patch 3: general-purpose agent (Y01) - this one might not have a model property by default
if (modelConfig['general-purpose']) {
  patches.push({
    name: 'general-purpose agent model',
    searchPattern: /Y01=\{agentType:"general-purpose"[^}]*\}/,
    isRegex: true,
    replacePattern: (match) => {
      // Check if it already has a model property
      if (match.includes(',model:"')) {
        return match.replace(/,model:"[^"]+"/g, `,model:"${modelConfig['general-purpose']}"`);
      } else {
        // Add model property before the closing brace
        return match.replace(/\}$/, `,model:"${modelConfig['general-purpose']}"}`);
      }
    },
    currentValue: '(inherited)',
    newValue: modelConfig['general-purpose']
  });
}

// Check and apply patches
console.log('Checking patches...\n');

const patchResults = [];

for (const patch of patches) {
  console.log(`Patch: ${patch.name}`);
  console.log(`  ${patch.currentValue} → ${patch.newValue}`);

  let canApply = false;
  let alreadyApplied = false;

  if (patch.isRegex) {
    const regex = patch.searchPattern;
    const match = content.match(regex);
    if (match) {
      const replaced = patch.replacePattern(match[0]);
      if (match[0] !== replaced) {
        canApply = true;
      } else {
        alreadyApplied = true;
      }
    }
  } else if (patch.partialMatch && patch.findPattern) {
    const match = content.match(patch.findPattern);
    if (match) {
      const currentModel = match[1];
      if (currentModel !== patch.newValue) {
        canApply = true;
      } else {
        alreadyApplied = true;
      }
    }
  } else {
    if (content.includes(patch.searchPattern)) {
      canApply = true;
    } else if (content.includes(patch.replacement)) {
      alreadyApplied = true;
    }
  }

  if (canApply) {
    console.log('  ✅ Ready to apply');
    patchResults.push({ ...patch, status: 'ready' });
  } else if (alreadyApplied) {
    console.log('  ⚠️  Already applied');
    patchResults.push({ ...patch, status: 'applied' });
  } else {
    console.log('  ❌ Pattern not found - may need update for newer version');
    patchResults.push({ ...patch, status: 'notfound' });
  }
  console.log('');
}

// Dry run mode
if (isDryRun) {
  console.log('📋 DRY RUN - No changes will be made\n');
  console.log('Summary:');
  patchResults.forEach(p => {
    console.log(`- ${p.name}: ${p.status === 'ready' ? 'WOULD APPLY' : p.status === 'applied' ? 'SKIP (already applied)' : 'SKIP (not found)'}`);
  });

  const wouldApply = patchResults.filter(p => p.status === 'ready');
  if (wouldApply.length > 0) {
    console.log('\nRun without --dry-run to apply patches.');
  }
  process.exit(0);
}

// Apply patches
const toApply = patchResults.filter(p => p.status === 'ready');

if (toApply.length === 0) {
  console.log('ℹ️  No patches to apply\n');
  const applied = patchResults.filter(p => p.status === 'applied');
  if (applied.length > 0) {
    console.log('All configured patches are already applied.');
  } else {
    console.log('No matching patterns found. The Claude Code version may have changed.');
    console.log('Run with --dry-run to see details.');
  }
  process.exit(0);
}

// Create backup if it doesn't exist
if (!fs.existsSync(backupPath)) {
  console.log('Creating backup...');
  fs.copyFileSync(targetPath, backupPath);
  console.log(`✅ Backup created: ${backupPath}\n`);
}

console.log('Applying patches...\n');

// Apply each patch
let patchedContent = content;
for (const patch of toApply) {
  if (patch.isRegex) {
    const regex = patch.searchPattern;
    patchedContent = patchedContent.replace(regex, (...args) => {
      const match = args[0];
      const replacement = patch.replacePattern(match);
      if (!isNativeBinary) return replacement;
      const padded = padRightSpaces(replacement, match.length);
      if (padded === null) {
        throw new Error(
          `Native/binary install patch too large for in-place regex replacement (${patch.name}): ` +
            `replacement length ${replacement.length} > match length ${match.length}`
        );
      }
      return padded;
    });
  } else if (patch.partialMatch && patch.findPattern) {
    patchedContent = patchedContent.replace(patch.findPattern, (...args) => {
      const match = args[0];
      const replacement = typeof patch.replacePattern === 'function' ? patch.replacePattern(...args) : patch.replacePattern;
      if (!isNativeBinary) return replacement;
      const padded = padRightSpaces(replacement, match.length);
      if (padded === null) {
        throw new Error(
          `Native/binary install patch too large for in-place regex replacement (${patch.name}): ` +
            `replacement length ${replacement.length} > match length ${match.length}`
        );
      }
      return padded;
    });
  } else {
    if (!isNativeBinary) {
      patchedContent = patchedContent.replace(patch.searchPattern, patch.replacement);
    } else {
      const padded = padRightSpaces(patch.replacement, patch.searchPattern.length);
      if (padded === null) {
        throw new Error(
          `Native/binary install patch too large for in-place replacement (${patch.name}): ` +
            `replacement length ${patch.replacement.length} > search length ${patch.searchPattern.length}`
        );
      }
      patchedContent = patchedContent.replace(patch.searchPattern, padded);
    }
  }
  console.log(`✅ Applied: ${patch.name}`);
}

// Write file
console.log('\nWriting patched file...');
if (isNativeBinary && patchedContent.length !== originalContentLength) {
  console.error('\n❌ Refusing to write: native/binary install patch would change file size.');
  console.error(`Original length: ${originalContentLength}, patched length: ${patchedContent.length}`);
  console.error('This would likely corrupt the native binary. Choose shorter replacements or use an npm/local cli.js install.');
  process.exit(1);
}
fs.writeFileSync(targetPath, patchedContent, fileEncoding);
console.log('✅ File written successfully\n');

console.log('Summary:');
patchResults.forEach(p => {
  console.log(`- ${p.name}: ${p.status === 'ready' ? 'APPLIED' : p.status === 'applied' ? 'SKIPPED (already applied)' : 'SKIPPED (not found)'}`);
});
console.log('\n🎉 Patches applied! Please restart Claude Code for changes to take effect.');
console.log('\nTo restore original behavior, run: node patch-subagent-models.js --restore');
process.exit(0);
