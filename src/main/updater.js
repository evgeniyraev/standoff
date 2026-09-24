// Auto-update through GitHub Releases (electron-updater). Updates download in
// the background and are installed silently — then the app relaunches — as
// soon as the kiosk is on the start screen, so a game is never interrupted.
// "Install now" from the settings/admin forces the install once downloaded.

import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 30 * 60 * 1000;

export function createUpdater({ isPackaged, getGameScreen, report }) {
  let status = { state: isPackaged ? 'idle' : 'disabled', version: null, progress: null, error: null };
  let force = false;
  const set = (patch) => {
    status = { ...status, ...patch };
    report(status);
  };

  if (!isPackaged) {
    report(status);
    const devOnly = () => set({ error: 'Updates are disabled in development builds' });
    return { check: devOnly, install: devOnly, onGameScreen: () => {} };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'up-to-date' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ state: 'downloaded', version: info.version, progress: 100 });
    maybeInstall();
  });
  autoUpdater.on('error', (err) => set({ state: 'error', error: String(err?.message ?? err) }));

  function check() {
    autoUpdater.checkForUpdates().catch((err) => set({ state: 'error', error: String(err?.message ?? err) }));
  }

  function maybeInstall() {
    if (status.state !== 'downloaded') return;
    if (!force && getGameScreen() !== 'start') return; // wait for an idle kiosk
    set({ state: 'installing' });
    // isSilent = true (no NSIS UI), isForceRunAfter = true (relaunch after install)
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);

  return {
    check,
    install() {
      force = true;
      if (status.state === 'downloaded') maybeInstall();
      else check(); // installs as soon as the download finishes
    },
    onGameScreen: maybeInstall,
  };
}
