/**
 * Nordic UART Service (NUS) protocol for the quiz-buzzer device.
 *
 * Wire format (see pc-app-ble-integration.md §7). All messages are short ASCII,
 * one message per GATT write / indication, no framing newline required.
 *
 *   START           app -> device   begin a round
 *   PING            app -> device   liveness, only while waiting-for-game-start
 *   BTN:<id>:<seq>  device -> app   id is 1|2, seq is an incrementing counter
 *   STATE:<name>    device -> app   state change
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

// NUS 128-bit UUIDs (pc-app-ble-integration.md §1).
#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // write commands to device
#define NUS_TX_CHAR_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // receive events from device

// CCCD value to enable Indications on the TX characteristic (§2 step 5).
#define NUS_CCCD_INDICATE 0x0002

typedef enum {
    NusMsgUnknown = 0,
    NusMsgButton, // BTN:<id>:<seq>
    NusMsgState, // STATE:<name>
} NusMsgType;

#define NUS_STATE_NAME_MAX 24

typedef struct {
    NusMsgType type;
    // Valid when type == NusMsgButton
    uint8_t button_id; // 1 or 2
    uint32_t seq; // incrementing counter, used to dedup (§7)
    // Valid when type == NusMsgState
    char state_name[NUS_STATE_NAME_MAX];
} NusMessage;

/**
 * Parse one inbound message (a single TX indication payload).
 * `data` need not be NUL-terminated; a trailing '\n' is tolerated and trimmed.
 * Returns true if the message was recognised (type != NusMsgUnknown).
 */
bool nus_parse(const uint8_t* data, size_t len, NusMessage* out);

// Canonical outbound command payloads (no trailing newline, §7).
#define NUS_CMD_START "START"
#define NUS_CMD_PING "PING"
