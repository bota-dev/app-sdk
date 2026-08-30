#include "bota_device_sdk.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int drain_outputs(BotaDeviceSdkEngine *engine, size_t *count) {
    for (;;) {
        BotaDeviceSdkOwnedBuffer output = {0};
        BotaDeviceSdkStatus status =
            bota_device_sdk_engine_poll_output(engine, &output);
        if (status == BOTA_DEVICE_SDK_NO_OUTPUT) {
            return 0;
        }
        if (status != BOTA_DEVICE_SDK_OK || output.data == NULL ||
            output.len == 0) {
            return 1;
        }
        *count += 1;
        bota_device_sdk_buffer_free(output);
    }
}

static int contains_bytes(const uint8_t *data, size_t len, const char *needle) {
    size_t needle_len = strlen(needle);
    if (needle_len > len) {
        return 0;
    }
    for (size_t index = 0; index <= len - needle_len; index += 1) {
        if (memcmp(data + index, needle, needle_len) == 0) {
            return 1;
        }
    }
    return 0;
}

int main(void) {
    static const uint8_t command[] =
        "{\"DiscoverDevices\":{\"timeout_ms\":5000,"
        "\"allow_duplicates\":true}}";
    static const uint8_t invalid[] = "{";
    BotaDeviceSdkEngine *engine = bota_device_sdk_engine_new();
    size_t output_count = 0;

    if (engine == NULL) {
        fputs("engine allocation failed\n", stderr);
        return 1;
    }
    if (bota_device_sdk_engine_start_json(
            engine, command, sizeof(command) - 1,
            BOTA_DEVICE_SDK_CAPABILITY_BLE |
                BOTA_DEVICE_SDK_CAPABILITY_TIMER,
            UINT64_C(0x0102030405060708), UINT64_C(0x1112131415161718)) !=
        BOTA_DEVICE_SDK_OK) {
        fputs("start failed\n", stderr);
        bota_device_sdk_engine_free(engine);
        return 1;
    }
    if (drain_outputs(engine, &output_count) != 0 || output_count != 3) {
        fputs("unexpected start outputs\n", stderr);
        bota_device_sdk_engine_free(engine);
        return 1;
    }
    if (bota_device_sdk_engine_cancel(
            engine, UINT64_C(0x0102030405060708),
            UINT64_C(0x1112131415161718)) != BOTA_DEVICE_SDK_OK ||
        drain_outputs(engine, &output_count) != 0 || output_count <= 3) {
        fputs("cancel failed\n", stderr);
        bota_device_sdk_engine_free(engine);
        return 1;
    }
    if (bota_device_sdk_engine_start_json(
            engine, invalid, sizeof(invalid) - 1,
            BOTA_DEVICE_SDK_CAPABILITY_BLE |
                BOTA_DEVICE_SDK_CAPABILITY_TIMER,
            0, 2) != BOTA_DEVICE_SDK_OPERATION_FAILED) {
        fputs("invalid command was accepted\n", stderr);
        bota_device_sdk_engine_free(engine);
        return 1;
    }

    BotaDeviceSdkOwnedBuffer error = {0};
    if (bota_device_sdk_engine_last_error(engine, &error) !=
            BOTA_DEVICE_SDK_OK ||
        error.data == NULL || error.len == 0 ||
        !contains_bytes(error.data, error.len, "command JSON")) {
        fputs("error output missing\n", stderr);
        bota_device_sdk_engine_free(engine);
        return 1;
    }
    bota_device_sdk_buffer_free(error);
    bota_device_sdk_engine_free(engine);
    puts("C ABI smoke passed");
    return 0;
}
