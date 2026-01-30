#!/usr/bin/env node

/**
 * Claude Code npm deprecation warning patcher
 *
 * Removes the notification:
 * "Claude Code has switched from npm to native installer..."
 *
 * This patch targets npm/local installs where `claude` points to `@anthropic-ai/claude-code/cli.js`.
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
  console.log('  --file PATH  Patch a specific cli.js file (skip auto-detection)');
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

function detectIsLikelyJsScript(filePath) {
  if (filePath.endsWith('.js')) return true;
  try {
    const prefix = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 256);
    return prefix.startsWith('#!') && prefix.includes('node');
  } catch {
    return false;
  }
}

function resolveClaudeCliJsPath() {
  if (fileArgPath) return path.resolve(fileArgPath);

  const whichClaude = safeExec('command -v claude');
  if (whichClaude) {
    try {
      const real = fs.realpathSync(whichClaude);
      return real;
    } catch {
      return whichClaude;
    }
  }

  // Fallbacks: common local install locations.
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, '.config', 'claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return null;
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

console.log('Claude Code npm deprecation warning patcher');
console.log('========================================\n');

const targetPath = resolveClaudeCliJsPath();
if (!targetPath) {
  console.error('❌ Could not find Claude Code installation.');
  console.error('   Make sure `claude` is on PATH, or pass --file /path/to/cli.js');
  process.exit(1);
}

if (!fs.existsSync(targetPath)) {
  console.error(`❌ File not found: ${targetPath}`);
  process.exit(1);
}

if (!detectIsLikelyJsScript(targetPath)) {
  console.error(`❌ Target does not look like a JavaScript CLI script: ${targetPath}`);
  console.error('   This patch is intended for npm/local installs that use cli.js.');
  console.error('   If you only want to hide the message without patching, try:');
  console.error('   DISABLE_INSTALLATION_CHECKS=1 claude');
  process.exit(1);
}

console.log(`Target: ${targetPath}`);
if (isDryRun) console.log('Mode: dry-run (no files will be modified)');

if (isRestore) {
  restoreFromBackup(targetPath);
  process.exit(0);
}

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

console.log('\nNext: restart Claude Code to confirm the banner no longer appears.');
