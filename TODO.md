# TODO — ismartgate v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 12) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local API** (2026-10-21): one gateway by IP address,
      ismartgate and GogoGate2 envelopes, `info` polling, one device per door
      (opening sensor, temperature, battery, open/close buttons), opening off
      by default, pulses decided on a fresh read, one pulse at a time and a
      guard per door, pauses and blocks persisted, last read time in `/data`,
      test button, docs en/fr, cover. Tested against a fake gateway only. The
      store validator was not run by the development agent (it cannot): to
      run from the real terminal.
- [x] **Review 1 fixes** (2026-10-21): B1 (unknown state, polling that never
      dies), I1 (closing needs the option too), M1-M5 (see the Decisions).
- [ ] **Milestone 2 — real gateway** (testers): record real answers
      (anonymized) as fixtures, fix what differs. To check first:
  - the answer of `info` on a recent firmware (fields, `remoteaccess` always
    there and stable? `permission`, `enabled` as "yes"/"no"?);
  - the errors in clear, and the HTTP status of the gateway on a wrong
    password (200 with `<error>` as the library assumes?);
  - what a pulse does on a door that is moving (stop, reverse?) and how fast
    the tilt sensor reports "opened" after an opening starts;
  - `voltage` really a battery percentage on every sensor model;
  - the `onoff` mode (what `status` means there);
  - a GogoGate2 with three doors and its global `apicode`.
- [ ] **Milestone 3 — more**: discovery (DHCP host name `ismartgate*` or the
      HomeKit announcement, through `scanNetwork`), several gateways, the
      camera image of the ismartgate PRO, "Forget a gateway" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-ismartgate:0.1.0`):
  the first Release (patch) gives 0.1.1; every later version comes from the
  Release workflow.
- **Reference**: the ismartgate library 5.0.2 (MIT, Robbie Van Gorkom and J.
  Nick Koston, the library of Home Assistant's `gogogate2` integration), read
  at its current `master`; its licence checked in its `LICENSE` file; full
  notice in `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`).
  Home Assistant's `gogogate2` component read for the identity
  (`remoteaccess`), the sensors (`voltage` is a battery %, wired sensors
  `WIRE` have none) and the configured doors (a name). Neighbour:
  gladys-blebox (gateBox: buttons, guard, cancel), structure of
  gladys-openevse (single device, lessons of lot 11).
- **The envelope**: `GET /api.php?data=<16 hex characters + base64 of
AES-128-CBC/PKCS#7 of the JSON array>`, the JSON written as Python's
  `json.dumps` (", " and ensure_ascii); ismartgate: key from
  SHA-1(lower(user) + password), plus `t` (random) and `token`
  (SHA-1(lower(user) + "@ismartgate")); GogoGate2: the fixed key of the
  library. Answers sealed the same way, errors in clear. The path carries the
  sealed credentials: never logged, never in an error. Docs: on a GogoGate2
  the key is public, the credentials are readable by anyone on the LAN: a
  dedicated user is advised.
- **XML**: a scanner of our own (elements, text, entities; DOCTYPE refused,
  64 KB, 400 elements, depth 6, 512 characters per text), children in arrays
  (no name becomes a property). Not `defusedxml`, not a dependency.
- **Identity**: `remoteaccess` before its first dot, lower case, hashed
  (SHA-256, 16 hex): external ids `ismartgate:<hash>-<door>`, frozen keys
  `state`, `open`, `close`, `temperature`, `battery`. A read without it is
  "unreadable" (status, commands refused), never "another gateway". Another
  id at the address: its doors are shown, the created ones of the old id are
  unreachable (badge) and named in the status. The id last read is kept in
  `/data` with the address: an allowed close works before the first read
  after a restart (the command does its own read anyway).
- **A door is never a switch**: `opening-sensor`/`binary` read only (0 open,
  1 closed), `button`/`push` for open and close, only in `garage` or `pulse`
  mode (an `onoff` output may drive anything: read only, a created button is
  kept and refused). A door is set up when it has a name (as the library).
- **Pulses** (`activate` is a toggle on the relay; the library itself checks
  the state first): decided on an `info` read made for the command, never on
  memory; the gateway id, the door set up, its permission, its mode and a
  known state (`opened`/`closed`) are required; open only from `closed`,
  close only from `opened`, the other state answers "already so" without
  sending. The activation code comes from that read only (never stored, never
  logged, dropped from what the polling keeps).
