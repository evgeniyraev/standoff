# PC Application — BLE Integration Guide

This document tells the PC application developers what to implement so the app connects to the quiz-buzzer device per `requirements.md`. It assumes familiarity with BLE central-role concepts (scanning, GATT, pairing) but not with this specific device.

### 1. Device identity and discovery

The device exposes a single custom GATT service using the Nordic UART Service (NUS) UUIDs:

| Role | UUID |
|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX (write commands to device) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX (receive events from device) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

Scan filtered by the **service UUID**, not by device name — the firmware advertises the 128-bit service UUID in the advertisement packet, which is the reliable way to find it regardless of what the device's advertised local name ends up being.

> **Open item:** the exact advertised local name isn't finalized yet — confirm with firmware before you hardcode a name-based filter. Filtering by service UUID avoids depending on it at all.

### 2. Connection lifecycle

1. **Scan** for an advertisement containing the service UUID above.
2. **Connect** to the device.
3. **Discover services/characteristics** and locate RX/TX by UUID (don't assume handle numbers — they aren't stable across firmware builds).
4. **Pair.** See §3 below — do this before attempting to write RX or subscribe to TX, since both characteristics require an encrypted link.
5. **Subscribe to TX indications** (write `0x0002` to the TX characteristic's CCCD to enable Indicate). Your BLE library should surface confirmed indications as they arrive; most libraries send the required confirmation back to the device automatically once you've subscribed and the indication is delivered to your callback — check whether your library does this for you or requires an explicit confirm call.
6. **Write commands to RX using Write With Response**, not Write Without Response — the response is how you know the device actually got the command (e.g. `START`).
7. App is now ready to send `START` and receive `BTN:<id>:<seq>` events.

### 3. Pairing and bonding

The device uses **Just Works pairing with bonding**, no passkey or confirmation dialog on either side.

- **Trigger:** because RX/TX are marked as requiring an encrypted link, most OS Bluetooth stacks will initiate pairing automatically the first time you write to RX or subscribe to TX. Don't rely on this being silent everywhere, though — see the platform notes below.
- **Bonding is one-time per PC.** Once paired, the OS stores the long-term key (LTK) and reuses it on every future reconnect — you do not re-pair on every connection, and your app does not need to manage keys itself.
- **Are the bonding keys generated at compile time? No.** Nothing is baked into the firmware image. The LTK is generated dynamically, during the pairing handshake, the first time a given PC connects — it's a fresh key negotiated between that specific device and that specific PC's Bluetooth adapter, then stored persistently (NVS on the ESP32, the OS's own Bluetooth keystore on the PC). A different PC pairing with the same device gets its own independent key. This also means:
  - If you reflash the ESP32's firmware in a way that erases its NVS partition, the device loses its bond and the PC must re-pair (the PC's own OS-side entry will otherwise look "bonded" while the device no longer recognizes it — that shows up as a connection that succeeds but is then rejected/dropped when an encrypted operation is attempted).
  - If the PC's OS forgets/removes the Bluetooth pairing (user action, OS reinstall, etc.), the same asymmetry applies in reverse.

#### Bond-reset / recovery procedure

When the two sides disagree about the bond, the symptom is: the connection itself succeeds, but any encrypted operation (subscribing to TX, writing RX) fails or the link drops immediately after. Recovery requires clearing **both** sides — clearing only one reproduces the same mismatch from the other direction.

- **Device side:** holding both physical buttons for 3 seconds during power-up erases the device's stored bond. The device confirms this by flashing both LEDs a few times, then boots normally with no bond, ready to pair again.
- **PC side:** the app cannot fix this on its own — the operator needs to remove/forget the device from the OS's Bluetooth settings (Windows/macOS: Settings UI; Linux: `bluetoothctl remove <MAC>` can be scripted if your app manages pairing itself via BlueZ). There is no cross-platform API for a regular application to silently drop a bond from the OS keystore, so plan for this as a manual troubleshooting step in your setup/support documentation, not something the app resolves automatically.
- Once both sides are cleared, the next connection attempt re-runs ordinary first-time Just Works pairing (§3) — no special handling needed on the app's part beyond what it already does for a first-ever connection.

If your app wants to detect this condition rather than just timing out, watch for: connection succeeds, but the subsequent encrypted GATT operation (subscribe/write) fails or the peripheral disconnects shortly after — that combination is the signature of a bond mismatch rather than a normal RF/range issue.

### 4. Platform notes

- **Windows:** pairing with a Just Works, no-I/O device is generally handled silently by the OS Bluetooth stack when your app connects and performs an operation requiring encryption. If using WinRT (`Windows.Devices.Bluetooth`), the `DevicePairingKinds.ConfirmOnly` path may still surface a system prompt on first pair — expect and handle this once, not per-connection.
- **macOS:** Core Bluetooth handles Just Works pairing transparently at the OS level; your app doesn't see a pairing step directly, it just sees the GATT operation succeed once the OS has paired in the background.
- **Linux (BlueZ):** BlueZ requires a **pairing agent** to be registered for non-interactive Just Works pairing to succeed — without one, a pairing request with no agent can stall or be rejected. Register an agent with `NoInputNoOutput` capability (via `bluetoothctl agent NoInputNoOutput` for manual testing, or via the D-Bus `org.bluez.Agent1` interface if pairing is driven from the app itself).
- Regardless of platform, **subscription state (CCCD) is not guaranteed to persist across reconnects** even for a bonded device, depending on the stack. Re-subscribe to TX indications defensively after every reconnect rather than assuming the subscription survived.

### 5. Single-connection behavior

The device only accepts one BLE connection at a time, enforced in firmware (max-connections = 1), and it stops advertising while a connection is active. This means:

- Only one PC (or one instance of your app, or a phone running nRF Connect) can be connected at once — a second connection attempt will simply fail to find the device advertising, or be rejected outright.
- If you're debugging with nRF Connect and forget to disconnect it, your app won't be able to connect until you do — this is expected, not a bug.
- No app-side coordination is needed to prevent multiple PCs from controlling the device simultaneously; it's not possible at the protocol level.

### 6. Reconnection behavior

The device is designed to be always connected, and continues monitoring for a button press and holding the result even while disconnected (see `requirements.md`). The PC app should match this:

- Maintain a persistent connection to the paired device by its address, and auto-reconnect on disconnect rather than requiring a manual "connect" action each time.
- On every (re)connection, re-subscribe to TX indications (§4) before assuming you'll receive events.
- Because the device holds a pending result across a disconnect, expect a `BTN:<id>:<seq>` indication to arrive immediately after reconnecting if a round resolved while the link was down — this is normal, not a duplicate.

### 7. Message handling

Messages are short ASCII text. Each GATT write or indicate is already a discrete, length-bounded message, so a trailing newline isn't required for framing — the device treats each write as one complete command and trims a trailing `\n` if you send one, but you don't need to add it yourself (useful in practice since tools like nRF Connect don't append one for you).

- `START` — app → device, begins a round.
- `BTN:<id>:<seq>` — device → app, `<id>` is `1` or `2`, `<seq>` is an incrementing counter. Use `<seq>` to detect duplicate or missed events (e.g. after a reconnect); don't assume every value is a new round if you've already processed it.
- `STATE:<name>` — device → app, state changes (exact set of state names to be confirmed with firmware).
- `PING` — app → device, sent every 2000ms **only while the device is in the waiting-for-game-start state**. On receipt, the device flashes both LEDs on at 80% brightness for 100ms as a visual connection-alive indicator for the people running the game. Stop sending `PING` once a round starts (after `START`) and resume once the device returns to waiting-for-game-start after the cool-down — sending it during an active round has no defined effect and just adds needless traffic, since the device suppresses the flash outside the waiting state anyway.

Treat a `BTN` message as delivered only once your BLE library reports the indication as confirmed — that confirmation is what allows the device to stop holding it as "pending."

### 8. Testing before the app exists

Since the device uses standard NUS UUIDs, you can validate it's advertising and behaving correctly using a generic BLE tool (e.g. nRF Connect on a phone) before any PC app code is written — connect, pair, subscribe to TX, write `START` to RX, and confirm indications arrive.

### 9. Suggested libraries

- Python: `bleak` (cross-platform, supports Indicate and Write With Response).
- Node.js: `@abandonware/noble` (Linux/macOS; Windows support is more limited — check current status before committing to it there).
- .NET: `Windows.Devices.Bluetooth` (Windows-only).
- If the PC app needs to be cross-platform, `bleak` is the most consistently maintained option across Windows/macOS/Linux as of this writing.
