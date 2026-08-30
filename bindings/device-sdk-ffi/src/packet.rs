use crate::{ABI_VERSION, BotaDeviceSdkSliceV1, BotaDeviceSdkStatusV1};
use std::panic::{AssertUnwindSafe, catch_unwind};

pub mod kind {
    pub const COMMAND_RANGE_START: u32 = 0x0100;
    pub const COMMAND_DISCOVER_DEVICES: u32 = 0x0101;
    pub const COMMAND_CONNECT: u32 = 0x0102;
    pub const COMMAND_RECONNECT: u32 = 0x0103;
    pub const COMMAND_PROVISION: u32 = 0x0104;
    pub const COMMAND_TRANSFER_RECORDING: u32 = 0x0105;
    pub const COMMAND_UPLOAD_RECORDING: u32 = 0x0106;
    pub const COMMAND_UPDATE_FIRMWARE: u32 = 0x0107;
    pub const COMMAND_READ_DEVICE_LOGS: u32 = 0x0108;
    pub const COMMAND_FACTORY_RESET: u32 = 0x0109;
    pub const COMMAND_RESUME_FACTORY_RESET: u32 = 0x010a;

    pub const HOST_EVENT_RANGE_START: u32 = 0x0200;
    pub const HOST_EFFECT_RANGE_START: u32 = 0x0300;
    pub const HOST_EFFECT_TIMER_SCHEDULE: u32 = 0x0301;
    pub const HOST_EFFECT_TIMER_CANCEL: u32 = 0x0302;
    pub const HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT: u32 = 0x0303;
    pub const HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT: u32 = 0x0304;
    pub const HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT: u32 = 0x0305;
    pub const HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY: u32 = 0x0306;
    pub const HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT: u32 = 0x0307;
    pub const HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT: u32 = 0x0308;
    pub const HOST_EFFECT_SECURE_STORAGE_READ: u32 = 0x0309;
    pub const HOST_EFFECT_SECURE_STORAGE_WRITE: u32 = 0x030a;
    pub const HOST_EFFECT_SECURE_STORAGE_DELETE: u32 = 0x030b;
    pub const HOST_EFFECT_BLE_START_SCAN: u32 = 0x0310;
    pub const HOST_EFFECT_BLE_STOP_SCAN: u32 = 0x0311;
    pub const HOST_EFFECT_BLE_CONNECT: u32 = 0x0312;
    pub const HOST_EFFECT_BLE_DISCOVER_SERVICES: u32 = 0x0313;
    pub const HOST_EFFECT_BLE_DISCONNECT: u32 = 0x0314;
    pub const HOST_EFFECT_BLE_READ: u32 = 0x0315;
    pub const HOST_EFFECT_BLE_WRITE: u32 = 0x0316;
    pub const HOST_EFFECT_BLE_SUBSCRIBE: u32 = 0x0317;
    pub const HOST_EFFECT_BLE_UNSUBSCRIBE: u32 = 0x0318;
    pub const HOST_EFFECT_NETWORK_DOWNLOAD: u32 = 0x0320;
    pub const HOST_EFFECT_NETWORK_UPLOAD: u32 = 0x0321;
    pub const HOST_EFFECT_PROGRESS: u32 = 0x0328;
    pub const HOST_EFFECT_PREPARE_PROVISIONING: u32 = 0x0330;
    pub const HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT: u32 = 0x0331;
    pub const HOST_EFFECT_RECORDING_SINK_TRUNCATE: u32 = 0x0338;
    pub const HOST_EFFECT_RECORDING_SINK_APPEND: u32 = 0x0339;
    pub const HOST_EFFECT_RECORDING_SINK_FINALIZE: u32 = 0x033a;
    pub const HOST_EFFECT_RECORDING_SINK_DISCARD: u32 = 0x033b;
    pub const HOST_EFFECT_FIRMWARE_BLOB_READ: u32 = 0x0340;
    pub const NOTIFICATION_RANGE_START: u32 = 0x0400;
    pub const NOTIFICATION_STARTED: u32 = 0x0401;
    pub const NOTIFICATION_DEVICE_DISCOVERED: u32 = 0x0402;
    pub const NOTIFICATION_CONNECTION_ESTABLISHED: u32 = 0x0403;
    pub const NOTIFICATION_PROGRESS: u32 = 0x0404;
    pub const NOTIFICATION_RETRYING: u32 = 0x0405;
    pub const NOTIFICATION_DEVICE_UPLOAD_PRESERVED: u32 = 0x0406;
    pub const NOTIFICATION_BLE_FALLBACK_READY: u32 = 0x0407;
    pub const NOTIFICATION_FIRMWARE_PROGRESS: u32 = 0x0408;
    pub const NOTIFICATION_DEVICE_LOG: u32 = 0x0409;
    pub const NOTIFICATION_COMPLETED: u32 = 0x040a;
    pub const NOTIFICATION_CANCELLED: u32 = 0x040b;
    pub const NOTIFICATION_FAILED: u32 = 0x040c;
    pub const PROTOCOL_VALUE_RANGE_START: u32 = 0x0500;
}

