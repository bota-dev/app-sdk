#ifndef BOTA_DEVICE_SDK_H
#define BOTA_DEVICE_SDK_H

/*
 * Milestone 2 native ABI contract. No platform artifact ships this interface
 * yet.
 *
 * Lifetime and ownership rules:
 * - An engine pointer must be NULL or a live value returned by engine_new.
 * - A live engine must not be freed while another call is using it.
 * - engine_free must be called at most once for each non-NULL engine.
 * - Input spans are borrowed only for the duration of a call. A NULL input is
 *   valid only when its length is zero.
 * - An output pointer must address writable BotaDeviceSdkOwnedBuffer storage.
 *   The SDK initializes it; callers must not pass a buffer that still owns an
 *   earlier allocation.
 * - Every successful output buffer must be passed exactly once to buffer_free.
 *   Do not modify its data or length before freeing it.
 *
 * Violating these rules can cause undefined behavior. Status errors contain
 * recoverable input or operation failures, not invalid foreign pointers.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BotaDeviceSdkEngine BotaDeviceSdkEngine;

typedef struct BotaDeviceSdkOwnedBuffer {
    uint8_t *data;
    size_t len;
} BotaDeviceSdkOwnedBuffer;

typedef enum BotaDeviceSdkStatus {
    BOTA_DEVICE_SDK_OK = 0,
    BOTA_DEVICE_SDK_NO_OUTPUT = 1,
    BOTA_DEVICE_SDK_INVALID_ARGUMENT = -1,
    BOTA_DEVICE_SDK_OPERATION_FAILED = -2,
    BOTA_DEVICE_SDK_PANIC = -3
} BotaDeviceSdkStatus;

#define BOTA_DEVICE_SDK_CAPABILITY_BLE (UINT64_C(1) << 0)
#define BOTA_DEVICE_SDK_CAPABILITY_TIMER (UINT64_C(1) << 1)
#define BOTA_DEVICE_SDK_CAPABILITY_PERSISTENCE (UINT64_C(1) << 2)
#define BOTA_DEVICE_SDK_CAPABILITY_SECURE_STORAGE (UINT64_C(1) << 3)
#define BOTA_DEVICE_SDK_CAPABILITY_NETWORK_TRANSFER (UINT64_C(1) << 4)
#define BOTA_DEVICE_SDK_CAPABILITY_PROGRESS (UINT64_C(1) << 5)
#define BOTA_DEVICE_SDK_CAPABILITY_HOST_MATERIAL (UINT64_C(1) << 6)
#define BOTA_DEVICE_SDK_CAPABILITY_RECORDING_SINK (UINT64_C(1) << 7)
#define BOTA_DEVICE_SDK_CAPABILITY_FIRMWARE_BLOB (UINT64_C(1) << 8)

BotaDeviceSdkEngine *bota_device_sdk_engine_new(void);
void bota_device_sdk_engine_free(BotaDeviceSdkEngine *engine);

BotaDeviceSdkStatus bota_device_sdk_engine_start_json(
    BotaDeviceSdkEngine *engine,
    const uint8_t *command_json,
    size_t command_len,
    uint64_t capability_bits,
    uint64_t cancellation_id_high,
    uint64_t cancellation_id_low
);

BotaDeviceSdkStatus bota_device_sdk_engine_dispatch_json(
    BotaDeviceSdkEngine *engine,
    uint64_t request_id,
    const uint8_t *event_json,
    size_t event_len
);

BotaDeviceSdkStatus bota_device_sdk_engine_cancel(
    BotaDeviceSdkEngine *engine,
    uint64_t cancellation_id_high,
    uint64_t cancellation_id_low
);

BotaDeviceSdkStatus bota_device_sdk_engine_poll_output(
    BotaDeviceSdkEngine *engine,
    BotaDeviceSdkOwnedBuffer *out_buffer
);

BotaDeviceSdkStatus bota_device_sdk_engine_last_error(
    BotaDeviceSdkEngine *engine,
    BotaDeviceSdkOwnedBuffer *out_buffer
);

void bota_device_sdk_buffer_free(BotaDeviceSdkOwnedBuffer buffer);

#ifdef __cplusplus
}
#endif

#endif
