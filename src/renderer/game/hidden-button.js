// Invisible operator button in a screen corner.
//   double tap          → onDoubleTap (fallback: back to the start screen)
//   hold holdSeconds    → onHold (open settings)
// A faint progress ring appears after 2 s of holding so the operator knows
// the hold is registering; it is invisible otherwise.

const SHOW_PROGRESS_AFTER_MS = 2000;
const TAP_MAX_MS = 350;

export function mountHiddenButton(el, { onDoubleTap, onHold }) {
  let cfg = { holdSeconds: 10, doubleTapMs: 400, hiddenCorner: 'top-right', hiddenSize: 100 };
  let holdTimer = null;
  let raf = null;
  let downAt = 0;
  let lastTapAt = 0;

  function stopHold() {
    clearTimeout(holdTimer);
    cancelAnimationFrame(raf);
    holdTimer = null;
    el.style.setProperty('--hold', '0');
    el.classList.remove('holding');
  }

  function animate() {
    const elapsed = performance.now() - downAt;
    if (elapsed > SHOW_PROGRESS_AFTER_MS) el.classList.add('holding');
    el.style.setProperty('--hold', String(Math.min(1, elapsed / (cfg.holdSeconds * 1000))));
    raf = requestAnimationFrame(animate);
  }

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    downAt = performance.now();
    holdTimer = setTimeout(() => {
      stopHold();
      downAt = 0;
      onHold();
    }, cfg.holdSeconds * 1000);
    raf = requestAnimationFrame(animate);
  });

  const release = () => {
    if (!downAt) return;
    const pressed = performance.now() - downAt;
    downAt = 0;
    stopHold();
    if (pressed > TAP_MAX_MS) return;
    const now = performance.now();
    if (now - lastTapAt <= cfg.doubleTapMs) {
      lastTapAt = 0;
      onDoubleTap();
    } else {
      lastTapAt = now;
    }
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', () => {
    downAt = 0;
    stopHold();
  });

  return {
    configure(kiosk) {
      cfg = kiosk;
      el.dataset.corner = kiosk.hiddenCorner;
      el.style.width = el.style.height = `${kiosk.hiddenSize}px`;
    },
  };
}
