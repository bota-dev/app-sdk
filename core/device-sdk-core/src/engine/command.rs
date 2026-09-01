use crate::{
    engine::{Capability, CapabilitySet},
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        DeviceCandidate, DeviceSerialNumber, FactoryResetCommandId, FactoryResetResult,
        FirmwareImage, HostMaterialId, ReconnectHint, RecordingSinkId, RecordingUuid,
        UploadDestinationId, UploadSessionId,
    },
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
    ConnectSelected {
        candidate: DeviceCandidate,
    },
    Reconnect {
        device: DeviceSerialNumber,
        hint: ReconnectHint,
    },
    Provision {
        device: DeviceSerialNumber,
        material_id: HostMaterialId,
    },
    TransferRecording {
        device: DeviceSerialNumber,
        recording: RecordingUuid,
        sink_id: RecordingSinkId,
        total_units: u64,
        confirm_on_completion: bool,
    },
    UploadRecording {
        device: DeviceSerialNumber,
        recording: RecordingUuid,
        upload_id: UploadSessionId,
        destination_id: UploadDestinationId,
    },
    UpdateFirmware {
        device: DeviceSerialNumber,
        image: FirmwareImage,
        download_id: u64,
        reconnect_hint: ReconnectHint,
    },
    ReadDeviceLogs {
        device: DeviceSerialNumber,
    },
    FactoryReset {
        device: DeviceSerialNumber,
        command_id: FactoryResetCommandId,
        grant_id: HostMaterialId,
    },
    ResumeFactoryReset {
        device: DeviceSerialNumber,
        command_id: FactoryResetCommandId,
        expected_result: Option<FactoryResetResult>,
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
            Self::Connect { .. } | Self::ConnectSelected { .. } => Operation::Connect,
            Self::Reconnect { .. } => Operation::Reconnect,
            Self::Provision { .. } => Operation::Provision,
            Self::TransferRecording { .. } => Operation::TransferRecording,
            Self::UploadRecording { .. } => Operation::Upload,
            Self::UpdateFirmware { .. } => Operation::UpdateFirmware,
            Self::ReadDeviceLogs { .. } => Operation::ReadDeviceLogs,
            Self::FactoryReset { .. } => Operation::FactoryReset,
            Self::ResumeFactoryReset { .. } => Operation::FactoryReset,
        }
    }

    const fn required_capabilities(&self) -> &'static [Capability] {
        match self {
            Self::DiscoverDevices { .. } => &[Capability::Ble, Capability::Timer],
            Self::Connect { .. } | Self::ConnectSelected { .. } | Self::Reconnect { .. } => {
                &[Capability::Ble, Capability::Timer, Capability::Persistence]
            }
            Self::ReadDeviceLogs { .. } => &[Capability::Ble],
            Self::Provision { .. } | Self::FactoryReset { .. } => &[
                Capability::Ble,
                Capability::Timer,
                Capability::Persistence,
                Capability::HostMaterial,
            ],
            Self::ResumeFactoryReset { .. } => {
                &[Capability::Ble, Capability::Timer, Capability::Persistence]
            }
            Self::TransferRecording { .. } => &[
                Capability::Ble,
                Capability::Persistence,
                Capability::Progress,
                Capability::RecordingSink,
                Capability::Timer,
            ],
            Self::UploadRecording { .. } => {
                &[Capability::Ble, Capability::Timer, Capability::Progress]
            }
            Self::UpdateFirmware { .. } => &[
                Capability::Ble,
                Capability::NetworkTransfer,
                Capability::Persistence,
                Capability::Progress,
                Capability::Timer,
                Capability::FirmwareBlob,
            ],
        }
    }
}
