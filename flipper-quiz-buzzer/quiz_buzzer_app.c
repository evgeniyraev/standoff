/**
 * Quiz Buzzer — the Flipper Zero *is* the BLE quiz-buzzer device.
 *
 * The Flipper advertises the Nordic UART Service as NUS_ADV_NAME and a PC (per
 * pc-app-ble-integration.md) connects to it as the central. The Flipper's
 * Left/Right buttons are the two contestant buzzers.
 *
 *   PC -> Flipper (RX):  START (arm a round), PING (liveness -> LED flash)
 *   Flipper -> PC (TX):  BTN:<id>:<seq> (a player buzzed), STATE:<name>
 *
 * Controls: Left = Player 1, Right = Player 2, hold OK = forget bond, Back = exit.
 */
#include <furi.h>
#include <furi_hal_bt.h>
#include <gui/gui.h>
#include <input/input.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <bt/bt_service/bt.h>

#include "helpers/nus_profile.h"
#include "helpers/nus_protocol.h"

#define TAG "QuizBuzzer"

// Private bond store, so pairing the quiz PC leaves the Flipper's normal
// (phone) pairing alone.
#define QUIZ_KEYS_PATH APP_DATA_PATH(".bt_keys")

// After a buzz, show the winner this long before returning to waiting.
#define ROUND_COOLDOWN_MS 3000
// Service tick: retries a refused TX and re-sends an unconfirmed indication.
#define TICK_MS 250
#define INDICATION_TIMEOUT_MS 2000

#define OUTBOX_SIZE 6

typedef enum {
    PhaseWaiting, // waiting for START; the PC pings us here
    PhaseArmed, // round running; first buzz wins
    PhaseResolved, // a player buzzed; cooling down
} GamePhase;

typedef enum {
    EvtInput,
    EvtRx, // command written to RX
    EvtSubscribe, // TX indications enabled/disabled
    EvtConfirm, // PC confirmed the in-flight indication
    EvtBtStatus, // advertising / connected / off
    EvtCooldownDone,
    EvtTick,
} AppEventType;

typedef struct {
    AppEventType type;
    union {
        InputEvent input;
        NusCommand cmd;
        bool subscribed;
        BtStatus bt_status;
    };
} AppEvent;

typedef struct {
    bool is_button; // BTN results survive disconnects (§6); STATE is re-sent fresh
    uint8_t len;
    char data[NUS_TX_VALUE_MAX];
} OutMsg;

typedef struct {
    Gui* gui;
    ViewPort* view_port;
    FuriMessageQueue* queue;
    FuriMutex* mutex; // guards everything below that the draw callback reads
    FuriTimer* cooldown_timer;
    FuriTimer* tick_timer;
    NotificationApp* notifications;

    Bt* bt;
    FuriHalBleProfileBase* profile;

    BtStatus bt_status;
    bool subscribed;
    GamePhase phase;
    uint32_t seq; // BTN sequence counter (§7)
    uint8_t winner;
    bool winner_delivered; // PC confirmed the BTN indication (§7)

    // Outgoing indications, sent one at a time (the next waits for the PC's
    // confirmation of the previous).
    OutMsg outbox[OUTBOX_SIZE];
    size_t outbox_count;
    bool in_flight;
    uint32_t in_flight_since;
} QuizBuzzerApp;

// PING -> short white flash: the Flipper's single RGB LED stands in for the
// device's "both LEDs" connection-alive indicator (§7).
static const NotificationSequence sequence_ping = {
    &message_red_255,
    &message_green_255,
    &message_blue_255,
    &message_delay_100,
    &message_red_0,
    &message_green_0,
    &message_blue_0,
    NULL,
};

// ---------------------------------------------------------------------------
// Outbox (app thread only, mutex held)
// ---------------------------------------------------------------------------
static void outbox_push(QuizBuzzerApp* app, bool is_button, const char* data, size_t len) {
    if(len == 0) return;
    if(app->outbox_count == OUTBOX_SIZE) {
        FURI_LOG_W(TAG, "outbox full, dropping %.*s", (int)len, data);
        return;
    }
    OutMsg* m = &app->outbox[app->outbox_count++];
    m->is_button = is_button;
    m->len = (uint8_t)len;
    memcpy(m->data, data, len);
}

