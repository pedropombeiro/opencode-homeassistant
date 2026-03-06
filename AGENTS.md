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
- `mise run publish` — publish to npm

There are no npm scripts. Do not add a `"scripts"` key to `package.json`.

## Code style

- TypeScript strict mode, ESNext target
- Single quotes, semicolons, 100-char line width, 2-space indent, trailing commas
- No `console.log` — ESLint enforces `no-console: error`
- No comments unless explicitly requested
- Imports: use `import type` for type-only imports

## Testing

There are no automated tests for this plugin. Verify by running `mise run build` and `mise run typecheck` successfully.
