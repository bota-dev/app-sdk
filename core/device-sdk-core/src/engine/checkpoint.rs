use crate::{
    error::Operation,
    model::{DeviceSerialNumber, RecordingUuid},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WorkflowKind {
    Discovery,
    Connection,
    Provisioning,
    RecordingTransfer,
    RecordingUpload,
    FirmwareUpdate,
    DeviceLogs,
    FactoryReset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CheckpointPhase {
    Pending,
    Connecting,
    Transferring,
    Uploading,
    Verifying,
    Reconnecting,
    AwaitingReceipt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowCheckpoint {
    pub workflow: WorkflowKind,
    pub operation: Operation,
    pub device: DeviceSerialNumber,
    pub recording: Option<RecordingUuid>,
    pub phase: CheckpointPhase,
    pub completed_units: u64,
    pub retry_count: u16,
}
