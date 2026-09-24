# Standoff

A two-player buzzer quiz for a portrait touchscreen kiosk on Windows. Players race to press their Bluetooth buzzer, answer on the touchscreen, and the first to 2 points wins.

- **Kiosk app:** Electron, fullscreen, starts with Windows, auto-updates from GitHub Releases.
- **Settings:** press Ctrl + `,`, or hold the hidden corner button for 10 s. Double-tapping the hidden button returns to the start screen.
- **Questions:** edit them in settings, or drop an Excel file with columns `Question | A | B | C | D | Correct`.
- **Admin page:** published to GitHub Pages. It joins the kiosk over WebRTC and mirrors all of its settings.

## Quick start

```bash
npm install
npm run dev
npm test
```

`npm run dev` opens the game in a 540×960 window; keys `1` and `2` act as the buzzers.

## Release

```bash
git tag v1.0.0
git push origin v1.0.0
```

Pushing the tag triggers GitHub Actions, which builds `Standoff-Setup-1.0.0.exe` and publishes the release. Kiosks then update themselves.

One-time setup (repository Settings):

- **Pages:** set the source to "GitHub Actions".
- **Actions variable** `STANDOFF_ROOM` and **secret** `STANDOFF_PIN`: the admin room and PIN baked into the builds.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how everything fits together, the configuration, game rules, BLE, WebRTC admin, the release pipeline, code signing, a deployment checklist and extension recipes.
- [pc-app-ble-integration.md](pc-app-ble-integration.md): the buzzer device's BLE protocol.
