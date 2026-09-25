#include "nus_profile.h"

#include <furi.h>
#include <furi_hal_version.h>

#include <ble_const.h> // CHAR_PROP_*, ATTR_PERMISSION_*, UUID_TYPE_*, AD_TYPE_*
#include <furi_ble/gatt.h> // ble_gatt_* + aci_gatt_attribute_modified_event_rp0
#include <furi_ble/event_dispatcher.h>
#include <gap.h>

#define TAG "QuizBuzzerNus"

// HCI framing of events handed to service handlers (hci_uart_pckt ->
// hci_event_pckt -> evt_blecore_aci). The stack's wrapper types are not in the
// SDK, so the layout is spelled out here.
#define HCI_VENDOR_SPECIFIC_EVT_CODE 0xFFu
// Vendor event codes (stm32wb_copro ble_events.c, hci_vs_event_table).
#define ACI_GATT_ATTRIBUTE_MODIFIED 0x0C01u
#define ACI_GATT_SERVER_CONFIRMATION 0x0C17u

// CCCD bit a client sets to enable indications.
#define CCCD_INDICATE 0x02u

_Static_assert(sizeof(NUS_ADV_NAME) - 1 <= 5, "NUS_ADV_NAME must fit the ADV packet");

// NUS 128-bit UUIDs, little-endian (LSB first) as the ST stack expects.
// 6E400001-B5A3-F393-E0A9-E50E24DCCA9E and the 0002/0003 variants.
// clang-format off
static const uint8_t nus_service_uuid[16] = {
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e};
static const uint8_t nus_rx_char_uuid[16] = {
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x02, 0x00, 0x40, 0x6e};
static const uint8_t nus_tx_char_uuid[16] = {
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x03, 0x00, 0x40, 0x6e};
// clang-format on

// Backing store for the TX value; the value callback hands it to the stack at
// init (max length) and on each update.
typedef struct {
    uint8_t buf[NUS_TX_VALUE_MAX];
    uint16_t len;
} NusTxValue;

typedef struct {
    FuriHalBleProfileBase base; // must be first (profile_interface.h)

    uint16_t svc_handle;
    BleGattCharacteristicInstance rx;
    BleGattCharacteristicInstance tx;
    NusTxValue tx_value;

    GapSvcEventHandler* svc_handler;

    const NusProfileCallbacks* callbacks;
    void* callbacks_ctx;
} NusProfile;

static bool nus_tx_value_cb(const void* context, const uint8_t** data, uint16_t* data_len) {
    const NusTxValue* v = context;
    if(data) *data = v->buf; // data == NULL during init: only the length is wanted
    *data_len = v->len;
    return false; // buffer stays owned by the profile
}

static const BleGattCharacteristicParams nus_rx_char = {
    .name = "RX",
    .data_prop_type = FlipperGattCharacteristicDataFixed,
    .data.fixed.ptr = NULL, // write-only
    .data.fixed.length = NUS_TX_VALUE_MAX,
    .uuid.Char_UUID_128 = {0}, // filled in at start (array init from const not allowed)
    .uuid_type = UUID_TYPE_128,
    // §2.6: the PC uses Write With Response; also accept Without Response.
    .char_properties = CHAR_PROP_WRITE | CHAR_PROP_WRITE_WITHOUT_RESP,
    // Encryption (not MITM authentication) so Just Works pairing suffices (§3).
    .security_permissions = ATTR_PERMISSION_ENCRY_WRITE,
    .gatt_evt_mask = GATT_NOTIFY_ATTRIBUTE_WRITE,
    .is_variable = CHAR_VALUE_LEN_VARIABLE,
};

static const BleGattCharacteristicParams nus_tx_char = {
    .name = "TX",
    .data_prop_type = FlipperGattCharacteristicDataCallback,
    .data.callback.fn = nus_tx_value_cb,
    .data.callback.context = NULL, // set at start
    .uuid.Char_UUID_128 = {0},
    .uuid_type = UUID_TYPE_128,
    .char_properties = CHAR_PROP_INDICATE, // §2.5
    .security_permissions = ATTR_PERMISSION_ENCRY_READ,
    .gatt_evt_mask = GATT_NOTIFY_ATTRIBUTE_WRITE,
    .is_variable = CHAR_VALUE_LEN_VARIABLE,
};

// --- BLE stack event handler -------------------------------------------------
typedef struct __attribute__((packed)) {
    uint8_t type; // HCI packet type
    uint8_t evt; // event code
    uint8_t plen; // parameter length
    uint16_t ecode; // vendor event code
    uint8_t payload[];
} NusAciEvt;

static BleEventAckStatus nus_svc_event_handler(void* event, void* context) {
    NusProfile* p = context;
    const NusAciEvt* evt = event;
    if(evt->evt != HCI_VENDOR_SPECIFIC_EVT_CODE) return BleEventNotAck;

    const NusProfileCallbacks* cb = p->callbacks;

    if(evt->ecode == ACI_GATT_ATTRIBUTE_MODIFIED) {
        const aci_gatt_attribute_modified_event_rp0* am =
            (const aci_gatt_attribute_modified_event_rp0*)evt->payload;
        // handle = characteristic declaration; +1 = value; +2 = CCCD.
        if(am->Attr_Handle == p->rx.handle + 1) {
            if(cb && cb->on_rx && am->Attr_Data_Length > 0) {
                cb->on_rx(am->Attr_Data, am->Attr_Data_Length, p->callbacks_ctx);
            }
            return BleEventAckFlowEnable;
        }
        if(am->Attr_Handle == p->tx.handle + 2) {
            bool enabled = am->Attr_Data_Length > 0 && (am->Attr_Data[0] & CCCD_INDICATE);
            if(cb && cb->on_subscribe) cb->on_subscribe(enabled, p->callbacks_ctx);
            return BleEventAckFlowEnable;
        }
    } else if(evt->ecode == ACI_GATT_SERVER_CONFIRMATION) {
        // TX is our only indicating characteristic.
        if(cb && cb->on_confirm) cb->on_confirm(p->callbacks_ctx);
        return BleEventAckFlowEnable;
    }
    return BleEventNotAck;
}

