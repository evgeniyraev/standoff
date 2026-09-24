/**
 * Quiz Buzzer — Flipper Zero controller for the BLE quiz-buzzer device.
 *
 * The Flipper plays the BLE central role described in pc-app-ble-integration.md:
 * it scans for the NUS service, connects/pairs (Just Works + bonding), keeps a
 * persistent auto-reconnecting link, sends START/PING, and shows BTN events.
 *
 * OK      -> send START (begins a round)
 * Back    -> exit
 * PING is sent automatically every 2000ms while waiting for game start (§7).
 */
#include <furi.h>
#include <gui/gui.h>
#include <input/input.h>

#include "helpers/ble_central.h"

#define TAG "QuizBuzzer"
#define PING_PERIOD_MS 2000

// Game phase, used to gate PING (§7): PING only while waiting-for-game-start.
typedef enum {
    PhaseWaiting, // waiting for game start -> PING on
    PhaseRoundActive, // START sent, round running -> PING off
} GamePhase;

// The STATE:<name> the device reports for the waiting-for-game-start state.
// Exact set is TBD with firmware (§7); adjust if it differs. Matching is
// case-insensitive and also accepts a couple of likely synonyms.
static bool state_is_waiting(const char* name);

typedef struct {
    Gui* gui;
    ViewPort* view_port;
    FuriMessageQueue* input_queue;
    FuriMutex* model_mutex;
    FuriTimer* ping_timer;

    BleCentral* ble;

    // ---- UI model (guarded by model_mutex) ----
    BleState ble_state;
    GamePhase phase;
    uint32_t start_sent; // count of START commands sent
    // Last button event
    bool have_button;
    uint8_t last_button_id;
    uint32_t last_button_seq;
    // Last device state string
    char last_state[NUS_STATE_NAME_MAX];
} QuizBuzzerApp;

