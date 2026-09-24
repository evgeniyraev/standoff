/**
 * BLE central-role driver for the quiz-buzzer device.
 *
 * Implements the connection lifecycle from pc-app-ble-integration.md:
 *   §2 scan (by service UUID) -> connect -> discover -> pair -> subscribe TX -> write RX
 *   §3 Just Works pairing with bonding, and bond-mismatch detection
 *   §6 persistent connection with auto-reconnect and defensive re-subscribe
 *
 * The lifecycle state machine below is firmware-independent. The handful of
 * operations that actually touch the radio (scan/connect/discover/pair/
 * subscribe/write) are isolated in ble_central.c behind the BleHalOps struct
 * so they can be wired to whatever GATT-central API the target firmware
 * exposes (mainline furi_hal_bt central support is limited; forks differ).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "nus_protocol.h"

typedef struct BleCentral BleCentral;

// Connection lifecycle states (§2). Ordered so >= comparisons are meaningful.
typedef enum {
    BleStateIdle = 0,
    BleStateScanning, // looking for an advertisement with NUS_SERVICE_UUID
    BleStateConnecting, // link-layer connection in progress
    BleStateDiscovering, // resolving RX/TX by UUID (never by handle, §2.3)
    BleStatePairing, // Just Works pairing / bonding (§3)
    BleStateSubscribing, // writing 0x0002 to TX CCCD (§2.5)
    BleStateReady, // subscribed; may send START / receive BTN (§2.7)
    BleStateBondMismatch, // §3: connect ok but encrypted op failed -> re-pair needed
    BleStateError,
} BleState;

typedef enum {
    BleEventStateChanged, // state field updated
    BleEventMessage, // a NusMessage arrived (confirmed indication, §7)
    BleEventDisconnected, // link dropped; driver will auto-reconnect (§6)
} BleEventType;

typedef struct {
    BleEventType type;
    BleState state; // valid for BleEventStateChanged
    NusMessage message; // valid for BleEventMessage
} BleEvent;

typedef void (*BleCentralCallback)(const BleEvent* event, void* context);

BleCentral* ble_central_alloc(BleCentralCallback callback, void* context);
void ble_central_free(BleCentral* c);

// Begin the scan/connect/pair/subscribe lifecycle and keep it alive with
// auto-reconnect until ble_central_stop() (§6).
void ble_central_start(BleCentral* c);
void ble_central_stop(BleCentral* c);

// Send START (§7). No-op unless state == BleStateReady.
bool ble_central_send_start(BleCentral* c);

// Send PING (§7). Caller is responsible for the "only while waiting" rule and
// the 2000ms cadence; this just writes the command when Ready.
bool ble_central_send_ping(BleCentral* c);

BleState ble_central_state(const BleCentral* c);
const char* ble_state_str(BleState s);
