# Quiz Buzzer — Flipper Zero app

A Flipper Zero application (`.fap`) that acts as the **BLE central** for the
quiz-buzzer device, implementing the integration described in
[`pc-app-ble-integration.md`](../pc-app-ble-integration.md). It replaces the
"PC app" in that document: the Flipper scans for the device, pairs, keeps a
persistent link, sends `START`/`PING`, and displays incoming `BTN` events.

## Pairing mode

On start the app asks how the host will pair (Up/Down to choose, OK to
confirm, Back to exit):

| Choice | Pairing | Use for |
|---|---|---|
| Host without display | Just Works (encryption only) | The PC app, which accepts pairing in code |
| Host with display | PIN: the Flipper shows a 6-digit code to type or confirm on the host; links must be authenticated (MITM) | Phones / PCs pairing through the OS dialog |

Each mode uses its own BLE address and its own bond store, so a host treats
them as two different devices and a Just Works bond is never reused for PIN
mode. After pairing, the app behaves the same in both modes.

## Controls

| Key  | Action                                             |
|------|----------------------------------------------------|
| OK   | Send `START` (begins a round)                      |
| Back | Exit                                               |

`PING` is sent automatically every 2000 ms while the device is in the
waiting-for-game-start phase, and suppressed during an active round (§7).

## How it maps to the spec

| Spec section | Where it's implemented |
|---|---|
| §1 Discovery by **service UUID** (not name) | `helpers/nus_protocol.h` UUIDs; scan filter is applied in the HAL scan hook |
| §2 Lifecycle scan→connect→discover→pair→subscribe→write | State machine in `helpers/ble_central.c` (`BleState*`) |
| §3 Just Works + bonding, **bond-mismatch detection** | `BleStatePairing`/`BleStateSubscribing` timeout → `BleStateBondMismatch` |
| §6 Persistent link, **auto-reconnect**, defensive re-subscribe | Auto back-off + always re-run `hal_subscribe` on (re)connect |
| §7 `START`/`PING`/`BTN`/`STATE`, **seq dedup**, PING gating | `helpers/nus_protocol.c` parser; dedup in `ble_deliver`; PING gating in `quiz_buzzer_app.c` |

Write With Response is used for RX commands (§2.6); TX is subscribed with CCCD
`0x0002` = Indicate (§2.5); duplicate `BTN:<id>:<seq>` events (e.g. a held
result replayed after reconnect, §6) are dropped by sequence number.

## Important: BLE central role support

The Flipper's radio is normally used as a BLE **peripheral**. This app needs the
**central/GATT-client** role (scanning, connecting, discovering, pairing as
initiator). Mainline Flipper firmware does **not** expose a general GATT-client
API, so the radio operations are isolated behind a small hook table in
`helpers/ble_central.c`:

```c
#define QUIZ_BUZZER_BLE_CENTRAL_AVAILABLE 0   // set to 1 once wired to a fork
```

- With it `0` (default), the whole app — GUI, protocol parsing, seq-dedup,
  PING/START gating, the full lifecycle state machine — builds and runs, but the
  radio hooks report failure, so the link stays in `Scanning`/`Error`. This lets
  you develop and test everything except the radio.
- To make it connect for real, implement the six `hal_*` hooks against a
  firmware build that provides central-role GATT (see the `TODO(firmware)`
  block), then set the flag to `1`. The state machine above needs no changes.

The pure protocol layer (`helpers/nus_protocol.c`) is firmware-independent and
covered by a host unit test (12 cases, all passing).

## Build

Using the Flipper build tool (`ufbt`) — recommended for a single external app:

```bash
python3 -m pip install --upgrade ufbt
cd flipper-quiz-buzzer
ufbt            # build quiz_buzzer.fap
ufbt launch     # build, upload, and start on a connected Flipper
```

Or inside a full firmware tree, drop this folder under
`applications_user/quiz_buzzer` and run:

```bash
./fbt fap_quiz_buzzer
```

## Testing without the device (§8)

Because the device uses standard NUS UUIDs, you can validate the device
independently with nRF Connect on a phone before relying on the Flipper's radio
hooks — connect, pair, subscribe to TX, write `START`, and confirm `BTN`
indications arrive. Remember the device accepts only one connection at a time
(§5): disconnect nRF Connect before the Flipper can connect.

## Notes / open items carried from the spec

- The waiting-for-game-start `STATE:<name>` value is TBD with firmware (§7).
  `state_is_waiting()` in `quiz_buzzer_app.c` matches a few likely names
  case-insensitively (`WAITING`, `WAIT`, `IDLE`, `READY`, `LOBBY`); update it
  once the firmware's state names are confirmed.
- Bond reset is a manual procedure on both sides (§3): hold both device buttons
  for 3 s at power-up; on the Flipper, clear the stored bond via its Bluetooth
  settings. The app surfaces the mismatch as the `Bond mismatch` link state.
