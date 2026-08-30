#ifndef BOTA_DEVICE_SDK_H
#define BOTA_DEVICE_SDK_H

/*
 * Bota Device SDK native ABI v1.
 *
 * Ownership and lifetime rules:
 * - An engine pointer must be NULL or a live value returned by engine_new.
 * - A live engine must not be freed while another call is using it.
 * - engine_free must be called at most once for each non-NULL engine.
 * - An error pointer is SDK-owned and must be passed exactly once to error_free.
 * - Slices returned by error_view are borrowed from the error owner and become
 *   invalid when that owner is freed.
 * - Output arguments must point to writable storage and must not retain an
 *   earlier SDK-owned value.
 *
 * Violating pointer, lifetime, or single-free rules is undefined behavior.
 * Status errors report recoverable operation failures, not invalid foreign
 * memory.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BOTA_DEVICE_SDK_ABI_VERSION UINT32_C(1)

typedef struct BotaDeviceSdkEngineV1 BotaDeviceSdkEngineV1;
typedef struct BotaDeviceSdkErrorV1 BotaDeviceSdkErrorV1;
typedef struct BotaDeviceSdkPacketV1 BotaDeviceSdkPacketV1;

typedef struct BotaDeviceSdkSliceV1 {
    const uint8_t *data;
    uint64_t len;
} BotaDeviceSdkSliceV1;

#define BOTA_DEVICE_SDK_V1_COMMAND_RANGE_START UINT32_C(0x0100)
#define BOTA_DEVICE_SDK_V1_COMMAND_DISCOVER_DEVICES UINT32_C(0x0101)
#define BOTA_DEVICE_SDK_V1_COMMAND_CONNECT UINT32_C(0x0102)
#define BOTA_DEVICE_SDK_V1_HOST_EVENT_RANGE_START UINT32_C(0x0200)
#define BOTA_DEVICE_SDK_V1_HOST_EFFECT_RANGE_START UINT32_C(0x0300)
#define BOTA_DEVICE_SDK_V1_NOTIFICATION_RANGE_START UINT32_C(0x0400)
#define BOTA_DEVICE_SDK_V1_PROTOCOL_VALUE_RANGE_START UINT32_C(0x0500)

#define BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED UINT32_C(1)
#define BOTA_DEVICE_SDK_V1_FIELD_TYPE_SIGNED UINT32_C(2)
#define BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL UINT32_C(3)
#define BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8 UINT32_C(4)
#define BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES UINT32_C(5)

#define BOTA_DEVICE_SDK_V1_FIELD_TIMEOUT_MS UINT32_C(1)
#define BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES UINT32_C(2)
#define BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER UINT32_C(3)
#define BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID UINT32_C(4)
#define BOTA_DEVICE_SDK_V1_FIELD_NAME UINT32_C(5)
#define BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS UINT32_C(6)
#define BOTA_DEVICE_SDK_V1_FIELD_RSSI UINT32_C(7)

typedef struct BotaDeviceSdkFieldViewV1 {
    uint32_t field_id;
    uint32_t field_type;
    uint64_t unsigned_value;
    int64_t signed_value;
    BotaDeviceSdkSliceV1 data;
} BotaDeviceSdkFieldViewV1;

typedef struct BotaDeviceSdkPacketViewV1 {
    uint32_t abi_version;
    uint32_t kind;
    uint32_t operation;
    uint32_t reserved;
    uint64_t request_id;
    uint64_t cancellation_id_high;
    uint64_t cancellation_id_low;
    const BotaDeviceSdkFieldViewV1 *fields;
    uint64_t field_count;
} BotaDeviceSdkPacketViewV1;

typedef enum BotaDeviceSdkStatusV1 {
    BOTA_DEVICE_SDK_V1_OK = 0,
    BOTA_DEVICE_SDK_V1_NO_OUTPUT = 1,
    BOTA_DEVICE_SDK_V1_INVALID_ARGUMENT = -1,
    BOTA_DEVICE_SDK_V1_OPERATION_FAILED = -2,
    BOTA_DEVICE_SDK_V1_PANIC = -3,
    BOTA_DEVICE_SDK_V1_UNSUPPORTED_ABI = -4
} BotaDeviceSdkStatusV1;

typedef struct BotaDeviceSdkErrorViewV1 {
    uint32_t abi_version;
    uint32_t code;
    uint32_t operation;
    uint8_t retryable;
    uint8_t has_protocol_status;
    uint16_t protocol_status;
    BotaDeviceSdkSliceV1 detail;
} BotaDeviceSdkErrorViewV1;

uint32_t bota_device_sdk_v1_abi_version(void);
BotaDeviceSdkEngineV1 *bota_device_sdk_v1_engine_new(void);
void bota_device_sdk_v1_engine_free(BotaDeviceSdkEngineV1 *engine);
BotaDeviceSdkStatusV1 bota_device_sdk_v1_engine_cancel(
    BotaDeviceSdkEngineV1 *engine,
    uint64_t cancellation_id_high,
    uint64_t cancellation_id_low
);
BotaDeviceSdkStatusV1 bota_device_sdk_v1_engine_last_error(
    BotaDeviceSdkEngineV1 *engine,
    BotaDeviceSdkErrorV1 **out_error
);
BotaDeviceSdkStatusV1 bota_device_sdk_v1_error_view(
    const BotaDeviceSdkErrorV1 *error,
    BotaDeviceSdkErrorViewV1 *out_view
);
void bota_device_sdk_v1_error_free(BotaDeviceSdkErrorV1 *error);
BotaDeviceSdkStatusV1 bota_device_sdk_v1_packet_view(
    const BotaDeviceSdkPacketV1 *packet,
    BotaDeviceSdkPacketViewV1 *out_view
);
void bota_device_sdk_v1_packet_free(BotaDeviceSdkPacketV1 *packet);

#ifdef __cplusplus
}
#endif

#endif
