# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the ismartgate and GogoGate2
garage door and gate gateways (local API, no cloud): a Node.js service (Node
22+, ESM, no build step) that runs in its own sandboxed Docker container and
talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template
and ports the ismartgate library (MIT). See `TODO.md` for the status and the
decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "guard"   # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> IsmartgateApp (shared with the tests)
src/app.js                        IsmartgateApp: polling, status, Discovery, commands, guards
src/gate/http.js                  one HTTP GET: deadline, size cap, sent flag, beforeSend
src/gate/client.js                info / activate, statuses and API errors -> error kinds
src/gate/cipher.js                the request envelope (AES-128-CBC, key, token)
src/gate/xml.js                   bounded linear XML scanner (no DOCTYPE)
src/gate/parse.js                 answers -> gateway, doors, errors (pure)
src/devices.js                    doors -> Gladys devices and values (pure)
src/publisher.js                  states within the rate limit (250/min), measures spaced
src/store.js                      /data/ismartgate-state.json: pause, block, gateway id, last read
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and a fake gateway
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('ismartgate',
'<gateway hash>-<door>')`, the hash of the gateway's remote access name,
  never an address. Feature keys (`state`, `open`, `close`, `temperature`,
  `battery`), manifest keys and action keys are frozen too. A created device
  never loses a feature (see `publishDevices`).
- **Safety.** A door is never a `switch` nor a commandable `binary`: an
  opening sensor and buttons. Every pulse is decided on a state read just
  now (open only from closed, close only from open, nothing on an unknown
  state). Opening stays off by default, checked on arrival, after the fresh
  read and in `beforeSend`; closing is never blocked (option, queue, pause,
  block) and cancels what waits; one pulse at a time and a guard after each
  pulse. Keep the tests that say so.
- **The local API is not documented**: every answer is size-capped and
  parsed by the bounded scanner; anything unexpected is "invalid", never a
  guess.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  or store the user name, the password, an activation code or a request path
  (it carries the sealed credentials); a `secret` field is kept by Gladys in
  its database, never shown again: never write that it is encrypted.
- **Reads never faster than the interval**: test button, scan, reconnection,
  unchanged configuration, restart.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json`, `package-lock.json` or the manifest, nor the
  `docker_image` tag, by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects. The catalog
  `description` holds 10 to 100 characters per language.
- **Units.** Only the ones the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY` in `server/utils/constants.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
- **Encoding.** Every file is UTF-8 without BOM, LF, no control byte;
  `test/encoding.test.js` refuses mojibake.
