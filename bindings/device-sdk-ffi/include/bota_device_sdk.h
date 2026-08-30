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
#define BOTA_DEVICE_SDK_V1_COMMAND_RECONNECT UINT32_C(0x0103)
#define BOTA_DEVICE_SDK_V1_COMMAND_PROVISION UINT32_C(0x0104)
#define BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_RECORDING UINT32_C(0x0105)
#define BOTA_DEVICE_SDK_V1_COMMAND_UPLOAD_RECORDING UINT32_C(0x0106)
#define BOTA_DEVICE_SDK_V1_COMMAND_UPDATE_FIRMWARE UINT32_C(0x0107)
#define BOTA_DEVICE_SDK_V1_COMMAND_READ_DEVICE_LOGS UINT32_C(0x0108)
#define BOTA_DEVICE_SDK_V1_COMMAND_FACTORY_RESET UINT32_C(0x0109)
#define BOTA_DEVICE_SDK_V1_COMMAND_RESUME_FACTORY_RESET UINT32_C(0x010A)
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
#define BOTA_DEVICE_SDK_V1_FIELD_STORED_PERIPHERAL_ID UINT32_C(8)
#define BOTA_DEVICE_SDK_V1_FIELD_STORED_NAME UINT32_C(9)
#define BOTA_DEVICE_SDK_V1_FIELD_SCAN_TIMEOUT_MS UINT32_C(10)
#define BOTA_DEVICE_SDK_V1_FIELD_CONNECTION_TIMEOUT_MS UINT32_C(11)
#define BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID UINT32_C(12)
#define BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID UINT32_C(13)
#define BOTA_DEVICE_SDK_V1_FIELD_SINK_ID UINT32_C(14)
#define BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS UINT32_C(15)
#define BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID UINT32_C(16)
#define BOTA_DEVICE_SDK_V1_FIELD_DESTINATION_ID UINT32_C(17)
#define BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_VERSION UINT32_C(18)
#define BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_SIZE_BYTES UINT32_C(19)
#define BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_CRC32 UINT32_C(20)
#define BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID UINT32_C(21)
#define BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID UINT32_C(22)
#define BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID UINT32_C(23)
#define BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE UINT32_C(24)
#define BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT UINT32_C(25)

#define BOTA_DEVICE_SDK_V1_CAPABILITY_BLE (UINT64_C(1) << 0)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_TIMER (UINT64_C(1) << 1)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_PERSISTENCE (UINT64_C(1) << 2)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_SECURE_STORAGE (UINT64_C(1) << 3)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_NETWORK_TRANSFER (UINT64_C(1) << 4)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_PROGRESS (UINT64_C(1) << 5)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_HOST_MATERIAL (UINT64_C(1) << 6)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_RECORDING_SINK (UINT64_C(1) << 7)
#define BOTA_DEVICE_SDK_V1_CAPABILITY_FIRMWARE_BLOB (UINT64_C(1) << 8)

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
BotaDeviceSdkStatusV1 bota_device_sdk_v1_engine_start(
    BotaDeviceSdkEngineV1 *engine,
    const BotaDeviceSdkPacketViewV1 *packet,
    uint64_t capability_bits
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
