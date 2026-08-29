use crate::{engine::WorkflowCheckpoint, error::Operation};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct CancellationId([u8; 16]);

impl CancellationId {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EffectRequest {
    pub operation: Operation,
    pub cancellation_id: CancellationId,
    pub effect: Effect,
}

impl EffectRequest {
    pub const fn new(
        operation: Operation,
        cancellation_id: CancellationId,
        effect: Effect,
    ) -> Self {
        Self {
            operation,
            cancellation_id,
            effect,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Effect {
    Timer(TimerEffect),
    Persistence(PersistenceEffect),
    SecureStorage(SecureStorageEffect),
    Ble(BleEffect),
    Network(NetworkEffect),
    Progress(ProgressEffect),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TimerEffect {
    Schedule { timer_id: u64, delay_ms: u64 },
    Cancel { timer_id: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum PersistenceEffect {
    LoadCheckpoint,
    SaveCheckpoint { checkpoint: WorkflowCheckpoint },
    DeleteCheckpoint,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SecureStorageEffect {
    Read { key: String },
    Write { key: String, value: Vec<u8> },
    Delete { key: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum BleEffect {
    StartScan {
        allow_duplicates: bool,
    },
    StopScan,
    Connect {
        peripheral_id: String,
    },
    Disconnect {
        peripheral_id: String,
    },
    Read {
        service_uuid: String,
        characteristic_uuid: String,
    },
    Write {
        service_uuid: String,
        characteristic_uuid: String,
        payload: Vec<u8>,
        with_response: bool,
    },
    Subscribe {
        service_uuid: String,
        characteristic_uuid: String,
    },
    Unsubscribe {
        service_uuid: String,
        characteristic_uuid: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum UploadSource {
    HostFile,
    RecordingTransfer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum NetworkEffect {
    Download {
        download_id: u64,
    },
    Upload {
        upload_id: u64,
        source: UploadSource,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProgressEffect {
    pub completed_units: u64,
    pub total_units: u64,
}
