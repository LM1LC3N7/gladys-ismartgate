# gladys-ismartgate

[Gladys Assistant](https://gladysassistant.com) external integration for the
**ismartgate** (PRO, LITE, Mini) and **GogoGate2** garage door and gate
gateways, on the local network: each door set up on the gateway becomes a
Gladys device of the Discovery tab (opening sensor, temperature and battery of
the wireless sensor, open and close buttons), through the local API of the
gateway, without its cloud. Unofficial, not affiliated with ismartgate.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake gateway built
> from the test server of the ismartgate library only, never with a real
> device. The local API is not documented by the maker.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (IsmartgateApp)
                                   ├─ src/gate/http.js     one HTTP GET (node:http): deadline, size cap, beforeSend
                                   ├─ src/gate/client.js   info / activate, statuses and API errors -> kinds
                                   ├─ src/gate/cipher.js   the request envelope (AES-128-CBC, key, token)
                                   ├─ src/gate/xml.js      a bounded, linear XML scanner (no DOCTYPE)
                                   ├─ src/gate/parse.js    answers -> gateway, doors, errors (pure)
                                   ├─ src/devices.js       doors -> Gladys devices and values (pure)
                                   ├─ src/publisher.js     states within 250/min (Gladys: 300), measures spaced
                                   └─ src/store.js         /data/ismartgate-state.json: pause, block, gateway id, last read
```

- **One gateway** per installation, by IP address, with the user name and
  password of its app. Every call is `GET /api.php?data=<sealed>` (plus `t`
  and `token` on an ismartgate), the answer XML comes back sealed the same
  way, errors in clear, as in the ismartgate library.
- **Identity**: the remote access name of the gateway (`remoteaccess`, as Home
  Assistant uses it), hashed: external ids `ismartgate:<hash>-<door>`. Checked
  at every read and before every command.
- **Polling** of `info` every `poll_interval` seconds, never faster (the time
  of the last read is kept in `/data`).
- **Commands**: `activate` is one pulse on the relay of a door, the same for
  opening and closing. A door is never a switch (buttons only). Opening is off
  by default. Every pulse is decided on a fresh read: open only from closed,
  close only from open, nothing on an unknown state. Closing ignores the
  option, the queue of the openings, a 429/5xx pause and a credentials block
  (one try), and cancels a pending opening. One pulse at a time per door, then
  a guard until the door is read in the other state or the travel time
  passed. See [docs/en.md](docs/en.md#command-safety).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakeGateway.js` is a fake gateway behind the client's `request`:
it opens the sealed requests with its own credentials and answers like the
test server of the ismartgate library; the end-to-end tests run the real
handlers against the SDK's fake Gladys, with a fake clock.

## Credits

- [`ismartgate`](https://github.com/bdraco/ismartgate) by Robbie Van Gorkom
  and J. Nick Koston (MIT), the library behind the Home Assistant "Gogogate2
  and ismartgate" integration: the request envelope, the options, the fields
  and the error codes are taken from it (ported to JavaScript, no file
  copied). Full notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- `src/publisher.js` and `src/gate/http.js` come from
  [LM1LC3N7/gladys-blebox](https://github.com/LM1LC3N7/gladys-blebox) (same
  author, Apache-2.0).

ismartgate and GogoGate are trademarks of their owner, used here only to name
the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (ismartgate, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
