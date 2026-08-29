use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FirmwareImage {
    pub version: String,
    pub size_bytes: u32,
    pub crc32: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FirmwareUpdatePhase {
    Downloading,
    AwaitingDevice,
    Transferring,
    Verifying,
    Rebooting,
    Reconnecting,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FirmwareUpdateProgress {
    pub phase: FirmwareUpdatePhase,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}
