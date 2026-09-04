use crate::{
    engine::CancellationId,
    error::{DeviceSdkError, Operation},
    model::{
        ConnectionMode, DeviceCandidate, DeviceSerialNumber, FirmwareUpdateProgress, RecordingUuid,
        UploadDestinationId, UploadSessionId,
    },
    protocol::DeviceLogEvent,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WorkflowStatus {
    Idle,
    Running {
        operation: Operation,
        cancellation_id: CancellationId,
    },
    Completed {
        operation: Operation,
    },
    Cancelled {
        operation: Operation,
    },
    Failed {
        error: DeviceSdkError,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WorkflowNotification {
    Started {
        operation: Operation,
    },
    DeviceDiscovered {
        candidate: DeviceCandidate,
    },
    ConnectionEstablished {
        device: DeviceSerialNumber,
        candidate: DeviceCandidate,
        mode: ConnectionMode,
    },
    Progress {
        operation: Operation,
        completed_units: u64,
        total_units: u64,
    },
    Retrying {
        operation: Operation,
        attempt: u32,
    },
    DeviceUploadPreserved {
        upload_id: UploadSessionId,
    },
    BleFallbackReady {
        recording: RecordingUuid,
        upload_id: UploadSessionId,
        destination_id: UploadDestinationId,
    },
    FirmwareProgress {
        progress: FirmwareUpdateProgress,
    },
    DeviceLog {
        event: DeviceLogEvent,
    },
    RecordingTransferCompleted {
        encrypted: bool,
        sha256: Option<Vec<u8>>,
    },
    StreamingPaused {
        completed_units: u64,
    },
    StreamingResumed,
    StreamingCompleted {
        total_units: u64,
        uploaded_chunks: u32,
        encrypted: bool,
    },
    EncryptedUploadV2Staged {
        upload_session_uuid: [u8; 16],
        owner_revision: u32,
        ciphertext_length: u64,
        ciphertext_sha256: [u8; 32],
        manifest_length: u16,
        manifest_sha256: [u8; 32],
    },
    Completed {
        operation: Operation,
    },
    Cancelled {
        operation: Operation,
    },
    Failed {
        error: DeviceSdkError,
    },
}
