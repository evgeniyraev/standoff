// CI step: bakes the admin room/PIN and build metadata into build-info.json,
// which electron-builder packs into the app (read by src/main/build-info.js).
import fs from 'node:fs';

const info = {
  room: process.env.STANDOFF_ROOM ?? '',
  pin: process.env.STANDOFF_PIN ?? '',
  commit: (process.env.GITHUB_SHA ?? 'local').slice(0, 7),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync('build-info.json', JSON.stringify(info, null, 2));
console.log(`build-info.json written (room: ${info.room ? 'set' : 'EMPTY'}, pin: ${info.pin ? 'set' : 'empty'}, commit ${info.commit})`);