static void outbox_pop(QuizBuzzerApp* app) {
    if(app->outbox_count == 0) return;
    memmove(&app->outbox[0], &app->outbox[1], (app->outbox_count - 1) * sizeof(OutMsg));
    app->outbox_count--;
}

// Stale STATE messages are pointless after a reconnect; BTN results are kept.
static void outbox_drop_states(QuizBuzzerApp* app) {
    size_t kept = 0;
    for(size_t i = 0; i < app->outbox_count; i++) {
        if(app->outbox[i].is_button) app->outbox[kept++] = app->outbox[i];
    }
    app->outbox_count = kept;
}

static void queue_state(QuizBuzzerApp* app, const char* name) {
    char buf[NUS_TX_VALUE_MAX];
    outbox_push(app, false, buf, nus_build_state(buf, sizeof(buf), name));
}

static const char* phase_state_name(GamePhase phase) {
    switch(phase) {
    case PhaseArmed: return NUS_STATE_ARMED;
    case PhaseResolved: return NUS_STATE_PRESSED;
    default: return NUS_STATE_WAITING;
    }
}

// Send the head of the outbox if the link can take it.
static void outbox_pump(QuizBuzzerApp* app) {
    if(app->in_flight || app->outbox_count == 0) return;
    if(app->bt_status != BtStatusConnected || !app->subscribed) return;
    const OutMsg* m = &app->outbox[0];
    if(nus_profile_tx(app->profile, (const uint8_t*)m->data, m->len)) {
        app->in_flight = true;
        app->in_flight_since = furi_get_tick();
    }
    // Refused (e.g. stack busy): the tick retries.
}

// ---------------------------------------------------------------------------
// GUI
// ---------------------------------------------------------------------------
static void quiz_draw(Canvas* canvas, void* ctx) {
    QuizBuzzerApp* app = ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 2, 11, "Quiz Buzzer");
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 126, 11, AlignRight, AlignBottom, "BLE: " NUS_ADV_NAME);
    canvas_draw_line(canvas, 0, 14, 128, 14);

    const char* link;
    switch(app->bt_status) {
    case BtStatusAdvertising: link = "Advertising..."; break;
    case BtStatusConnected: link = app->subscribed ? "PC connected" : "Connected, not subscribed"; break;
    case BtStatusOff: link = "Bluetooth is OFF"; break;
    default: link = "Bluetooth unavailable"; break;
    }
    canvas_draw_str(canvas, 2, 26, link);

    char line[40];
    switch(app->phase) {
    case PhaseWaiting:
        canvas_draw_str(canvas, 2, 38, "Waiting for START");
        break;
    case PhaseArmed:
        canvas_set_font(canvas, FontPrimary);
        canvas_draw_str(canvas, 2, 39, "ARMED - buzz!");
        canvas_set_font(canvas, FontSecondary);
        break;
    case PhaseResolved:
        snprintf(
            line,
            sizeof(line),
            "Player %u wins  #%lu %s",
            app->winner,
            (unsigned long)app->seq,
            app->winner_delivered ? "sent" : "pending");
        canvas_draw_str(canvas, 2, 38, line);
        break;
    }

    canvas_draw_str(canvas, 2, 62, "<P1  P2>  hold OK:unpair");
    furi_mutex_release(app->mutex);
}

// ---------------------------------------------------------------------------
// Callbacks from other threads: only post events
// ---------------------------------------------------------------------------
static void post(QuizBuzzerApp* app, const AppEvent* event) {
    furi_message_queue_put(app->queue, event, 0);
}

static void quiz_input_cb(InputEvent* input, void* ctx) {
    AppEvent e = {.type = EvtInput, .input = *input};
    post(ctx, &e);
}

static void nus_on_rx(const uint8_t* data, uint16_t len, void* ctx) {
    AppEvent e = {.type = EvtRx, .cmd = nus_parse_command(data, len)};
    if(e.cmd != NusCmdUnknown) post(ctx, &e);
}

static void nus_on_subscribe(bool enabled, void* ctx) {
    AppEvent e = {.type = EvtSubscribe, .subscribed = enabled};
    post(ctx, &e);
}