- **Opening AND closing need the option** (review 1, I1, coordinator
  decision `lot12_decision_toggle`, as gladys-blebox's step-by-step gate): a
  close is the same pulse as an open, and on a door moving (a remote, a
  sensor wrong) it may stop it or reopen it. The key stays `allow_open`
  (frozen), labelled "Allow opening and closing" (off by default), checked
  on arrival, after the read and in `beforeSend`, for both. Without it,
  Gladys neither opens nor closes.
- **Opening** waits in a queue of its door (review 1, M3: one queue per door,
  an opening of door 2 never waits for door 1), and is refused during a
  429/5xx pause or a credentials block.
- **Closing** (allowed) never waits behind the openings (outside the queue);
  it cancels on arrival every opening of that door not sent yet (queued ones
  included), even when it is refused itself (cancelling sends nothing). It
  gets ONE try through a 429/5xx pause or a credentials block (the read, then
  the pulse); gladys-blebox holds its step-by-step close during both instead:
  both are acceptable, kept here as the brief's "closing never blocked". It is
  still subject to the fresh read (a pulse on an unknown state could open)
  and to the guard below. Residual risk, in the docs: a door being closed by
  a remote shows "opened" until the end, so a close from Gladys at that
  moment may stop or reverse it, like a second press on the remote.
- **A door without a sensor** (`<sensor>no</sensor>`, review 1, M5) or read
  in any state but `opened`/`closed` (B1) has an unknown state: no state
  published, "unknown" in the status, every pulse refused. To check on a real
  gateway (Milestone 2).
- **The polling never dies** (review 1, B1): `run()` reschedules in a
  `finally`, `updateStatus()` survives a status that throws.
- **Answers in clear** (review 1, M2): only an `<error>` may come back
  unsealed; any other clear answer is "invalid" (anything else at the address
  could forge a state or an identity).
- **A door removed** from the gateway (no name, review 1, M4): its created
  device is an orphan (badge unreachable, named in the status), without
  making the gateway "not connected".
- **Guard** (lessons of the waves 2 and 3): one pulse at a time per door
  (flight); after a pulse that may have left (answered, or sent without
  confirmation), no other pulse on that door until a read begun after it
  shows a known state different from the one the pulse started from, or
  until the travel time + 5 s (`travel_time`, 10-120 s, 30 s by default). A
  read equal to the start state or unknown lifts nothing. A pulse refused by
  the gateway (`<error>`, 4xx, 429) sets no guard. Review 1, M1: the guards
  are kept in `/data` with the gateway id (state of departure, end), bounded
  when read back (120 s + 5 s at most, one per door), so a restart during the
  travel never lets a second pulse through.
- **Deadlines**: the fresh read gets what is left of 3.5 s minus 300 ms; the
  pulse must connect by 3.5 s after the click (checked again in
  `beforeSend`), answered by 4.3 s; a pulse that may have reached the gateway
  (silence, a cut, a 5xx, an answer not understood or not "OK") is "sent,
  without confirmation", with a guard and reads at 2 s, 8 s and the travel
  time plus 5 s (one series, a new pulse replaces it). Never retried. The ack
  never waits for Gladys.
- **Reads never faster than the interval** (lessons of lot 11): the test
  button (it gives the last result within the interval), a scan (publishes
  from memory), a reconnection (republishes status, Discovery and badge,
  no read), a configuration saved unchanged, a restart (`lastAttemptAt` in
  `/data`, written at most once a minute: a restart waits that minute more).
  A tick during a read joins it. Only new connection settings (address,
  family, credentials) read at once. A read begun before a pulse left is not
  applied; a read or a command of an older configuration publishes nothing
  (generation checked after every await).
- **Failures**: an API credentials error (ismartgate 11/22, GogoGate2 1/2) =
  a block persisted with the salted fingerprint of the REFUSED pair (15 min,
  1 h, 6 h, then 24 h; other credentials lift it, even typed while stopped;
  cleared at the first success; "Test the connection" tries once more after
  the interval). 429/5xx = a pause of 1 min to 6 h (Retry-After, else
  doubling), persisted, bounded when read back. Others: 30 s, 1, 2, 5 min,
  never sooner than the interval. A reconnection clears none of them. An
  error answered to a pulse never blocks the reads.
- **No secret in `/data`**: pause, block (with the refused pair's salted
  fingerprint only), gateway address and hashed id, last read time; file 0600. Neither the user name nor the password in a log, a status or an
  error.
- **Units**: `celsius` (temperature-sensor) and `percent` (battery), the ones
  the core lists for these categories; none on the opening sensor and the
  buttons.
- **No discovery in v1** (Home Assistant finds the gateway by DHCP host name
  or HomeKit; Gladys' `scanNetwork` would need a manifest capture): Milestone 3.
- **The store validator** (`npx github:GladysAssistant/integration-store .`)
  cannot be run from the agent session: to run by the publication step.