// --- Profile template hooks --------------------------------------------------
static void nus_get_gap_config(GapConfig* config, FuriHalBleProfileParams params) {
    UNUSED(params);
    memset(config, 0, sizeof(*config));

    // Advertise the 128-bit NUS service UUID so the PC discovers by UUID (§1).
    config->adv_service.UUID_Type = UUID_TYPE_128;
    memcpy(config->adv_service.Service_UUID_128, nus_service_uuid, sizeof(nus_service_uuid));

    config->bonding_mode = true; // §3 bonding
    config->pairing_method = GapPairingNone; // §3 Just Works

    // Own address, distinct from the default profile (and HID, which uses +1):
    // hosts cache GATT tables and bonds per address.
    memcpy(config->mac_address, furi_hal_version_get_ble_mac(), sizeof(config->mac_address));
    config->mac_address[2] += 2;

    config->conn_param.conn_int_min = 0x06; // 7.5 ms
    config->conn_param.conn_int_max = 0x24; // 45 ms
    config->conn_param.slave_latency = 0;
    config->conn_param.supervisor_timeout = 0; // stack default

    // adv_name is raw AD data: first byte is the AD type.
    config->adv_name[0] = AD_TYPE_COMPLETE_LOCAL_NAME;
    strlcpy(config->adv_name + 1, NUS_ADV_NAME, sizeof(config->adv_name) - 1);
}

static FuriHalBleProfileBase* nus_profile_start(FuriHalBleProfileParams params) {
    UNUSED(params);
    NusProfile* p = malloc(sizeof(NusProfile));
    memset(p, 0, sizeof(*p));
    p->base.config = ble_profile_nus;

    // Records: service(1) + RX decl/value(2) + TX decl/value/CCCD(3) = 6.
    Service_UUID_t svc_uuid;
    memcpy(svc_uuid.Service_UUID_128, nus_service_uuid, sizeof(nus_service_uuid));
    if(!ble_gatt_service_add(UUID_TYPE_128, &svc_uuid, PRIMARY_SERVICE, 8, &p->svc_handle)) {
        FURI_LOG_E(TAG, "service add failed");
        free(p);
        return NULL;
    }

    BleGattCharacteristicParams rx_char = nus_rx_char;
    memcpy(rx_char.uuid.Char_UUID_128, nus_rx_char_uuid, sizeof(nus_rx_char_uuid));
    ble_gatt_characteristic_init(p->svc_handle, &rx_char, &p->rx);

    p->tx_value.len = NUS_TX_VALUE_MAX; // init asks the callback for max length
    BleGattCharacteristicParams tx_char = nus_tx_char;
    memcpy(tx_char.uuid.Char_UUID_128, nus_tx_char_uuid, sizeof(nus_tx_char_uuid));
    tx_char.data.callback.context = &p->tx_value;
    ble_gatt_characteristic_init(p->svc_handle, &tx_char, &p->tx);
    p->tx_value.len = 0;

    p->svc_handler = ble_event_dispatcher_register_svc_handler(nus_svc_event_handler, p);

    FURI_LOG_I(
        TAG,
        "NUS up: svc=%04X rx=%04X tx=%04X name=%s",
        p->svc_handle,
        p->rx.handle,
        p->tx.handle,
        NUS_ADV_NAME);
    return &p->base;
}

static void nus_profile_stop(FuriHalBleProfileBase* profile) {
    furi_check(profile && profile->config == ble_profile_nus);
    NusProfile* p = (NusProfile*)profile;
    ble_event_dispatcher_unregister_svc_handler(p->svc_handler);
    ble_gatt_characteristic_delete(p->svc_handle, &p->tx);
    ble_gatt_characteristic_delete(p->svc_handle, &p->rx);
    ble_gatt_service_delete(p->svc_handle);
    free(p);
}

static const FuriHalBleProfileTemplate nus_profile_template = {
    .start = nus_profile_start,
    .stop = nus_profile_stop,
    .get_gap_config = nus_get_gap_config,
};
const FuriHalBleProfileTemplate* const ble_profile_nus = &nus_profile_template;

// --- App-facing API ----------------------------------------------------------
void nus_profile_set_callbacks(
    FuriHalBleProfileBase* profile,
    const NusProfileCallbacks* callbacks,
    void* context) {
    furi_check(profile && profile->config == ble_profile_nus);
    NusProfile* p = (NusProfile*)profile;
    p->callbacks_ctx = context;
    p->callbacks = callbacks;
}

bool nus_profile_tx(FuriHalBleProfileBase* profile, const uint8_t* data, uint16_t len) {
    furi_check(profile && profile->config == ble_profile_nus);
    NusProfile* p = (NusProfile*)profile;
    if(len > NUS_TX_VALUE_MAX) len = NUS_TX_VALUE_MAX;
    memcpy(p->tx_value.buf, data, len);
    p->tx_value.len = len;
    return ble_gatt_characteristic_update(p->svc_handle, &p->tx, &p->tx_value);
}
