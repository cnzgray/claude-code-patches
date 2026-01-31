## Research Guidelines

- When conducting research, it must be done in the `.research/version` directory (where version is the Claude Code version, e.g., `v2.1.17`, `v2.1.23`, etc.)
- The corresponding version of the claude-code package can be downloaded from npm for research

## Research Reference Resources

- Methods described in the project README.md
- [tweakcc thinkingVisibility.ts](https://github.com/Piebald-AI/tweakcc/blob/main/src/patches/thinkingVisibility.ts) - Reference implementation for thinking patch
- [tweakcc project](https://github.com/Piebald-AI/tweakcc) - Reference for native installation method support

## Current Research Tasks

### 1. Thinking Patch Research
- Goal: Research how to apply thinking patches to new versions of Claude Code
- Reference tweakcc's `thinkingVisibility.ts` implementation
- Must support both npm installation method and native installation method

### 2. npm-deprecation-warning Removal
- Goal: Research how to remove the npm-deprecation-warning prompt from npm-installed Claude Code
