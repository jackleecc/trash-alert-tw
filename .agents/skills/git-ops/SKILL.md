---
name: git-ops
description: Execute Git version control workflows (add, commit, push, diff, status, branch) with minimal token cost, strictly enforcing the lowest-tier model (flash_lite) for subagent delegation and lightweight command execution.
---

# Git Ops (Lightweight & Cost-Optimized)

Use this skill whenever performing any Git version control operations, including inspecting repository status, staging changes, writing commit messages, pushing to remote, or managing branches.

## Core Rule: Lowest-Tier Model Delegation

All Git operations are mechanical and deterministic. They **MUST NOT** consume expensive high-tier reasoning tokens (such as Pro or Flash models) unnecessarily.

### Subagent Invocation Rule
When dispatching Git tasks to a subagent via `invoke_subagent`:
- **Model Selection**: You **MUST** strictly specify `Model: 'flash_lite'` (the lowest-tier, lightest model available).
- **Subagent Role**: Set Role to `Git Operator (flash_lite)`.
- **TypeName**: Use `self` or a lightweight task runner.

Example subagent call:
```json
{
  "TypeName": "self",
  "Role": "Git Operator (flash_lite)",
  "Model": "flash_lite",
  "Prompt": "Execute Git staging, commit with a conventional commit message, and push to origin."
}
```

---

## Command Execution Guidelines (Token & Performance Optimization)

When executing Git commands directly or via a subagent, always follow these lightweight command patterns to prevent context window bloat:

### 1. Minimal Status Inspection
- **Do not** run unrestricted `git status` which outputs excessive help prose.
- **Use concise mode**:
  ```bash
  git status -s
  ```

### 2. Guarded Diff Inspection
- **Do not** dump large multi-file diffs directly into the context.
- **First inspect changed files and sizes**:
  ```bash
  git diff --stat
  ```
- Only view specific file diffs if strictly needed for writing accurate commit messages.

### 3. Limited Log History
- **Never** run unbounded `git log`.
- **Use oneline format with line limits**:
  ```bash
  git log -n 5 --oneline
  ```

### 4. Precise Staging
- **Never** run blind `git add -A` or `git add .` if untracked temporary/scratch files exist.
- Stage only intended files explicitly:
  ```bash
  git add <target-file-1> <target-file-2>
  ```
- Always verify sensitive files (e.g. `.env`, credentials, local scratch directories) are **NOT** staged.

### 5. Standard Conventional Commits
- Keep commit messages concise, structured, and descriptive:
  - `feat: <short description>` (New feature)
  - `fix: <short description>` (Bug fix)
  - `chore: <short description>` (Maintenance, dependency, or config update)
  - `refactor: <short description>` (Code restructuring without behavior change)

### 6. Non-Interactive Safe Pushing
- Ensure remote push does not hang on interactive prompts:
  ```bash
  git push
  ```
- If push fails due to remote divergence, run `git pull --rebase` before retrying.
- If push fails due to authentication or credentials, report clearly to the user immediately without looping.
