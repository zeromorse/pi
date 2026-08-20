---
name: pi-rebuild-global
description: Rebuild the pi monorepo so the globally linked `pi` command picks up source changes. Covers Node version requirement, package build order, partial rebuilds, stale-dist type errors, and the models.dev network fallback.
---

# Rebuild pi Monorepo for the Global `pi` Command

The global `pi` command is installed via `npm link`: `~/.local/bin/pi` runs a Node 22 wrapper that executes `<nvm>/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, which symlinks back to this repo's `packages/coding-agent`. Source edits do not take effect until `dist/` is rebuilt. Restarting `pi` alone is never enough.

## 1. Use Node 22

Build scripts run TS directly (`node scripts/*.ts`, type stripping). The nvm default is v20 and fails with `ERR_UNKNOWN_FILE_EXTENSION`:

```bash
export PATH="/Users/duanyanlong/.nvm/versions/node/v22.22.3/bin:$PATH"
node --version   # must be v22+
```

## 2. Standard Full Build

From the repo root:

```bash
npm run build
```

Build order is fixed by the root `package.json`: tui → telemetry → ai → agent → session-backends/sqlite-node → protocol → client → server → coding-agent.

## 3. Partial Rebuild (Common Case)

Only `packages/coding-agent` changed (its upstream `dist/` is already current):

```bash
npm run build --workspace @earendil-works/pi-coding-agent
```

Changed a dependency package (tui/ai/agent/...): rebuild that package first, then coding-agent (it consumes upstream `.d.ts` files).

## 4. Verification

```bash
# dist timestamps updated
stat packages/coding-agent/dist/cli.js
# new code compiled in (use a symbol unique to the change)
grep -c "<newFunctionName>" packages/coding-agent/dist/<path>.js
# CLI still starts
pi --version && pi --help
```

Then restart `pi`.

## 5. Known Failure Modes

### `toolChoice` (or similar) does not exist in `SimpleStreamOptions`

coding-agent source uses a new pi-ai API, but `packages/ai/dist` types are stale. Rebuild pi-ai:

```bash
npm run build:offline --workspace @earendil-works/pi-ai
```

### pi-ai build fails on `xai.ts` (`Provider<"openai-completions" | "openai-responses">` not assignable)

Pre-existing mismatch between `src/providers/xai.ts` (annotated `Provider<"openai-responses">`) and stale `src/providers/data/xai.json` (still contains `openai-completions` models). The proper fix is regenerating model data, which requires network access to models.dev:

```bash
npm run generate-models --workspace @earendil-works/pi-ai   # needs https://models.dev
```

When offline, skip type checking for the local build only (does not touch source files):

```bash
cd packages/ai && npx tsgo -p tsconfig.build.json --noCheck \
  && npx shx rm -rf dist/providers/data && npx shx cp -r src/providers/data dist/providers/data
```

The `--noCheck` build still produces JS and `.d.ts`; only type validation is skipped. `npm run check` keeps reporting the error until model data is regenerated.

## 6. pi-test.sh Is Different

`./pi-test.sh` runs the coding-agent source directly via tsx — edits take effect immediately, no build. Use it for fast iteration during development; use the built global `pi` to verify the final result. Use `--no-env` to run without API keys.
