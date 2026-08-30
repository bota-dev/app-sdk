use crate::{
    engine::{RequestId, WorkflowCheckpoint, WorkflowNotification},
    error::Operation,
    model::{
        DeviceCandidate, DevicePublicKey, DeviceSerialNumber, DurableFactoryResetResult,
        FactoryResetCommandId, HostMaterialId, ProvisioningNonce, RecordingSinkId,
    },
};
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
    pub request_id: RequestId,
    pub operation: Operation,
    pub cancellation_id: CancellationId,
    pub effect: Effect,
}

impl EffectRequest {
    pub const fn new(
        request_id: RequestId,
        operation: Operation,
        cancellation_id: CancellationId,
        effect: Effect,
    ) -> Self {
        Self {
            request_id,
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
    Notify(WorkflowNotification),
    HostMaterial(HostMaterialEffect),
    RecordingSink(RecordingSinkEffect),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TimerEffect {
    Schedule { timer_id: u64, delay_ms: u64 },
    Cancel { timer_id: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum PersistenceEffect {
    LoadCheckpoint,
    SaveCheckpoint {
        checkpoint: WorkflowCheckpoint,
    },
    DeleteCheckpoint,
    SaveConnectionIdentity {
        device: DeviceSerialNumber,
        candidate: DeviceCandidate,
    },
    SaveFactoryResetResult {
        result: DurableFactoryResetResult,
    },
    DeleteFactoryResetResult {
        command_id: FactoryResetCommandId,
    },
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
    DiscoverServices {
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum HostMaterialEffect {
    PrepareProvisioning {
        material_id: HostMaterialId,
        device: DeviceSerialNumber,
        nonce: ProvisioningNonce,
        device_public_key: DevicePublicKey,
    },
    PrepareFactoryResetGrant {
        grant_id: HostMaterialId,
        device: DeviceSerialNumber,
        nonce: ProvisioningNonce,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RecordingSinkEffect {
    Truncate {
        sink_id: RecordingSinkId,
        completed_units: u64,
    },
    Append {
        sink_id: RecordingSinkId,
        sequence: u16,
        payload: Vec<u8>,
    },
    Finalize {
        sink_id: RecordingSinkId,
        expected_crc32: Option<u32>,
    },
    Discard {
        sink_id: RecordingSinkId,
    },
}
