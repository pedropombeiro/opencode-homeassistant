# Agent Instructions

## Build & development commands

All tasks are run via mise:

- `mise run setup` — install dependencies
- `mise run build` — build the plugin into `dist/`
- `mise run dev` — build with inline sourcemaps
- `mise run typecheck` — type-check with `tsc --noEmit`
- `mise run lint` — lint with ESLint
- `mise run lint:fix` — lint and auto-fix
- `mise run format` — format with Prettier
- `mise run link` — symlink `dist/index.js` into `~/.config/opencode/plugins/` for local testing
- `mise run unlink` — remove the local plugin symlink from `~/.config/opencode/plugins/`
  There are no npm scripts. Do not add a `"scripts"` key to `package.json`.

## Code style

- TypeScript strict mode, ESNext target
- Single quotes, semicolons, 100-char line width, 2-space indent, trailing commas
- No `console.log` — ESLint enforces `no-console: error`
- No comments unless explicitly requested
- Imports: use `import type` for type-only imports

## Testing

There are no automated tests for this plugin. Verify by running `mise run build` and `mise run typecheck` successfully.

## Releasing

Releases are fully automated via [release-please](https://github.com/googleapis/release-please) and GitHub Actions. **Do NOT manually bump the version in `package.json` or `.release-please-manifest.json`.**

1. Push commits to `main` using [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix:`, `feat:`, `chore:`).
2. The `Release` workflow runs release-please, which creates/updates a release PR (titled `chore(main): release opencode-homeassistant <version>`). The PR bumps `package.json`, updates the manifest, and generates a changelog.
3. Merge the release PR.
4. Release-please creates a GitHub Release and tag, which triggers the `Publish` workflow to build and publish to npm.

To publish, simply merge the release-please PR — no manual `npm publish` or version edits needed.
