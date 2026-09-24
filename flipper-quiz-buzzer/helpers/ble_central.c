#include "ble_central.h"

#include <furi.h>

#define TAG "QuizBuzzerBle"

// How often the lifecycle state machine is serviced.
#define BLE_TICK_PERIOD_MS 100
// If pairing/subscribing does not complete within this window after a
// successful connect, treat it as a bond mismatch (§3): the connection came up
// but the encrypted operation never succeeded.
#define BLE_ENCRYPTED_OP_TIMEOUT_MS 4000
// Back-off before retrying a failed/dropped connection (§6 auto-reconnect).
#define BLE_RECONNECT_DELAY_MS 1500

struct BleCentral {
    BleCentralCallback callback;
    void* context;

    FuriMutex* mutex;
    FuriTimer* tick;

    BleState state;
    bool running;

    uint32_t state_entered_tick; // furi_get_tick() when current state was entered
    uint32_t last_seq; // last BTN seq delivered upstream (dedup, §7)
    bool have_last_seq;
};

const char* ble_state_str(BleState s) {
    switch(s) {
    case BleStateIdle: return "Idle";
    case BleStateScanning: return "Scanning";
    case BleStateConnecting: return "Connecting";
    case BleStateDiscovering: return "Discovering";
    case BleStatePairing: return "Pairing";
    case BleStateSubscribing: return "Subscribing";
    case BleStateReady: return "Ready";
    case BleStateBondMismatch: return "Bond mismatch";
    case BleStateError: return "Error";
    default: return "?";
    }
}

// ---------------------------------------------------------------------------
// Radio HAL hooks.
//
// These are the ONLY places that talk to the BLE stack. They must be wired to
// the target firmware's GATT-central API. Each returns a tri-state so the state
// machine can advance, wait, or fail. Mainline Flipper firmware does not expose
// a general GATT client; on such builds these stay stubbed and the app reports
// BleStateError("central unavailable"). On a fork that adds central support,
// implement these against it — the state machine above needs no changes.
// ---------------------------------------------------------------------------
typedef enum {
    HalPending, // operation still in progress, call again next tick
    HalDone, // operation completed successfully
    HalFailed, // operation failed
} HalResult;

// Set to true once a fork's GATT-central API is wired into the hooks below.
#ifndef QUIZ_BUZZER_BLE_CENTRAL_AVAILABLE
#define QUIZ_BUZZER_BLE_CENTRAL_AVAILABLE 0
#endif

#if QUIZ_BUZZER_BLE_CENTRAL_AVAILABLE

// TODO(firmware): implement against the fork's central API.
//  - hal_scan_connect: scan filtered by NUS_SERVICE_UUID (§1, never by name),
//    connect on match, and stop when link-layer connected.
//  - hal_discover: resolve RX/TX handles by NUS_RX/TX_CHAR_UUID (§2.3).
//  - hal_pair: drive Just Works bonding, reusing a stored LTK if present (§3).
//  - hal_subscribe: write NUS_CCCD_INDICATE to the TX CCCD and ensure the stack
//    auto-confirms indications so BTN can be treated as delivered (§7).
//  - hal_write: Write With Response to RX (§2.6); returns HalFailed if no resp.
//  - hal_poll_rx: drain any received TX indication into `out`; returns HalDone
//    when a message was produced, HalPending when none pending.
static HalResult hal_scan_connect(void);
static HalResult hal_discover(void);
static HalResult hal_pair(void);
static HalResult hal_subscribe(void);
static HalResult hal_write(const char* payload);
static HalResult hal_poll_rx(NusMessage* out);
static bool hal_is_connected(void);
static void hal_teardown(void);
#error "Wire the QUIZ_BUZZER_BLE_CENTRAL_AVAILABLE hooks to your firmware's GATT-central API, then remove this #error."

#else // Central role not available on this firmware build.

static HalResult hal_scan_connect(void) {
    return HalFailed;
}
static HalResult hal_discover(void) {
    return HalFailed;
}
static HalResult hal_pair(void) {
    return HalFailed;
}
static HalResult hal_subscribe(void) {
    return HalFailed;
}
static HalResult hal_write(const char* payload) {
    UNUSED(payload);
    return HalFailed;
}
static HalResult hal_poll_rx(NusMessage* out) {
    UNUSED(out);
    return HalPending;
}
static bool hal_is_connected(void) {
    return false;
}
static void hal_teardown(void) {
}

#endif

// ---------------------------------------------------------------------------
// State machine (firmware-independent).
// ---------------------------------------------------------------------------

static void ble_emit(BleCentral* c, const BleEvent* ev) {
    if(c->callback) c->callback(ev, c->context);
}

static void ble_set_state(BleCentral* c, BleState s) {
    if(c->state == s) return;
    c->state = s;
    c->state_entered_tick = furi_get_tick();
    FURI_LOG_I(TAG, "state -> %s", ble_state_str(s));
    BleEvent ev = {.type = BleEventStateChanged, .state = s};
    ble_emit(c, &ev);
}

static uint32_t ms_in_state(const BleCentral* c) {
    return furi_get_tick() - c->state_entered_tick;
}

// Deliver a parsed message upstream, applying BTN seq dedup (§7).
static void ble_deliver(BleCentral* c, const NusMessage* msg) {
    if(msg->type == NusMsgButton) {
        if(c->have_last_seq && msg->seq == c->last_seq) {
            FURI_LOG_D(TAG, "drop duplicate BTN seq=%lu", (unsigned long)msg->seq);
            return;
        }
        c->last_seq = msg->seq;
        c->have_last_seq = true;
    }
    BleEvent ev = {.type = BleEventMessage, .message = *msg};
    ble_emit(c, &ev);
}

