#include "bota_device_sdk.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

static BotaDeviceSdkSliceV1 empty_slice(void) {
    BotaDeviceSdkSliceV1 slice = {0};
    return slice;
}

static BotaDeviceSdkFieldViewV1 unsigned_field(uint32_t id, uint64_t value) {
    BotaDeviceSdkFieldViewV1 field = {0};
    field.field_id = id;
    field.field_type = BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED;
    field.unsigned_value = value;
    field.data = empty_slice();
    return field;
}

static BotaDeviceSdkFieldViewV1 bool_field(uint32_t id, int value) {
    BotaDeviceSdkFieldViewV1 field = unsigned_field(id, (uint64_t)(value != 0));
    field.field_type = BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL;
    return field;
}

static BotaDeviceSdkFieldViewV1 signed_field(uint32_t id, int64_t value) {
    BotaDeviceSdkFieldViewV1 field = {0};
    field.field_id = id;
    field.field_type = BOTA_DEVICE_SDK_V1_FIELD_TYPE_SIGNED;
    field.signed_value = value;
    field.data = empty_slice();
    return field;
}

static BotaDeviceSdkFieldViewV1 text_field(uint32_t id, const char *value, size_t length) {
    BotaDeviceSdkFieldViewV1 field = {0};
    field.field_id = id;
    field.field_type = BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8;
    field.data.data = (const uint8_t *)value;
    field.data.len = (uint64_t)length;
    return field;
}

static BotaDeviceSdkPacketViewV1 packet(
    uint32_t kind,
    uint32_t operation,
    uint64_t request_id,
    uint64_t cancellation_high,
    uint64_t cancellation_low,
    const BotaDeviceSdkFieldViewV1 *fields,
    uint64_t field_count
) {
    BotaDeviceSdkPacketViewV1 value = {0};
    value.abi_version = BOTA_DEVICE_SDK_ABI_VERSION;
    value.kind = kind;
    value.operation = operation;
    value.request_id = request_id;
    value.cancellation_id_high = cancellation_high;
    value.cancellation_id_low = cancellation_low;
    value.fields = fields;
    value.field_count = field_count;
    return value;
}

static uint32_t poll_kind(BotaDeviceSdkEngineV1 *engine) {
    BotaDeviceSdkPacketV1 *owner = NULL;
    assert(bota_device_sdk_v1_engine_poll_output(engine, &owner) == BOTA_DEVICE_SDK_V1_OK);
    assert(owner != NULL);
    BotaDeviceSdkPacketViewV1 view = {0};
    assert(bota_device_sdk_v1_packet_view(owner, &view) == BOTA_DEVICE_SDK_V1_OK);
    uint32_t kind = view.kind;
    bota_device_sdk_v1_packet_free(owner);
    return kind;
}

int main(void) {
    assert(bota_device_sdk_v1_abi_version() == BOTA_DEVICE_SDK_ABI_VERSION);
    BotaDeviceSdkEngineV1 *engine = bota_device_sdk_v1_engine_new();
    assert(engine != NULL);

    BotaDeviceSdkFieldViewV1 command_fields[] = {
        unsigned_field(BOTA_DEVICE_SDK_V1_FIELD_TIMEOUT_MS, 5000),
        bool_field(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES, 1),
    };
    BotaDeviceSdkPacketViewV1 command = packet(
        BOTA_DEVICE_SDK_V1_COMMAND_DISCOVER_DEVICES,
        0,
        0,
        0x0102,
        0x0304,
        command_fields,
        2
    );
    assert(bota_device_sdk_v1_engine_start(
        engine,
        &command,
        BOTA_DEVICE_SDK_V1_CAPABILITY_BLE | BOTA_DEVICE_SDK_V1_CAPABILITY_TIMER
    ) == BOTA_DEVICE_SDK_V1_OK);
    assert(poll_kind(engine) == BOTA_DEVICE_SDK_V1_NOTIFICATION_STARTED);
    assert(poll_kind(engine) == BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN);
    assert(poll_kind(engine) == BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE);

    static const char peripheral[] = "peripheral-1";
    static const char name[] = "Bota Note";
    BotaDeviceSdkFieldViewV1 event_fields[] = {
        text_field(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID, peripheral, sizeof(peripheral) - 1),
        text_field(BOTA_DEVICE_SDK_V1_FIELD_NAME, name, sizeof(name) - 1),
        signed_field(BOTA_DEVICE_SDK_V1_FIELD_RSSI, -60),
    };
    BotaDeviceSdkPacketViewV1 event = packet(
        BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_RESULT,
        BOTA_DEVICE_SDK_V1_OPERATION_DISCOVER,
        2,
        0x0102,
        0x0304,
        event_fields,
        3
    );
    assert(bota_device_sdk_v1_engine_dispatch(engine, &event) == BOTA_DEVICE_SDK_V1_OK);
    assert(poll_kind(engine) == BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_DISCOVERED);

    assert(bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x9999)
        == BOTA_DEVICE_SDK_V1_OPERATION_FAILED);
    BotaDeviceSdkErrorV1 *error = NULL;
    assert(bota_device_sdk_v1_engine_last_error(engine, &error) == BOTA_DEVICE_SDK_V1_OK);
    BotaDeviceSdkErrorViewV1 error_view = {0};
    assert(bota_device_sdk_v1_error_view(error, &error_view) == BOTA_DEVICE_SDK_V1_OK);
    assert(error_view.code == BOTA_DEVICE_SDK_V1_ERROR_UNEXPECTED_EVENT);
    bota_device_sdk_v1_error_free(error);

    assert(bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x0304) == BOTA_DEVICE_SDK_V1_OK);
    while (1) {
        BotaDeviceSdkPacketV1 *owner = NULL;
        BotaDeviceSdkStatusV1 status = bota_device_sdk_v1_engine_poll_output(engine, &owner);
        if (status == BOTA_DEVICE_SDK_V1_NO_OUTPUT) {
            break;
        }
        assert(status == BOTA_DEVICE_SDK_V1_OK);
        bota_device_sdk_v1_packet_free(owner);
    }
    bota_device_sdk_v1_engine_free(engine);
    return 0;
}