static void nus_on_confirm(void* ctx) {
    AppEvent e = {.type = EvtConfirm};
    post(ctx, &e);
}

static const NusProfileCallbacks nus_callbacks = {
    .on_rx = nus_on_rx,
    .on_subscribe = nus_on_subscribe,
    .on_confirm = nus_on_confirm,
};

static void bt_status_cb(BtStatus status, void* ctx) {
    AppEvent e = {.type = EvtBtStatus, .bt_status = status};
    post(ctx, &e);
}

static void cooldown_cb(void* ctx) {
    AppEvent e = {.type = EvtCooldownDone};
    post(ctx, &e);
}

static void tick_cb(void* ctx) {
    AppEvent e = {.type = EvtTick};
    post(ctx, &e);
}

// ---------------------------------------------------------------------------
// Event handling (app thread, mutex held)
// ---------------------------------------------------------------------------
static void on_buzz(QuizBuzzerApp* app, uint8_t player) {
    if(app->phase != PhaseArmed) return;
    app->phase = PhaseResolved;
    app->winner = player;
    app->winner_delivered = false;
    app->seq++;

    // Recorded even while disconnected; delivered on reconnect (§6).
    char buf[NUS_TX_VALUE_MAX];
    outbox_push(app, true, buf, nus_build_button(buf, sizeof(buf), player, app->seq));
    queue_state(app, NUS_STATE_PRESSED);
    furi_timer_start(app->cooldown_timer, furi_ms_to_ticks(ROUND_COOLDOWN_MS));
    notification_message(app->notifications, &sequence_single_vibro);
}

static void on_command(QuizBuzzerApp* app, NusCommand cmd) {
    if(cmd == NusCmdStart) {
        FURI_LOG_I(TAG, "START");
        furi_timer_stop(app->cooldown_timer);
        app->phase = PhaseArmed;
        app->winner = 0;
        queue_state(app, NUS_STATE_ARMED);
        notification_message(app->notifications, &sequence_single_vibro);
    } else if(cmd == NusCmdPing && app->phase == PhaseWaiting) {
        // §7: flash only while waiting for game start.
        notification_message(app->notifications, &sequence_ping);
    }
}

static void on_subscribe(QuizBuzzerApp* app, bool enabled) {
    FURI_LOG_I(TAG, "TX indications %s", enabled ? "on" : "off");
    app->subscribed = enabled;
    app->in_flight = false;
    if(enabled) {
        // §6: a held BTN goes out first, then our current state.
        outbox_drop_states(app);
        queue_state(app, phase_state_name(app->phase));
    }
}

static void on_confirm(QuizBuzzerApp* app) {
    if(!app->in_flight) return;
    app->in_flight = false;
    if(app->outbox_count > 0 && app->outbox[0].is_button) app->winner_delivered = true;
    outbox_pop(app);
}

static void on_bt_status(QuizBuzzerApp* app, BtStatus status) {
    FURI_LOG_I(TAG, "bt status %d", status);
    app->bt_status = status;
    if(status != BtStatusConnected) {
        // CCCD state does not survive a reconnect reliably (§4): wait for the
        // PC to subscribe again.
        app->subscribed = false;
        app->in_flight = false;
    }
}

static void on_tick(QuizBuzzerApp* app) {
    if(app->in_flight &&
       furi_get_tick() - app->in_flight_since > furi_ms_to_ticks(INDICATION_TIMEOUT_MS)) {
        // No confirmation: re-send. The PC dedups BTN by seq (§7).
        FURI_LOG_W(TAG, "indication not confirmed, retrying");
        app->in_flight = false;
    }
}

