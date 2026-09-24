#include "nus_protocol.h"

#include <string.h>

// Parse an unsigned decimal from [p, end). Advances *p past the digits.
// Returns false if no digit was consumed.
static bool parse_u32(const char** p, const char* end, uint32_t* out) {
    const char* s = *p;
    if(s >= end || *s < '0' || *s > '9') return false;
    uint32_t v = 0;
    while(s < end && *s >= '0' && *s <= '9') {
        v = (v * 10u) + (uint32_t)(*s - '0');
        s++;
    }
    *p = s;
    *out = v;
    return true;
}

bool nus_parse(const uint8_t* data, size_t len, NusMessage* out) {
    if(!data || !out) return false;
    memset(out, 0, sizeof(*out));
    out->type = NusMsgUnknown;

    // Trim a single trailing '\n' (device does the same on writes; symmetric here).
    if(len > 0 && data[len - 1] == '\n') len--;
    if(len == 0) return false;

    const char* p = (const char*)data;
    const char* end = p + len;

    // BTN:<id>:<seq>
    static const char btn[] = "BTN:";
    static const char state[] = "STATE:";
    const size_t btn_len = sizeof(btn) - 1;
    const size_t state_len = sizeof(state) - 1;

    if(len > btn_len && memcmp(p, btn, btn_len) == 0) {
        const char* q = p + btn_len;
        uint32_t id = 0, seq = 0;
        if(!parse_u32(&q, end, &id)) return false;
        if(q >= end || *q != ':') return false;
        q++;
        if(!parse_u32(&q, end, &seq)) return false;
        // Spec: id is 1 or 2. Reject anything else as malformed.
        if(id != 1 && id != 2) return false;
        out->type = NusMsgButton;
        out->button_id = (uint8_t)id;
        out->seq = seq;
        return true;
    }

    if(len > state_len && memcmp(p, state, state_len) == 0) {
        const char* q = p + state_len;
        size_t n = (size_t)(end - q);
        if(n == 0) return false;
        if(n >= NUS_STATE_NAME_MAX) n = NUS_STATE_NAME_MAX - 1;
        memcpy(out->state_name, q, n);
        out->state_name[n] = '\0';
        out->type = NusMsgState;
        return true;
    }

    return false;
}