static bool state_is_waiting(const char* name) {
    // Compare case-insensitively against known/likely waiting-state names.
    static const char* candidates[] = {"WAITING", "WAIT", "IDLE", "READY", "LOBBY"};
    for(size_t i = 0; i < COUNT_OF(candidates); i++) {
        const char* a = name;
        const char* b = candidates[i];
        bool eq = true;
        while(*a && *b) {
            char ca = (*a >= 'a' && *a <= 'z') ? (char)(*a - 32) : *a;
            if(ca != *b) {
                eq = false;
                break;
            }
            a++;
            b++;
        }
        if(eq && *a == '\0' && *b == '\0') return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
static void quiz_buzzer_draw(Canvas* canvas, void* ctx) {
    QuizBuzzerApp* app = ctx;
    furi_mutex_acquire(app->model_mutex, FuriWaitForever);

    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 2, 11, "Quiz Buzzer");
    canvas_draw_line(canvas, 0, 14, 128, 14);

    canvas_set_font(canvas, FontSecondary);

    char line[48];
    snprintf(line, sizeof(line), "Link: %s", ble_state_str(app->ble_state));
    canvas_draw_str(canvas, 2, 26, line);

    const char* phase = (app->phase == PhaseWaiting) ? "waiting (PING on)" : "round (PING off)";
    snprintf(line, sizeof(line), "Phase: %s", phase);
    canvas_draw_str(canvas, 2, 37, line);

    if(app->have_button) {
        snprintf(
            line,
            sizeof(line),
            "Buzz: P%u  seq %lu",
            app->last_button_id,
            (unsigned long)app->last_button_seq);
    } else if(app->last_state[0]) {
        snprintf(line, sizeof(line), "Dev state: %s", app->last_state);
    } else {
        snprintf(line, sizeof(line), "STARTs sent: %lu", (unsigned long)app->start_sent);
    }
    canvas_draw_str(canvas, 2, 48, line);

    // Footer hint
    if(app->ble_state == BleStateReady) {
        canvas_draw_str(canvas, 2, 62, "OK: START     Back: exit");
    } else if(app->ble_state == BleStateBondMismatch) {
        canvas_draw_str(canvas, 2, 62, "Reset bond (both sides)");
    } else {
        canvas_draw_str(canvas, 2, 62, "Connecting...  Back: exit");
    }

    furi_mutex_release(app->model_mutex);
}

static void quiz_buzzer_input(InputEvent* event, void* ctx) {
    QuizBuzzerApp* app = ctx;
    furi_message_queue_put(app->input_queue, event, FuriWaitForever);
}

// ---------------------------------------------------------------------------
// BLE event callback (runs in the ble timer thread)
// ---------------------------------------------------------------------------
static void quiz_buzzer_ble_cb(const BleEvent* event, void* context) {
    QuizBuzzerApp* app = context;
    furi_mutex_acquire(app->model_mutex, FuriWaitForever);

    switch(event->type) {
    case BleEventStateChanged:
        app->ble_state = event->state;
        break;

    case BleEventMessage:
        if(event->message.type == NusMsgButton) {
            app->have_button = true;
            app->last_button_id = event->message.button_id;
            app->last_button_seq = event->message.seq;
        } else if(event->message.type == NusMsgState) {
            strncpy(app->last_state, event->message.state_name, sizeof(app->last_state) - 1);
            app->last_state[sizeof(app->last_state) - 1] = '\0';
            // §7: resume PING once the device returns to waiting-for-game-start.
            if(state_is_waiting(app->last_state)) {
                app->phase = PhaseWaiting;
            }
        }
        break;

    case BleEventDisconnected:
        // Link dropped; driver auto-reconnects. Nothing to send until Ready.
        break;
    }

    furi_mutex_release(app->model_mutex);
    view_port_update(app->view_port);
}

// ---------------------------------------------------------------------------
// PING timer (§7): every 2000ms, only while waiting-for-game-start and Ready.
// ---------------------------------------------------------------------------
static void quiz_buzzer_ping_cb(void* ctx) {
    QuizBuzzerApp* app = ctx;
    furi_mutex_acquire(app->model_mutex, FuriWaitForever);
    bool should_ping = (app->phase == PhaseWaiting) && (app->ble_state == BleStateReady);
    furi_mutex_release(app->model_mutex);
    if(should_ping) ble_central_send_ping(app->ble);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
static QuizBuzzerApp* quiz_buzzer_alloc(void) {
    QuizBuzzerApp* app = malloc(sizeof(QuizBuzzerApp));
    memset(app, 0, sizeof(*app));

    app->model_mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->input_queue = furi_message_queue_alloc(8, sizeof(InputEvent));
    app->phase = PhaseWaiting;
    app->ble_state = BleStateIdle;

    app->ble = ble_central_alloc(quiz_buzzer_ble_cb, app);

    app->view_port = view_port_alloc();
    view_port_draw_callback_set(app->view_port, quiz_buzzer_draw, app);
    view_port_input_callback_set(app->view_port, quiz_buzzer_input, app);

    app->gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(app->gui, app->view_port, GuiLayerFullscreen);

    app->ping_timer = furi_timer_alloc(quiz_buzzer_ping_cb, FuriTimerTypePeriodic, app);
    return app;
}

static void quiz_buzzer_free(QuizBuzzerApp* app) {
    furi_timer_stop(app->ping_timer);
    furi_timer_free(app->ping_timer);

    ble_central_free(app->ble);

    gui_remove_view_port(app->gui, app->view_port);
    furi_record_close(RECORD_GUI);
    view_port_free(app->view_port);

    furi_message_queue_free(app->input_queue);
    furi_mutex_free(app->model_mutex);
    free(app);
}

int32_t quiz_buzzer_app(void* p) {
    UNUSED(p);
    QuizBuzzerApp* app = quiz_buzzer_alloc();

    ble_central_start(app->ble);
    furi_timer_start(app->ping_timer, furi_ms_to_ticks(PING_PERIOD_MS));

    InputEvent event;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->input_queue, &event, FuriWaitForever) != FuriStatusOk) {
            continue;
        }
        if(event.type != InputTypeShort) continue;

        switch(event.key) {
        case InputKeyOk:
            // §7: START begins a round; stop PING for the active round.
            if(ble_central_send_start(app->ble)) {
                furi_mutex_acquire(app->model_mutex, FuriWaitForever);
                app->phase = PhaseRoundActive;
                app->start_sent++;
                app->have_button = false;
                furi_mutex_release(app->model_mutex);
                view_port_update(app->view_port);
            }
            break;
        case InputKeyBack:
            running = false;
            break;
        default:
            break;
        }
    }

    furi_timer_stop(app->ping_timer);
    ble_central_stop(app->ble);
    quiz_buzzer_free(app);
    return 0;
}
