# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- ismartgate (PRO, LITE, Mini) and GogoGate2 gateways over their local API,
  without the cloud: one gateway by IP address, with the user name and the
  password of its app; the request envelope of the ismartgate library (MIT)
  ported to JavaScript.
- One Gladys device per door set up on the gateway: opening sensor (read
  only), temperature and battery of the wireless sensor, open and close
  buttons (garage door and pulse modes only). A door is never a switch.
- Opening is off by default ("Allow opening"), checked on arrival, after the
  fresh read and right before sending. Every pulse is decided on the state
  read just now: open only from closed, close only from open, nothing on an
  unknown state, the gateway's id checked before every command.
- Closing ignores the option, the queue of the openings, a 429/5xx pause and
  a refused-credentials stop (one try), and cancels at once an opening of the
  same door not sent yet.
- One pulse at a time per door, then a guard until the door is read in the
  other state or the travel time (configurable, 30 s by default) plus 5 s.
- Commands sent within 3.5 s or refused unsent, "sent, without confirmation"
  when no answer came back.
- Credentials refused: a stop persisted in `/data`, tried again after 15 min,
  1 h, 6 h then every 24 h, lifted by other credentials; HTTP 429 or 5xx: a
  pause of 1 min to 6 h; other failures: spaced reads, never faster than the
  refresh interval, a restart included (time of the last read in `/data`).
- "Test the connection" button; reachability on the transport badge; states
  within the Gladys rate limit, measurements spaced by a minute.

[Unreleased]: https://github.com/LM1LC3N7/gladys-ismartgate/commits/main