// Drain any pending inbound messages regardless of state (a held BTN can arrive
// immediately after reconnect, §6).
static void ble_pump_rx(BleCentral* c) {
    NusMessage msg;
    for(int guard = 0; guard < 8; guard++) {
        HalResult r = hal_poll_rx(&msg);
        if(r != HalDone) break;
        ble_deliver(c, &msg);
    }
}

static void ble_handle_disconnect(BleCentral* c) {
    hal_teardown();
    BleEvent ev = {.type = BleEventDisconnected};
    ble_emit(c, &ev);
    // §6: auto-reconnect rather than requiring a manual action. Go back to
    // scanning after a short back-off (handled by time-in-state on Idle).
    ble_set_state(c, BleStateIdle);
}

static void ble_tick(void* ctx) {
    BleCentral* c = ctx;
    furi_mutex_acquire(c->mutex, FuriWaitForever);
    if(!c->running) {
        furi_mutex_release(c->mutex);
        return;
    }

    // Once we're past connection, a link drop at any point routes through the
    // reconnect path (§6).
    if(c->state >= BleStateDiscovering && c->state <= BleStateReady && !hal_is_connected()) {
        ble_handle_disconnect(c);
        furi_mutex_release(c->mutex);
        return;
    }

    switch(c->state) {
    case BleStateIdle:
        if(ms_in_state(c) >= BLE_RECONNECT_DELAY_MS) {
            ble_set_state(c, BleStateScanning);
        }
        break;

    case BleStateScanning:
    case BleStateConnecting: {
        HalResult r = hal_scan_connect();
        if(r == HalDone) {
            ble_set_state(c, BleStateDiscovering);
        } else if(r == HalFailed) {
            ble_set_state(c, BleStateError);
        }
        break;
    }

    case BleStateDiscovering: {
        HalResult r = hal_discover();
        if(r == HalDone) {
            ble_set_state(c, BleStatePairing);
        } else if(r == HalFailed) {
            ble_set_state(c, BleStateError);
        }
        break;
    }

    case BleStatePairing: {
        HalResult r = hal_pair();
        if(r == HalDone) {
            ble_set_state(c, BleStateSubscribing);
        } else if(r == HalFailed || ms_in_state(c) >= BLE_ENCRYPTED_OP_TIMEOUT_MS) {
            // §3: connected but the encrypted operation won't complete -> the
            // two sides disagree about the bond. Surface it distinctly so the
            // operator knows to run the bond-reset procedure (both sides).
            ble_set_state(c, BleStateBondMismatch);
        }
        break;
    }

    case BleStateSubscribing: {
        // §4/§6: always (re)subscribe after connect; never assume it persisted.
        HalResult r = hal_subscribe();
        if(r == HalDone) {
            ble_set_state(c, BleStateReady);
        } else if(r == HalFailed || ms_in_state(c) >= BLE_ENCRYPTED_OP_TIMEOUT_MS) {
            ble_set_state(c, BleStateBondMismatch);
        }
        break;
    }

    case BleStateReady:
        ble_pump_rx(c);
        break;

    case BleStateBondMismatch:
    case BleStateError:
        // Terminal-ish: retry the whole lifecycle after a back-off (§6). The
        // operator may need to clear bonds first, but a bare retry is harmless.
        if(ms_in_state(c) >= BLE_RECONNECT_DELAY_MS) {
            hal_teardown();
            ble_set_state(c, BleStateIdle);
        }
        break;

    default:
        break;
    }

    furi_mutex_release(c->mutex);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

BleCentral* ble_central_alloc(BleCentralCallback callback, void* context) {
    BleCentral* c = malloc(sizeof(BleCentral));
    c->callback = callback;
    c->context = context;
    c->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    c->tick = furi_timer_alloc(ble_tick, FuriTimerTypePeriodic, c);
    c->state = BleStateIdle;
    c->running = false;
    c->state_entered_tick = furi_get_tick();
    c->last_seq = 0;
    c->have_last_seq = false;
    return c;
}

void ble_central_free(BleCentral* c) {
    if(!c) return;
    ble_central_stop(c);
    furi_timer_free(c->tick);
    furi_mutex_free(c->mutex);
    free(c);
}

void ble_central_start(BleCentral* c) {
    furi_mutex_acquire(c->mutex, FuriWaitForever);
    if(!c->running) {
        c->running = true;
        c->have_last_seq = false;
        ble_set_state(c, BleStateScanning);
        furi_timer_start(c->tick, furi_ms_to_ticks(BLE_TICK_PERIOD_MS));
    }
    furi_mutex_release(c->mutex);
}

void ble_central_stop(BleCentral* c) {
    furi_mutex_acquire(c->mutex, FuriWaitForever);
    if(c->running) {
        c->running = false;
        furi_timer_stop(c->tick);
        hal_teardown();
        ble_set_state(c, BleStateIdle);
    }
    furi_mutex_release(c->mutex);
}

bool ble_central_send_start(BleCentral* c) {
    bool ok = false;
    furi_mutex_acquire(c->mutex, FuriWaitForever);
    if(c->state == BleStateReady) {
        ok = hal_write(NUS_CMD_START) == HalDone; // Write With Response (§2.6)
    }
    furi_mutex_release(c->mutex);
    return ok;
}

bool ble_central_send_ping(BleCentral* c) {
    bool ok = false;
    furi_mutex_acquire(c->mutex, FuriWaitForever);
    if(c->state == BleStateReady) {
        ok = hal_write(NUS_CMD_PING) == HalDone;
    }
    furi_mutex_release(c->mutex);
    return ok;
}

BleState ble_central_state(const BleCentral* c) {
    return c->state;
}
