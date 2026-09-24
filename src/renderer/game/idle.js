// Fallback for players walking away mid-game: if no touch and no buzzer press
// arrives for `timeoutSeconds` while a game is running, go back to the start
// screen.
//
// pause(reason) / resume(reason) suspend the watchdog. Nothing calls them yet;
// they exist for a planned "hold for photo" indicator on the win screen
// (see the comment in view.js → winScreen and docs/ARCHITECTURE.md).

export class IdleWatchdog {
  constructor(onIdle) {
    this.onIdle = onIdle;
    this.timeoutMs = 30_000;
    this.active = false;
    this.pausedBy = new Set();
    this.lastActivity = Date.now();
    setInterval(() => this.check(), 1000);
  }

  configure(seconds) {
    this.timeoutMs = seconds * 1000;
  }

  poke() {
    this.lastActivity = Date.now();
  }

  setActive(active) {
    if (active && !this.active) this.poke();
    this.active = active;
  }

  pause(reason) {
    this.pausedBy.add(reason);
  }

  resume(reason) {
    this.pausedBy.delete(reason);
    this.poke();
  }

  check() {
    if (!this.active || this.pausedBy.size) return;
    if (Date.now() - this.lastActivity >= this.timeoutMs) {
      this.poke();
      this.onIdle();
    }
  }
}
