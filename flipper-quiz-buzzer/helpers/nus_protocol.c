#include "nus_protocol.h"

#include <stdio.h>
#include <string.h>

NusCommand nus_parse_command(const uint8_t* data, size_t len) {
    if(!data) return NusCmdUnknown;
    // Trim a single trailing '\n' (device trims it per §7).
    if(len > 0 && data[len - 1] == '\n') len--;
    if(len == 0) return NusCmdUnknown;

    static const char start[] = "START";
    static const char stop[] = "STOP";
    static const char ping[] = "PING";
    if(len == sizeof(start) - 1 && memcmp(data, start, len) == 0) return NusCmdStart;
    if(len == sizeof(stop) - 1 && memcmp(data, stop, len) == 0) return NusCmdStop;
    if(len == sizeof(ping) - 1 && memcmp(data, ping, len) == 0) return NusCmdPing;
    return NusCmdUnknown;
}

size_t nus_build_button(char* buf, size_t buf_size, uint8_t id, uint32_t seq) {
    if(!buf || buf_size == 0) return 0;
    int n = snprintf(buf, buf_size, "BTN:%u:%lu", (unsigned)id, (unsigned long)seq);
    if(n < 0 || (size_t)n >= buf_size) return 0; // overflow / truncation
    return (size_t)n;
}

size_t nus_build_state(char* buf, size_t buf_size, const char* name) {
    if(!buf || buf_size == 0 || !name) return 0;
    int n = snprintf(buf, buf_size, "STATE:%s", name);
    if(n < 0 || (size_t)n >= buf_size) return 0;
    return (size_t)n;
}
