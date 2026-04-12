# Publishing To npm

This document describes the current npm publish workflow for this repository.

Current package identity:

- npm package name: `dbchat-cli`
- installed command: `dbchat`
- registry: `https://registry.npmjs.org/`

This repository keeps the source README and the npm registry README separate.

- `README.md`
  The full repository README for GitHub and local development.
- `README.npm.md`
  The shorter npm package README that gets copied into the publish directory as `README.md`.

## Why The Package Is Published From A Staging Directory

The publish flow stages a clean package in `.npm-package/` before running `npm publish`.

That gives two benefits:

- it keeps the published package smaller and avoids shipping development-only repository files
- it allows npm to use a different README than the source repository

The staging directory contains only:

- `dist/`
- `package.json`
- npm-facing `README.md`
- `LICENSE` when the repository has one

## One-Time Preparation

Make sure `package.json` contains valid public package metadata:

- `name`
- `version`
- `license`
- `author`
- `repository`
- `homepage`
- `bugs`

Make sure the npm-facing README is up to date:

- source file: `README.npm.md`
- published file: `.npm-package/README.md`

If your local npm config points at a mirror, always force the official registry in publish commands.

This repository currently sets:

- `publishConfig.registry = https://registry.npmjs.org/`

Use the explicit `--registry https://registry.npmjs.org/` flag anyway when you publish from a workstation that may have a mirror configured globally.

## What The Release Script Does

The staging script is `scripts/prepare-npm-package.mjs`.

It performs these steps:

1. reads the root `package.json`
2. creates `.npm-package/`
3. copies `dist/` into `.npm-package/dist/`
4. removes compiled test artifacts from the staged `dist/`
5. copies `README.npm.md` to `.npm-package/README.md`
6. copies `LICENSE` when present
7. writes a publish-ready `.npm-package/package.json`

## Release Checklist

1. Update the version in `package.json`.
2. Check package-name availability against the official npm registry:

```bash
npm view dbchat-cli version --registry https://registry.npmjs.org/
```

3. Build the project:

```bash
pnpm build
```

4. Prepare the staged npm package:

```bash
pnpm run release:npm:prepare
```

5. Inspect the package contents with a dry run:

```bash
pnpm run release:npm:dry-run
```

6. Authenticate to the official npm registry.

7. Publish the staged package:

```bash
npm publish .npm-package --access public --registry https://registry.npmjs.org/
```

## Publish With Interactive Login

Use this when your npm account is configured for interactive login and 2FA.

```bash
npm logout --registry https://registry.npmjs.org/
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
npm publish .npm-package --access public --registry https://registry.npmjs.org/
```

## Publish With Token

If you publish with a token instead of interactive `npm login`, create a granular access token on npm with:

- write/publish permission
- `bypass 2FA` enabled

Two workable local approaches are documented below.

### Option A: Configure The Token In npm Config

Use this when publishing manually from your own machine:

```bash
npm logout --registry https://registry.npmjs.org/
npm config set //registry.npmjs.org/:_authToken=YOUR_NPM_TOKEN
npm whoami --registry https://registry.npmjs.org/
pnpm run release:npm:prepare
pnpm run release:npm:dry-run
npm publish .npm-package --access public --registry https://registry.npmjs.org/
```

Optional cleanup after publish:

```bash
npm config delete //registry.npmjs.org/:_authToken
```

### Option B: Use An Environment Variable

Use this when you do not want to persist the token in npm config.

PowerShell:

```powershell
$env:NPM_TOKEN="YOUR_NPM_TOKEN"
npm publish .npm-package --access public --registry https://registry.npmjs.org/
Remove-Item Env:NPM_TOKEN
```

If you use an `.npmrc` file with an environment variable placeholder, the file should contain:

```ini
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

Do not commit a real token value into version control.

## Common Verification Commands

Check the active npm user:

```bash
npm whoami --registry https://registry.npmjs.org/
```

Check the package on the registry:

```bash
npm view dbchat-cli version --registry https://registry.npmjs.org/
```

Inspect the published package page:

```text
https://www.npmjs.com/package/dbchat-cli
```

## If Publish Fails With 2FA Errors

Typical error:

```text
403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

Fix it with one of these approaches:

1. Enable 2FA on the npm account, then run:

```bash
npm logout --registry https://registry.npmjs.org/
npm login --registry https://registry.npmjs.org/
```

2. Or replace the existing token with a granular access token that has publish permissions and `bypass 2FA` enabled.

If `npm whoami` works but `npm publish` still returns `403`, the current login state is usually valid for identity lookup but not valid for package publishing.

## Notes Specific To This Repository

- The published package README is intentionally different from the repository `README.md`.
- The staged package is published from `.npm-package/`, not from the repository root.
- The local runtime data directory is still `~/.db-chat-cli/` for compatibility with existing installs.
