/**
 * Custom BLE peripheral profile exposing the Nordic UART Service (NUS) so a PC
 * (per pc-app-ble-integration.md) can connect to the Flipper as if it were the
 * quiz-buzzer device.
 *
 *  - Advertises the 128-bit NUS service UUID so the PC finds it by UUID (§1),
 *    under the local name NUS_ADV_NAME.
 *  - RX characteristic: Write / Write-Without-Response, encrypted -> receives
 *    START / PING. The encryption requirement triggers Just Works pairing with
 *    bonding on the first write (§3).
 *  - TX characteristic: Indicate, encrypted -> sends BTN / STATE.
 *
 * All callbacks run in the BLE stack thread: keep them short and hand work off
 * to the app thread. Never call nus_profile_tx() from inside a callback.
 */
#pragma once

#include <furi_ble/profile_interface.h>

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Advertised local name. The single 31-byte ADV packet holds:
//   flags(3) + TX power(3) + 128-bit UUID list(18) + name(2 + N)  ->  N <= 5
#define NUS_ADV_NAME "Buzz"

// Max TX payload we ever send (BTN/STATE are short); fits the default MTU.
#define NUS_TX_VALUE_MAX 20

typedef struct {
    // PC wrote to RX.
    void (*on_rx)(const uint8_t* data, uint16_t len, void* context);
    // PC enabled/disabled indications on TX (CCCD write).
    void (*on_subscribe)(bool enabled, void* context);
    // PC confirmed the last TX indication (§7: only now is it "delivered").
    void (*on_confirm)(void* context);
} NusProfileCallbacks;

// Profile template to pass to bt_profile_start().
extern const FuriHalBleProfileTemplate* const ble_profile_nus;

void nus_profile_set_callbacks(
    FuriHalBleProfileBase* profile,
    const NusProfileCallbacks* callbacks,
    void* context);

// Send one indication on TX. Only one indication may be in flight: wait for
// on_confirm before sending the next. Returns false if the stack refused it.
bool nus_profile_tx(FuriHalBleProfileBase* profile, const uint8_t* data, uint16_t len);

#ifdef __cplusplus
}
#endif
