use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum ErrorCode {
    InvalidInput,
    TruncatedPacket,
    UnknownPacket,
    PayloadTooLarge,
    UnsupportedCapability,
    UnsupportedOperation,
    FeatureUnavailable,
    OperationInProgress,
    UnexpectedEvent,
    DeviceNotFound,
    IdentityMismatch,
    ConnectionFailed,
    PersistenceFailed,
    NotConnected,
    Timeout,
    Cancelled,
    ProtocolRejected,
    IntegrityFailed,
    UploadOwnershipUnknown,
    DownloadFailed,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::TruncatedPacket => "truncated_packet",
            Self::UnknownPacket => "unknown_packet",
            Self::PayloadTooLarge => "payload_too_large",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::UnsupportedOperation => "unsupported_operation",
            Self::FeatureUnavailable => "feature_unavailable",
            Self::OperationInProgress => "operation_in_progress",
            Self::UnexpectedEvent => "unexpected_event",
            Self::DeviceNotFound => "device_not_found",
            Self::IdentityMismatch => "identity_mismatch",
            Self::ConnectionFailed => "connection_failed",
            Self::PersistenceFailed => "persistence_failed",
            Self::NotConnected => "not_connected",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::ProtocolRejected => "protocol_rejected",
            Self::IntegrityFailed => "integrity_failed",
            Self::UploadOwnershipUnknown => "upload_ownership_unknown",
            Self::DownloadFailed => "download_failed",
            Self::Internal => "internal",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum Operation {
    Validate,
    Decode,
    Encode,
    Discover,
    Connect,
    Reconnect,
    Provision,
    TransferRecording,
    Upload,
    UpdateFirmware,
    ReadDeviceLogs,
    FactoryReset,
    Unknown,
}

impl Operation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Validate => "validate",
            Self::Decode => "decode",
            Self::Encode => "encode",
            Self::Discover => "discover",
            Self::Connect => "connect",
            Self::Reconnect => "reconnect",
            Self::Provision => "provision",
            Self::TransferRecording => "transfer_recording",
            Self::Upload => "upload",
            Self::UpdateFirmware => "update_firmware",
            Self::ReadDeviceLogs => "read_device_logs",
            Self::FactoryReset => "factory_reset",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceSdkError {
    pub code: ErrorCode,
    pub operation: Operation,
    pub retryable: bool,
    pub protocol_status: Option<u16>,
    pub detail: Option<String>,
}

impl DeviceSdkError {
    pub const fn new(code: ErrorCode, operation: Operation, retryable: bool) -> Self {
        Self {
            code,
            operation,
            retryable,
            protocol_status: None,
            detail: None,
        }
    }

    pub const fn with_protocol_status(mut self, status: u16) -> Self {
        self.protocol_status = Some(status);
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for DeviceSdkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} during {}",
            self.code.as_str(),
            self.operation.as_str()
        )?;
        if let Some(detail) = &self.detail {
            write!(formatter, ": {detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for DeviceSdkError {}
