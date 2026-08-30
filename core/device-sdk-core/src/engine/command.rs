use crate::{
    engine::{Capability, CapabilitySet},
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{DeviceCandidate, DeviceSerialNumber, FirmwareImage, ReconnectHint, RecordingUuid},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Command {
    DiscoverDevices {
        timeout_ms: u64,
        allow_duplicates: bool,
    },
    Connect {
        device: DeviceSerialNumber,
        candidate: DeviceCandidate,
    },
    Reconnect {
        device: DeviceSerialNumber,
        hint: ReconnectHint,
    },
    Provision {
        device: DeviceSerialNumber,
    },
    TransferRecording {
        device: DeviceSerialNumber,
        recording: RecordingUuid,
    },
    UploadRecording {
        recording: RecordingUuid,
    },
    UpdateFirmware {
        device: DeviceSerialNumber,
        image: FirmwareImage,
    },
    ReadDeviceLogs {
        device: DeviceSerialNumber,
    },
    FactoryReset {
        device: DeviceSerialNumber,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedCommand(Command);

impl AuthorizedCommand {
    pub fn command(&self) -> &Command {
        &self.0
    }
}

impl Command {
    pub fn authorize(
        &self,
        capabilities: &CapabilitySet,
    ) -> Result<AuthorizedCommand, DeviceSdkError> {
        for capability in self.required_capabilities() {
            if !capabilities.contains(*capability) {
                return Err(DeviceSdkError::new(
                    ErrorCode::UnsupportedCapability,
                    self.operation(),
                    false,
                )
                .with_detail(format!("host does not provide {capability:?}")));
            }
        }
        Ok(AuthorizedCommand(self.clone()))
    }

    pub const fn operation(&self) -> Operation {
        match self {
            Self::DiscoverDevices { .. } => Operation::Discover,
            Self::Connect { .. } => Operation::Connect,
            Self::Reconnect { .. } => Operation::Reconnect,
            Self::Provision { .. } => Operation::Provision,
            Self::TransferRecording { .. } => Operation::TransferRecording,
            Self::UploadRecording { .. } => Operation::Upload,
            Self::UpdateFirmware { .. } => Operation::UpdateFirmware,
            Self::ReadDeviceLogs { .. } => Operation::ReadDeviceLogs,
            Self::FactoryReset { .. } => Operation::FactoryReset,
        }
    }

    const fn required_capabilities(&self) -> &'static [Capability] {
        match self {
            Self::DiscoverDevices { .. } => &[Capability::Ble, Capability::Timer],
            Self::Connect { .. } | Self::Reconnect { .. } => {
                &[Capability::Ble, Capability::Timer, Capability::Persistence]
            }
            Self::ReadDeviceLogs { .. } => &[Capability::Ble],
            Self::Provision { .. } | Self::FactoryReset { .. } => {
                &[Capability::Ble, Capability::SecureStorage]
            }
            Self::TransferRecording { .. } => &[
                Capability::Ble,
                Capability::Persistence,
                Capability::Progress,
            ],
            Self::UploadRecording { .. } => &[
                Capability::NetworkTransfer,
                Capability::Persistence,
                Capability::Progress,
            ],
            Self::UpdateFirmware { .. } => &[
                Capability::Ble,
                Capability::NetworkTransfer,
                Capability::Persistence,
                Capability::Progress,
            ],
        }
    }
}
