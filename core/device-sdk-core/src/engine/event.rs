use crate::engine::WorkflowCheckpoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Ble(BleEvent),
    TimerFired {
        timer_id: u64,
    },
    CheckpointLoaded {
        checkpoint: Option<WorkflowCheckpoint>,
    },
    CheckpointSaved,
    SecretLoaded {
        key: String,
        value: Option<Vec<u8>>,
    },
    SecretStored {
        key: String,
    },
    Network(NetworkEvent),
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum BleEvent {
    ScanResult {
        peripheral_id: String,
        name: Option<String>,
        advertisement: Vec<u8>,
    },
    ScanStopped,
    Connected {
        peripheral_id: String,
    },
    Disconnected {
        peripheral_id: String,
        reason_code: Option<u16>,
    },
    ReadCompleted {
        request_id: u64,
        value: Vec<u8>,
    },
    WriteCompleted {
        request_id: u64,
    },
    Notification {
        characteristic_uuid: String,
        value: Vec<u8>,
    },
    Failed {
        request_id: u64,
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