pub mod field_type {
    pub const UNSIGNED: u32 = 1;
    pub const SIGNED: u32 = 2;
    pub const BOOL: u32 = 3;
    pub const UTF8: u32 = 4;
    pub const BYTES: u32 = 5;
}

pub mod field_id {
    pub const TIMEOUT_MS: u32 = 1;
    pub const ALLOW_DUPLICATES: u32 = 2;
    pub const SERIAL_NUMBER: u32 = 3;
    pub const PERIPHERAL_ID: u32 = 4;
    pub const NAME: u32 = 5;
    pub const ADVERTISED_ADDRESS: u32 = 6;
    pub const RSSI: u32 = 7;
    pub const STORED_PERIPHERAL_ID: u32 = 8;
    pub const STORED_NAME: u32 = 9;
    pub const SCAN_TIMEOUT_MS: u32 = 10;
    pub const CONNECTION_TIMEOUT_MS: u32 = 11;
    pub const MATERIAL_ID: u32 = 12;
    pub const RECORDING_UUID: u32 = 13;
    pub const SINK_ID: u32 = 14;
    pub const TOTAL_UNITS: u32 = 15;
    pub const UPLOAD_ID: u32 = 16;
    pub const DESTINATION_ID: u32 = 17;
    pub const FIRMWARE_VERSION: u32 = 18;
    pub const FIRMWARE_SIZE_BYTES: u32 = 19;
    pub const FIRMWARE_CRC32: u32 = 20;
    pub const DOWNLOAD_ID: u32 = 21;
    pub const COMMAND_ID: u32 = 22;
    pub const GRANT_ID: u32 = 23;
    pub const RESULT_CODE: u32 = 24;
    pub const DELETED_RECORDING_COUNT: u32 = 25;
    pub const TIMER_ID: u32 = 26;
    pub const DELAY_MS: u32 = 27;
    pub const CHECKPOINT: u32 = 28;
    pub const KEY: u32 = 29;
    pub const VALUE: u32 = 30;
    pub const SERVICE_UUID: u32 = 31;
    pub const CHARACTERISTIC_UUID: u32 = 32;
    pub const PAYLOAD: u32 = 33;
    pub const WITH_RESPONSE: u32 = 34;
    pub const UPLOAD_SOURCE: u32 = 35;
    pub const COMPLETED_UNITS: u32 = 36;
    pub const EXPECTED_CRC32: u32 = 37;
    pub const SEQUENCE: u32 = 38;
    pub const OFFSET: u32 = 39;
    pub const MAX_LENGTH: u32 = 40;
    pub const NONCE: u32 = 41;
    pub const DEVICE_PUBLIC_KEY: u32 = 42;
    pub const ATTEMPT: u32 = 43;
    pub const CONNECTION_MODE: u32 = 44;
    pub const FIRMWARE_PHASE: u32 = 45;
    pub const LOG_MESSAGE: u32 = 46;
    pub const ERROR_CODE: u32 = 47;
    pub const RETRYABLE: u32 = 48;
    pub const PROTOCOL_STATUS: u32 = 49;
    pub const ERROR_DETAIL: u32 = 50;
    pub const IS_BACKLOG: u32 = 51;
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BotaDeviceSdkFieldViewV1 {
    pub field_id: u32,
    pub field_type: u32,
    pub unsigned_value: u64,
    pub signed_value: i64,
    pub data: BotaDeviceSdkSliceV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BotaDeviceSdkPacketViewV1 {
    pub abi_version: u32,
    pub kind: u32,
    pub operation: u32,
    pub reserved: u32,
    pub request_id: u64,
    pub cancellation_id_high: u64,
    pub cancellation_id_low: u64,
    pub fields: *const BotaDeviceSdkFieldViewV1,
    pub field_count: u64,
}

impl Default for BotaDeviceSdkPacketViewV1 {
    fn default() -> Self {
        Self {
            abi_version: ABI_VERSION,
            kind: 0,
            operation: 0,
            reserved: 0,
            request_id: 0,
            cancellation_id_high: 0,
            cancellation_id_low: 0,
            fields: std::ptr::null(),
            field_count: 0,
        }
    }
}

struct OwnedFieldV1 {
    field_id: u32,
    field_type: u32,
    unsigned_value: u64,
    signed_value: i64,
    data: Vec<u8>,
}

impl OwnedFieldV1 {
    fn view(&self) -> BotaDeviceSdkFieldViewV1 {
        BotaDeviceSdkFieldViewV1 {
            field_id: self.field_id,
            field_type: self.field_type,
            unsigned_value: self.unsigned_value,
            signed_value: self.signed_value,
            data: slice_view(&self.data),
        }
    }
}

#[repr(C)]
pub struct BotaDeviceSdkPacketV1 {
    kind: u32,
    operation: u32,
    request_id: u64,
    cancellation_id_high: u64,
    cancellation_id_low: u64,
    fields: Vec<OwnedFieldV1>,
    field_views: Vec<BotaDeviceSdkFieldViewV1>,
}

impl BotaDeviceSdkPacketV1 {
    pub fn new(kind: u32) -> Self {
        Self {
            kind,
            operation: 0,
            request_id: 0,
            cancellation_id_high: 0,
            cancellation_id_low: 0,
            fields: Vec::new(),
            field_views: Vec::new(),
        }
    }

    pub fn with_operation(mut self, operation: u32) -> Self {
        self.operation = operation;
        self
    }

    pub fn with_request_id(mut self, request_id: u64) -> Self {
        self.request_id = request_id;
        self
    }

    pub fn with_cancellation_id(mut self, high: u64, low: u64) -> Self {
        self.cancellation_id_high = high;
        self.cancellation_id_low = low;
        self
    }

    pub fn with_u64(self, field_id: u32, value: u64) -> Self {
        self.with_field(OwnedFieldV1 {
            field_id,
            field_type: field_type::UNSIGNED,
            unsigned_value: value,
            signed_value: 0,
            data: Vec::new(),
        })
    }

    pub fn with_i64(self, field_id: u32, value: i64) -> Self {
        self.with_field(OwnedFieldV1 {
            field_id,
            field_type: field_type::SIGNED,
            unsigned_value: 0,
            signed_value: value,
            data: Vec::new(),
        })
    }

    pub fn with_bool(self, field_id: u32, value: bool) -> Self {
        self.with_field(OwnedFieldV1 {
            field_id,
            field_type: field_type::BOOL,
            unsigned_value: u64::from(value),
            signed_value: 0,
            data: Vec::new(),
        })
    }

    pub fn with_text(self, field_id: u32, value: impl Into<String>) -> Self {
        self.with_field(OwnedFieldV1 {
            field_id,
            field_type: field_type::UTF8,
            unsigned_value: 0,
            signed_value: 0,
            data: value.into().into_bytes(),
        })
    }

    pub fn with_bytes(self, field_id: u32, value: Vec<u8>) -> Self {
        self.with_field(OwnedFieldV1 {
            field_id,
            field_type: field_type::BYTES,
            unsigned_value: 0,
            signed_value: 0,
            data: value,
        })
    }

    fn with_field(mut self, field: OwnedFieldV1) -> Self {
        self.fields.push(field);
        self.rebuild_views();
        self
    }

    fn rebuild_views(&mut self) {
        self.field_views = self.fields.iter().map(OwnedFieldV1::view).collect();
    }

    pub fn view(&self) -> BotaDeviceSdkPacketViewV1 {
        BotaDeviceSdkPacketViewV1 {
            abi_version: ABI_VERSION,
            kind: self.kind,
            operation: self.operation,
            reserved: 0,
            request_id: self.request_id,
            cancellation_id_high: self.cancellation_id_high,
            cancellation_id_low: self.cancellation_id_low,
            fields: if self.field_views.is_empty() {
                std::ptr::null()
            } else {
                self.field_views.as_ptr()
            },
            field_count: self.field_views.len() as u64,
        }
    }
}

fn slice_view(value: &[u8]) -> BotaDeviceSdkSliceV1 {
    if value.is_empty() {
        BotaDeviceSdkSliceV1::default()
    } else {
        BotaDeviceSdkSliceV1 {
            data: value.as_ptr(),
            len: value.len() as u64,
        }
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `packet` must be a live SDK-owned packet and `out_view` must point to
/// writable storage. Fields and slices remain valid until `packet` is freed.
pub unsafe extern "C" fn bota_device_sdk_v1_packet_view(
    packet: *const BotaDeviceSdkPacketV1,
    out_view: *mut BotaDeviceSdkPacketViewV1,
) -> BotaDeviceSdkStatusV1 {
    if packet.is_null() || out_view.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        let packet = unsafe { &*packet };
        unsafe { out_view.write(packet.view()) };
    })) {
        Ok(()) => BotaDeviceSdkStatusV1::Ok,
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `packet` must be null or a live SDK-owned packet that has not been freed.
pub unsafe extern "C" fn bota_device_sdk_v1_packet_free(packet: *mut BotaDeviceSdkPacketV1) {
    if !packet.is_null() {
        drop(unsafe { Box::from_raw(packet) });
    }
}
