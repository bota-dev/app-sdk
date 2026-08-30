use bota_device_sdk_core::error::{DeviceSdkError, ErrorCode, Operation};
use std::ptr;

pub const ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BotaDeviceSdkStatusV1 {
    Ok = 0,
    NoOutput = 1,
    InvalidArgument = -1,
    OperationFailed = -2,
    Panic = -3,
    UnsupportedAbi = -4,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BotaDeviceSdkSliceV1 {
    pub data: *const u8,
    pub len: u64,
}

impl Default for BotaDeviceSdkSliceV1 {
    fn default() -> Self {
        Self {
            data: ptr::null(),
            len: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BotaDeviceSdkErrorViewV1 {
    pub abi_version: u32,
    pub code: u32,
    pub operation: u32,
    pub retryable: u8,
    pub has_protocol_status: u8,
    pub protocol_status: u16,
    pub detail: BotaDeviceSdkSliceV1,
}

#[repr(C)]
pub struct BotaDeviceSdkErrorV1 {
    code: u32,
    operation: u32,
    retryable: bool,
    protocol_status: Option<u16>,
    detail: Vec<u8>,
}

impl From<DeviceSdkError> for BotaDeviceSdkErrorV1 {
    fn from(error: DeviceSdkError) -> Self {
        Self {
            code: error_code(error.code),
            operation: operation_code(error.operation),
            retryable: error.retryable,
            protocol_status: error.protocol_status,
            detail: error.detail.unwrap_or_default().into_bytes(),
        }
    }
}

impl BotaDeviceSdkErrorV1 {
    pub fn view(&self) -> BotaDeviceSdkErrorViewV1 {
        BotaDeviceSdkErrorViewV1 {
            abi_version: ABI_VERSION,
            code: self.code,
            operation: self.operation,
            retryable: u8::from(self.retryable),
            has_protocol_status: u8::from(self.protocol_status.is_some()),
            protocol_status: self.protocol_status.unwrap_or_default(),
            detail: if self.detail.is_empty() {
                BotaDeviceSdkSliceV1::default()
            } else {
                BotaDeviceSdkSliceV1 {
                    data: self.detail.as_ptr(),
                    len: self.detail.len() as u64,
                }
            },
        }
    }
}

pub const fn error_code(code: ErrorCode) -> u32 {
    match code {
        ErrorCode::InvalidInput => 1,
        ErrorCode::TruncatedPacket => 2,
        ErrorCode::UnknownPacket => 3,
        ErrorCode::PayloadTooLarge => 4,
        ErrorCode::UnsupportedCapability => 5,
        ErrorCode::UnsupportedOperation => 6,
        ErrorCode::FeatureUnavailable => 7,
        ErrorCode::OperationInProgress => 8,
        ErrorCode::UnexpectedEvent => 9,
        ErrorCode::DeviceNotFound => 10,
        ErrorCode::IdentityMismatch => 11,
        ErrorCode::ConnectionFailed => 12,
        ErrorCode::PersistenceFailed => 13,
        ErrorCode::NotConnected => 14,
        ErrorCode::Timeout => 15,
        ErrorCode::Cancelled => 16,
        ErrorCode::ProtocolRejected => 17,
        ErrorCode::IntegrityFailed => 18,
        ErrorCode::UploadOwnershipUnknown => 19,
        ErrorCode::DownloadFailed => 20,
        ErrorCode::Internal => 21,
        _ => 21,
    }
}

pub const fn operation_code(operation: Operation) -> u32 {
    match operation {
        Operation::Validate => 1,
        Operation::Decode => 2,
        Operation::Encode => 3,
        Operation::Discover => 4,
        Operation::Connect => 5,
        Operation::Reconnect => 6,
        Operation::Provision => 7,
        Operation::TransferRecording => 8,
        Operation::Upload => 9,
        Operation::UpdateFirmware => 10,
        Operation::ReadDeviceLogs => 11,
        Operation::FactoryReset => 12,
        Operation::Unknown => 13,
        _ => 13,
    }
}

pub fn internal_error(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::Internal, Operation::Unknown, false).with_detail(detail)
}
