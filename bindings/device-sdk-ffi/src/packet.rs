use crate::{ABI_VERSION, BotaDeviceSdkSliceV1, BotaDeviceSdkStatusV1};
use std::{
    array,
    panic::{AssertUnwindSafe, catch_unwind},
};

pub mod kind {
    pub const COMMAND_RANGE_START: u32 = 0x0100;
    pub const COMMAND_DISCOVER_DEVICES: u32 = 0x0101;
    pub const COMMAND_CONNECT: u32 = 0x0102;

    pub const HOST_EVENT_RANGE_START: u32 = 0x0200;
    pub const HOST_EFFECT_RANGE_START: u32 = 0x0300;
    pub const NOTIFICATION_RANGE_START: u32 = 0x0400;
    pub const PROTOCOL_VALUE_RANGE_START: u32 = 0x0500;
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
    pub values: [u64; 4],
    pub signed_values: [i64; 2],
    pub text: [BotaDeviceSdkSliceV1; 4],
    pub bytes: [BotaDeviceSdkSliceV1; 2],
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
            values: [0; 4],
            signed_values: [0; 2],
            text: [BotaDeviceSdkSliceV1::default(); 4],
            bytes: [BotaDeviceSdkSliceV1::default(); 2],
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
    values: [u64; 4],
    signed_values: [i64; 2],
    text: [Vec<u8>; 4],
    bytes: [Vec<u8>; 2],
}

impl BotaDeviceSdkPacketV1 {
    pub fn new(kind: u32) -> Self {
        Self {
            kind,
            operation: 0,
            request_id: 0,
            cancellation_id_high: 0,
            cancellation_id_low: 0,
            values: [0; 4],
            signed_values: [0; 2],
            text: array::from_fn(|_| Vec::new()),
            bytes: array::from_fn(|_| Vec::new()),
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

    pub fn with_value(mut self, index: usize, value: u64) -> Self {
        self.values[index] = value;
        self
    }

    pub fn with_signed_value(mut self, index: usize, value: i64) -> Self {
        self.signed_values[index] = value;
        self
    }

    pub fn with_text(mut self, index: usize, value: impl Into<String>) -> Self {
        self.text[index] = value.into().into_bytes();
        self
    }

    pub fn with_bytes(mut self, index: usize, value: Vec<u8>) -> Self {
        self.bytes[index] = value;
        self
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
            values: self.values,
            signed_values: self.signed_values,
            text: self.text.each_ref().map(|value| slice_view(value)),
            bytes: self.bytes.each_ref().map(|value| slice_view(value)),
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
/// writable storage. Slices in the view remain valid until `packet` is freed.
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
