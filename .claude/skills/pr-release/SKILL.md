---
name: pr-release
description: PR conventions, changeset requirements, and release workflow for JawClaw. Load this before creating PRs.
---

# PR & Release Conventions

## Branch Naming

```
feat/short-description     — new feature
fix/short-description      — bug fix
chore/short-description    — maintenance (ci, deps, docs, refactor)
```

## PR Requirements

### 1. Changeset (required for feature/fix PRs)

Any PR that changes package behavior MUST include a changeset:

```bash
pnpm changeset
```

- Select affected package(s) — all three share a fixed version
- Choose bump type: `patch` (fix), `minor` (feature), `major` (breaking)
- Write a one-line summary
- Commit the generated `.changeset/*.md` file

**Exempt prefixes** (CI allows these without changeset): `chore:`, `ci:`, `docs:`, `test:`

### 2. PR Title Format

```
<type>: <short description>

feat: add Discord channel support
fix: handle empty LLM response in react-loop
chore: update dependencies
ci: add changeset check to PR workflow
test: add hand-tools unit tests
docs: update README quick start
```

### 3. PR Body

```markdown
## Summary
- Bullet points of what changed and why

## Test plan
- [ ] How to verify the changes work
```

### 4. CI Checks Must Pass

- `build` — `pnpm build` compiles
- `test` — `pnpm test` passes (144+ tests)
- `changeset-check` — changeset file present (unless exempt prefix)

### 5. Merge Strategy

- **Squash merge only** (repo enforced, linear history)
- PR title becomes the commit message on main

## Release Flow

Fully automated after merge to main:

```
PR merged to main
    → Changesets Action detects pending changesets
    → Creates/updates "Version Packages" PR
        → Bumps version in all 3 package.json files
        → Updates CHANGELOG.md
        → Shows what will be published
    → Merge the "Version Packages" PR
        → Auto-publishes to npm (@jawclaw/core, @jawclaw/channels, jawclaw)
        → Creates GitHub Release with changelog
```

### Manual Release (if needed)

```bash
pnpm changeset          # create changeset
pnpm version            # bump versions + changelog
pnpm release            # build + test + publish
```

## Package Versioning

All three packages use **fixed versioning** — they always share the same version number.
When any package changes, all three get the same version bump.

| Package | npm Name | What it is |
|---------|----------|------------|
| packages/core | @jawclaw/core | Agent engine, providers, tools |
| packages/channels | @jawclaw/channels | IM channel adapters |
| packages/cli | jawclaw | CLI entry point (what users install) |

## Code Review Checklist

Before submitting a PR, verify:

- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] No `node:fs/promises` or `node:child_process` imports outside `providers/local-shell.ts`
- [ ] No `openai` imports outside `providers/openai.ts`
- [ ] New features have test coverage
- [ ] Changeset included (if applicable)
- [ ] `codex review --uncommitted` checked (if available)
