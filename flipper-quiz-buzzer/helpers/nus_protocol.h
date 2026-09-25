/**
 * Nordic UART Service (NUS) protocol, device side.
 *
 * The Flipper plays the quiz-buzzer *device* (BLE peripheral, NUS server). The
 * PC connects to it. Directions therefore mirror pc-app-ble-integration.md §7:
 *
 *   RX (PC -> device, we receive):   START | STOP | PING
 *   TX (device -> PC, we send):      BTN:<id>:<seq> | STATE:<name>
 *
 * All messages are short ASCII, one message per GATT write / indication, no
 * framing newline required; a trailing '\n' is tolerated on receive (§7).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

// NUS 128-bit UUIDs (pc-app-ble-integration.md §1). Byte arrays live in
// nus_profile.c; these strings are for reference/logging.
#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // PC writes commands here
#define NUS_TX_CHAR_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // device sends events here

// Inbound commands (RX).
typedef enum {
    NusCmdUnknown = 0,
    NusCmdStart, // START — begin a round
    NusCmdStop, // STOP — disarm; round ended without a press
    NusCmdPing, // PING — liveness while waiting-for-game-start
} NusCommand;

/**
 * Classify one inbound RX write payload. `data` need not be NUL-terminated; a
 * single trailing '\n' is trimmed first (§7).
 */
NusCommand nus_parse_command(const uint8_t* data, size_t len);

// Outbound event builders (TX). Write ASCII (no trailing newline, §7) into buf
// and return the byte length written (excluding any NUL), or 0 on overflow.

// BTN:<id>:<seq>, id is 1 or 2 (§7).
size_t nus_build_button(char* buf, size_t buf_size, uint8_t id, uint32_t seq);

// STATE:<name>
size_t nus_build_state(char* buf, size_t buf_size, const char* name);

// Canonical state names emitted on TX (exact set TBD with firmware, §7).
#define NUS_STATE_WAITING "WAITING" // waiting for game start
#define NUS_STATE_ARMED "ARMED" // round started, waiting for a buzz
#define NUS_STATE_PRESSED "PRESSED" // a player buzzed; round resolved
