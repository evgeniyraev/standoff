// Settings window: the shared settings UI over Electron IPC.

import '../browser-shim.js';
import { mountSettings } from '../../shared/settings-ui/settings-ui.js';

const api = { ...window.standoff, local: true };

mountSettings(document.getElementById('app'), api, { title: 'Standoff settings' });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('.sx-dialog')) api.command('settings:close');
});
