use crate::BridgeCore;
use bota_device_sdk_core::{
    engine::{CancellationId, Capability, CapabilitySet, Command, EffectRequest, Event},
    error::DeviceSdkError,
    model::{
        DeviceCandidate, DeviceSerialNumber, FirmwareImage, HostMaterialId, ReconnectHint,
        RecordingSinkId, RecordingUploadProfile, RecordingUuid, UploadProfileSelection,
        UploadSecurityPolicy,
    },
    protocol::EncryptedUploadV2Capabilities,
    workflow::EncryptedUploadV2BatchRequest,
};

impl BridgeCore {
    pub fn start_exact_connection(
        &mut self,
        expected_serial: &str,
        peripheral_id: &str,
        name: Option<&str>,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::Connect {
                device: DeviceSerialNumber::new(expected_serial)?,
                candidate: DeviceCandidate {
                    peripheral_id: peripheral_id.to_owned(),
                    name: name.map(str::to_owned),
                    advertised_address: None,
                    rssi: 0,
                },
            },
            CapabilitySet::from([Capability::Ble, Capability::Timer, Capability::Persistence]),
            cancellation_id,
        )
    }

    pub fn start_reconnect(
        &mut self,
        expected_serial: &str,
        hint: ReconnectHint,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::Reconnect {
                device: DeviceSerialNumber::new(expected_serial)?,
                hint,
            },
            CapabilitySet::from([Capability::Ble, Capability::Timer, Capability::Persistence]),
            cancellation_id,
        )
    }

    pub fn start_provisioning(
        &mut self,
        serial_number: &str,
        material_id: &str,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::Provision {
                device: DeviceSerialNumber::new(serial_number)?,
                material_id: HostMaterialId::new(material_id)?,
            },
            CapabilitySet::from([
                Capability::Ble,
                Capability::Timer,
                Capability::Persistence,
                Capability::HostMaterial,
            ]),
            cancellation_id,
        )
    }

    pub fn start_recording_transfer(
        &mut self,
        serial_number: &str,
        recording_uuid: [u8; 16],
        sink_id: &str,
        total_units: u64,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::TransferRecording {
                device: DeviceSerialNumber::new(serial_number)?,
                recording: RecordingUuid::from_bytes(recording_uuid),
                sink_id: RecordingSinkId::new(sink_id)?,
                total_units,
                confirm_on_completion: false,
            },
            CapabilitySet::from([
                Capability::Ble,
                Capability::Persistence,
                Capability::Progress,
                Capability::RecordingSink,
                Capability::Timer,
            ]),
            cancellation_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_encrypted_upload_v2(
        &mut self,
        serial_number: &str,
        recording_uuid: [u8; 16],
        recording_generation: u32,
        storage_format: u8,
        upload_session_uuid: [u8; 16],
        owner_revision: u32,
        transport_session_id: u64,
        material_id: &str,
        sink_id: &str,
        policy: UploadSecurityPolicy,
        capabilities: EncryptedUploadV2Capabilities,
        window_packets: u16,
        data_payload_bytes: u16,
        ciphertext_length: u64,
        ciphertext_sha256: [u8; 32],
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::TransferEncryptedRecording {
                request: EncryptedUploadV2BatchRequest {
                    device: DeviceSerialNumber::new(serial_number)?,
                    recording: RecordingUuid::from_bytes(recording_uuid),
                    recording_generation,
                    storage_format,
                    upload_session_uuid,
                    owner_revision,
                    transport_session_id,
                    material_id: HostMaterialId::new(material_id)?,
                    sink_id: RecordingSinkId::new(sink_id)?,
                    selection: UploadProfileSelection {
                        policy,
                        profile: RecordingUploadProfile::EncryptedUploadV2,
                    },
                    capabilities,
                    window_packets,
                    data_payload_bytes,
                    ciphertext_length,
                    ciphertext_sha256,
                },
            },
            CapabilitySet::from([
                Capability::Ble,
                Capability::Persistence,
                Capability::Progress,
                Capability::HostMaterial,
                Capability::RecordingSink,
                Capability::NetworkTransfer,
            ]),
            cancellation_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_firmware_update(
        &mut self,
        serial_number: &str,
        version: &str,
        size_bytes: u32,
        crc32: u32,
        download_id: u64,
        reconnect_hint: ReconnectHint,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::UpdateFirmware {
                device: DeviceSerialNumber::new(serial_number)?,
                image: FirmwareImage {
                    version: version.to_owned(),
                    size_bytes,
                    crc32,
                },
                download_id,
                reconnect_hint,
            },
            CapabilitySet::from([
                Capability::Ble,
                Capability::NetworkTransfer,
                Capability::Persistence,
                Capability::Progress,
                Capability::Timer,
                Capability::FirmwareBlob,
            ]),
            cancellation_id,
        )
    }

    pub fn start_device_logs(
        &mut self,
        serial_number: &str,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.start(
            Command::ReadDeviceLogs {
                device: DeviceSerialNumber::new(serial_number)?,
            },
            CapabilitySet::from([Capability::Ble]),
            cancellation_id,
        )
    }

    pub fn cancel(
        &mut self,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.engine.dispatch(Event::Cancelled {
            cancellation_id: CancellationId::from_bytes(cancellation_id),
        })
    }

    fn start(
        &mut self,
        command: Command,
        capabilities: CapabilitySet,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.engine.start(
            command,
            &capabilities,
            CancellationId::from_bytes(cancellation_id),
        )
    }
}
