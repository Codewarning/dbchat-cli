# Publishing To npm

This repository keeps the source README and the npm registry README separate.

- `README.md`
  The full repository README for GitHub and local development.
- `README.npm.md`
  The shorter npm package README that gets copied into the publish directory as `README.md`.

## Why The Package Is Published From A Staging Directory

The root repository stays `private: true` on purpose.

That gives two safety benefits:

- it prevents accidental `npm publish` from the repository root
- it allows npm to use a different README than the source repository

The release script generates a clean `.npm-package/` directory that contains only:

- `dist/`
- `package.json`
- npm-facing `README.md`
- `LICENSE` when the repository has one

## Release Checklist

1. Update the version in `package.json`.
2. Fill in package metadata before the first public release:
   `license`, `repository`, `homepage`, and `bugs`.
3. Check package-name availability against the official npm registry:

```bash
npm view dbchat-cli version --registry https://registry.npmjs.org/
```

4. Log in to the official npm registry:

```bash
npm login --registry https://registry.npmjs.org/
```

5. Build and prepare the staging directory:

```bash
pnpm run release:npm:prepare
```

6. Inspect the package contents with a dry run:

```bash
pnpm run release:npm:dry-run
```

7. Publish the staged package:

```bash
npm publish .npm-package --access public --registry https://registry.npmjs.org/
```

## Registry Note

If your local npm config points at a mirror, always force the official registry in publish commands.

This repository currently sets:

- `publishConfig.registry = https://registry.npmjs.org/`

Use the explicit `--registry https://registry.npmjs.org/` flag anyway when you publish from a workstation that may have a mirror configured globally.