// ---------------------------------------------------------------------------
// Bluetooth start / stop (sequence mirrors the firmware's BLE HID app)
// ---------------------------------------------------------------------------
static bool quiz_bt_start(QuizBuzzerApp* app) {
    app->bt = furi_record_open(RECORD_BT);
    bt_disconnect(app->bt);
    furi_delay_ms(200);
    bt_keys_storage_set_storage_path(app->bt, QUIZ_KEYS_PATH);

    app->profile = bt_profile_start(app->bt, ble_profile_nus, NULL);
    if(!app->profile) {
        FURI_LOG_E(TAG, "failed to start NUS profile");
        bt_keys_storage_set_default_path(app->bt);
        furi_check(bt_profile_restore_default(app->bt));
        furi_record_close(RECORD_BT);
        app->bt = NULL;
        return false;
    }
    nus_profile_set_callbacks(app->profile, &nus_callbacks, app);
    furi_hal_bt_start_advertising();
    bt_set_status_changed_callback(app->bt, bt_status_cb, app);
    return true;
}

static void quiz_bt_stop(QuizBuzzerApp* app) {
    if(!app->bt) return;
    bt_set_status_changed_callback(app->bt, NULL, NULL);
    bt_disconnect(app->bt);
    furi_delay_ms(200);
    bt_keys_storage_set_default_path(app->bt);
    furi_check(bt_profile_restore_default(app->bt));
    furi_record_close(RECORD_BT);
    app->bt = NULL;
    app->profile = NULL;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
int32_t quiz_buzzer_app(void* p) {
    UNUSED(p);
    QuizBuzzerApp* app = malloc(sizeof(QuizBuzzerApp));
    memset(app, 0, sizeof(*app));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->queue = furi_message_queue_alloc(16, sizeof(AppEvent));
    app->cooldown_timer = furi_timer_alloc(cooldown_cb, FuriTimerTypeOnce, app);
    app->tick_timer = furi_timer_alloc(tick_cb, FuriTimerTypePeriodic, app);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->bt_status = BtStatusUnavailable;
    app->phase = PhaseWaiting;

    app->view_port = view_port_alloc();
    view_port_draw_callback_set(app->view_port, quiz_draw, app);
    view_port_input_callback_set(app->view_port, quiz_input_cb, app);
    app->gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(app->gui, app->view_port, GuiLayerFullscreen);

    bool running = quiz_bt_start(app);
    if(!running) {
        app->bt_status = BtStatusOff;
        view_port_update(app->view_port);
        furi_delay_ms(2000);
    }
    furi_timer_start(app->tick_timer, furi_ms_to_ticks(TICK_MS));

    AppEvent e;
    while(running) {
        if(furi_message_queue_get(app->queue, &e, FuriWaitForever) != FuriStatusOk) continue;

        furi_mutex_acquire(app->mutex, FuriWaitForever);
        switch(e.type) {
        case EvtInput:
            if(e.input.type == InputTypeShort && e.input.key == InputKeyLeft) {
                on_buzz(app, 1);
            } else if(e.input.type == InputTypeShort && e.input.key == InputKeyRight) {
                on_buzz(app, 2);
            } else if(e.input.type == InputTypeShort && e.input.key == InputKeyBack) {
                running = false;
            } else if(e.input.type == InputTypeLong && e.input.key == InputKeyOk) {
                // §3 bond reset, Flipper side. The PC must forget it too.
                bt_forget_bonded_devices(app->bt);
                notification_message(app->notifications, &sequence_double_vibro);
            }
            break;
        case EvtRx:
            on_command(app, e.cmd);
            break;
        case EvtSubscribe:
            on_subscribe(app, e.subscribed);
            break;
        case EvtConfirm:
            on_confirm(app);
            break;
        case EvtBtStatus:
            on_bt_status(app, e.bt_status);
            break;
        case EvtCooldownDone:
            app->phase = PhaseWaiting;
            queue_state(app, NUS_STATE_WAITING);
            break;
        case EvtTick:
            on_tick(app);
            break;
        }
        outbox_pump(app);
        furi_mutex_release(app->mutex);
        view_port_update(app->view_port);
    }

    furi_timer_stop(app->tick_timer);
    furi_timer_stop(app->cooldown_timer);
    quiz_bt_stop(app);

    gui_remove_view_port(app->gui, app->view_port);
    furi_record_close(RECORD_GUI);
    view_port_free(app->view_port);
    furi_record_close(RECORD_NOTIFICATION);
    furi_timer_free(app->tick_timer);
    furi_timer_free(app->cooldown_timer);
    furi_message_queue_free(app->queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}
