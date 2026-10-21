# ismartgate for Gladys Assistant

This integration shows in Gladys the garage doors and gates driven by an
**ismartgate** (PRO, LITE, Mini) or **GogoGate2** gateway, and adds buttons to
open and close them, through the local API of the gateway, on your network,
without its cloud.

**Never tested with a real device**: the integration follows the ismartgate
library (the one of the Home Assistant "Gogogate2 and ismartgate"
integration), but nobody has tried it on a real gateway yet. This local API is
not documented by the maker. Your feedback is welcome.

Unofficial integration, not affiliated with ismartgate.

## In Gladys

One device per door set up on the gateway (a door that has a name in its
app):

| Feature           | Detail                                                    |
| ----------------- | --------------------------------------------------------- |
| Garage door, Gate | opening sensor, read only (open / closed)                 |
| Open, Close       | buttons (only for an output in garage door or pulse mode) |
| Temperature       | wireless sensor only                                      |
| Sensor battery    | in %, wireless sensor only                                |

## Installation

1. Give the gateway a fixed IP address in your router.
2. In the ismartgate app, preferably create a user for Gladys, with only the
   doors it may command.
3. In Gladys, install the ismartgate integration from the store, pick the
   family (ismartgate or GogoGate2), type the IP address, the user name and
   the password.
4. Add the doors from the Discovery tab.

The password is kept by Gladys in its database, never shown again, sent only
to your gateway. The local API carries it scrambled (AES) in the address of
the request, over HTTP: on an ismartgate the key comes from the user name and
the password, but on a **GogoGate2 the key is the same for every gateway and
public**: anyone who captures the traffic of your local network can read the
user name and the password. Use a dedicated user, with a password you use
nowhere else.

## Command safety

The gateway only knows one command: **a pulse** on the relay of the door, the
same to open and to close, like the button of a remote control. A pulse while
the door moves may stop it or send it back. So:

- a door is never a switch: a "turn everything off" of a voice assistant or a
  scene cannot reach it;
- **opening is off by default**: turn on "Allow opening" so that the
  dashboard, the scenes and the voice assistants can open. The permission is
  checked when the command arrives, after the fresh read and right before
  sending;
- every command reads the gateway just before acting: the gateway must be the
  same one (its id), the door set up, in garage door or pulse mode, with a
  known state. "Open" only pulses a door read closed, "Close" only a door read
  open; in the wanted state, nothing is sent; with no state (sensor missing
  or faulty), nothing is sent;
- **closing is always allowed**: without the permission, even during a pause
  asked by the gateway or after refused credentials (one try), and a close
  cancels at once an opening of the same door not sent yet;
- one pulse at a time per door, and after each pulse no other one on that
  door until it is read in the other state, or until the "travel time" (30 s
  by default) plus 5 s has passed;
- a command that cannot leave within 3.5 seconds is refused unsent; a pulse
  sent without an answer is reported "sent, without confirmation", then the
  door is read again.

**Limit**: the gateway does not say whether a door is closing (the sensor
stays "open" until the end of the travel). If someone has just started closing
with a remote and a close leaves Gladys at the same moment, the pulse may stop
the door or send it back towards opening, as a second press on the remote
would. Gladys never does it twice in a row itself (the guard above).

There is no "Stop" button: the gateway has no stop command.

## Failures

- Credentials refused: the gateway is no longer asked, then again after
  15 min, 1 h, 6 h and every 24 h, even after a restart; saving other
  credentials tries again at once, "Test the connection" once the refresh
  interval has passed.
- A gateway that asks to wait (HTTP 429 or 5xx) is paused for one minute to
  six hours, even after a restart: no read, no opening; closing stays
  possible.
- A gateway that does not answer is read again after 30 s, 1, 2 then 5 min,
  never faster than the refresh interval. "Test the connection", a
  reconnection of Gladys or a restart never read faster than the interval.
- If another gateway answers at the address (DHCP lease), its doors show up
  in the Discovery tab and the old ones are shown unreachable.

## Limits

- No automatic search on the network: type the IP address.
- No camera, no outputs in on/off mode (shown read only), no access through
  the ismartgate cloud.
