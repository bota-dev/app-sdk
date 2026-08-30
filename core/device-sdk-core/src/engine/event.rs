use crate::engine::{CancellationId, RequestId, WorkflowCheckpoint};
use crate::model::{DeviceCandidate, ProvisioningMaterial};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Host(HostEvent),
    Cancelled { cancellation_id: CancellationId },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HostEvent {
    pub request_id: RequestId,
    pub kind: HostEventKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum HostEventKind {
    Ble(BleEvent),
    TimerFired {
        timer_id: u64,
    },
    CheckpointLoaded {
        checkpoint: Option<WorkflowCheckpoint>,
    },
    CheckpointSaved,
    ConnectionIdentitySaved,
    FactoryResetResultSaved,
    FactoryResetResultDeleted,
    PersistenceFailed {
        platform_code: Option<i64>,
    },
    ProvisioningMaterialPrepared {
        material: ProvisioningMaterial,
    },
    FactoryResetGrantPrepared {
        grant: Vec<u8>,
    },
    HostMaterialFailed {
        platform_code: Option<i64>,
    },
    RecordingSinkTruncated,
    RecordingSinkAppendCompleted {
        durable_units: u64,
    },
    RecordingSinkFinalized {
        durable_units: u64,
    },
    RecordingSinkIntegrityFailed,
    RecordingSinkFailed {
        platform_code: Option<i64>,
    },
    FirmwareChunkRead {
        download_id: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    FirmwareBlobFailed {
        platform_code: Option<i64>,
    },
    SecretLoaded {
        key: String,
        value: Option<Vec<u8>>,
    },
    SecretStored {
        key: String,
    },
    Network(NetworkEvent),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum BleEvent {
    ScanResult {
        candidate: DeviceCandidate,
    },
    ScanStopped,
    Connected {
        peripheral_id: String,
    },
    ServicesDiscovered {
        peripheral_id: String,
    },
    Subscribed {
        characteristic_uuid: String,
    },
    Disconnected {
        peripheral_id: String,
        reason_code: Option<u16>,
    },
    ReadCompleted {
        value: Vec<u8>,
    },
    WriteCompleted,
    Notification {
        characteristic_uuid: String,
        value: Vec<u8>,
    },
    Failed {
        platform_code: Option<i64>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum NetworkEvent {
    DownloadProgress {
        download_id: u64,
        completed_bytes: u64,
        total_bytes: Option<u64>,
    },
    DownloadCompleted {
        download_id: u64,
    },
    UploadProgress {
        upload_id: u64,
        completed_bytes: u64,
        total_bytes: u64,
    },
    UploadCompleted {
        upload_id: u64,
    },
    Failed {
        transfer_id: u64,
        status_code: Option<u16>,
    },
}
