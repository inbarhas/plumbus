---
name: bump-version
description: 'Prepare Plumbus package version changes and coordinated releases, including changelogs, peer ranges, and upgrade instructions. Use when asked to bump versions or prepare a release.'
---

# Bump Package Versions

Prepare the requested package versions without creating git tags. The helper script bumps only core, UI, and voice; coordinated releases also require updates to the other publishable packages.

## When to Use

- Preparing a new release
- User asks to bump, increment, or update package versions
- Preparing a coordinated migration release under the repository's release policy

## Parameters

| Parameter | Values | Default |
|-----------|--------|---------|
| Bump type | `patch`, `minor`, `major` | `patch` |

## Procedure

### Step 1: Determine bump type

- If the user specified `patch`, `minor`, or `major`, use that.
- Otherwise, choose the bump from the requested changes and the repository's release policy. Patch releases preserve supported behavior; migration-requiring releases need a new minor family. Ordinary implementation work does not itself require immediate version changes.
- Read `packages/plumbus-core/instructions/peer-dependencies.md` before changing any Plumbus peer range.

### Step 2: Run the bump script

```bash
./scripts/bump-version.sh <patch|minor|major>
```

Example:

```bash
./scripts/bump-version.sh patch
```

### Step 3: Coordinated migration releases — mandatory

For the current core 0.8 stabilization family, follow `docs/upgrading-stabilization.md` and the canonical peer table: core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, and other add-ons 0.3.x. Discover all publishable `packages/*/package.json` manifests (currently 24); include add-ons with only peer changes. For a future migration release, update the release plan and canonical table before deriving the affected package set. Copy the new-family peer literals; do not widen them to legacy lines. UI requires core as a shared peer; never restore a direct nested core dependency to bypass the upgrade boundary.

The generic bump script changes only core, UI, and voice. It is not sufficient to prepare a coordinated release: update every package in the plan, its changelog, packaged guidance, lockfile, and root agent instructions. Audit current READMEs, install commands, documentation indexes, dependency badges, and consumer recipes; preserve historical release notes and feature introduction versions. Keep shared framework instructions in AGENTS.md and preserve the @AGENTS.md import in CLAUDE.md. Publish normally to `latest`. Run the four repository checks and packed npm consumer checks before publication. Never tag, publish, promote dist-tags, or mutate git without the authorization required by repository instructions.

### Step 4: Verify the result

Read the updated versions from each `package.json`:

```bash
rg '"version"' packages/*/package.json
```

If Step 3 applied, also confirm add-on peers match `packages/plumbus-core/instructions/peer-dependencies.md`:

```bash
rg '"@plumbus/core"' packages/*/package.json
```

### Step 5: Report

Tell the user the old and new versions for each package. If Step 3 ran, list which add-ons were peer-bumped.
