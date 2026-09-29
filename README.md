English | [中文](README-zh.md)

[![npm](https://img.shields.io/npm/v/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)
[![downloads](https://img.shields.io/npm/dm/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)
[![license](https://img.shields.io/github/license/CloudSwordSage/opencode-vibeguard)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)

# opencode-vibeguard

Inspired by [VibeGuard](https://github.com/inkdust2021/VibeGuard).

![Screenshot](./screenshot.png)

An OpenCode plugin that:

- Replaces configured sensitive strings with placeholders **before requests are sent to the LLM provider** (the provider never sees plaintext)
- Restores placeholders back to the original text **after the model output completes** (more natural local display/persistence)
- Restores placeholders **before tool execution** (e.g. `bash` / `write` / `edit`) so local tools run with real values

Note: OpenCode tool calls are stored in the DB with the **real executed args/output**. Before each request, this plugin also redacts **historical tool inputs/outputs** to prevent plaintext from being sent upstream in later turns.

Placeholder format (aligned with VibeGuard):

- Prefix: `__VG_`
- Shape: `__VG_<CATEGORY>_<hash12>__` or `__VG_<CATEGORY>_<hash12>_<N>__`
- `hash12` is the first 12 hex chars of `HMAC-SHA256(session-random secret, original)`, stable within a session and irreversible to the provider

## Install / Use (local dev, OpenCode V2)

1. Put this plugin directory in your project (e.g. `./opencode-vibeguard/`).
2. Install dependencies and build the single-file plugin:

```bash
cd opencode-vibeguard
npm install
npm run build
```

3. Load it in your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./opencode-vibeguard"]
}
```

4. Put `vibeguard.config.json` in your project root (copy from `vibeguard.config.json.example`).

> Safety note: to avoid unexpected modifications, the plugin becomes a no-op if the config file is missing or `enabled=false`.

### Activate by copying the build output (OpenCode V2)

Once built, copy `dist/opencode-vibeguard.js` directly into your OpenCode plugin directory to enable it globally, with no project config entry:

```text
~/.config/opencode/plugins/opencode-vibeguard.js
```

OpenCode discovers `.js` files under `~/.config/opencode/plugins/` automatically. Put `vibeguard.config.json` in the project you run OpenCode from, or in `~/.config/opencode/vibeguard.config.json`.

## Install / Use (npm)

Reference the package name in `opencode.json` (OpenCode will auto-install it on first use):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-vibeguard"]
}
```

You can also pin a version:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-vibeguard@0.1.0"]
}
```

Optional (manual) install via npm/pnpm/bun (useful for offline / reproducible setups):

```bash
npm i -D opencode-vibeguard
# or: pnpm add -D opencode-vibeguard
# or: bun add -d opencode-vibeguard
```

If you prefer to load from your local `node_modules`, use the package directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./node_modules/opencode-vibeguard"]
}
```

## Configuration

Config lookup order (first match wins):

1. Path specified by env var `OPENCODE_VIBEGUARD_CONFIG`
2. Project root: `./vibeguard.config.json`
3. Project `.opencode` dir: `./.opencode/vibeguard.config.json`
4. Global dir: `$XDG_CONFIG_HOME/opencode/vibeguard.config.json`, or `~/.config/opencode/vibeguard.config.json` when `XDG_CONFIG_HOME` is unset

See `vibeguard.config.json.example` for an example.

## Tests

```bash
cd opencode-vibeguard
npm test
```

## Build

```bash
npm run build
```

The output is the standalone ESM plugin `dist/opencode-vibeguard.js`. You can copy that single file into `~/.config/opencode/plugins/` to enable the plugin without any OpenCode config change.

## Debug

Enable debug logs (will not print any plaintext secrets; only config path and replace counts):

```bash
OPENCODE_VIBEGUARD_DEBUG=1 opencode .
```

Or set in `vibeguard.config.json`:

```json
{ "debug": true }
```

## Known limitations

- Restoring placeholders through the OpenCode V2 `http.response` hook buffers the provider response, so restored output is emitted after the response completes instead of token by token.
- A placeholder split across multiple independent SSE delta payloads cannot be restored because the wire framing interrupts the placeholder text.
- Experimental WebSocket-backed provider traffic does not pass through `http.response` and is not currently restored.
