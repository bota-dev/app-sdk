use crate::BridgeCore;
use bota_device_sdk_core::{
    engine::{CancellationId, Command, EffectRequest, Event},
    error::DeviceSdkError,
    model::{
        DeviceCandidate, DeviceSerialNumber, FirmwareImage, HostMaterialId, ReconnectHint,
        RecordingSinkId, RecordingUploadProfile, RecordingUuid, UploadProfileSelection,
        UploadProfileSelectionEvidence, UploadSecurityPolicy, supports_encrypted_upload_v2_batch,
        validate_upload_profile_selection,
    },
    protocol::EncryptedUploadV2Capabilities,
    workflow::EncryptedUploadV2BatchRequest,
};

impl BridgeCore {
    pub fn supports_encrypted_upload_v2_batch(
        &self,
        capabilities: EncryptedUploadV2Capabilities,
    ) -> bool {
        supports_encrypted_upload_v2_batch(capabilities)
    }

    pub fn validate_encrypted_upload_v2_profile(
        &self,
        capabilities: EncryptedUploadV2Capabilities,
        recording_generation: u32,
        storage_format: u8,
    ) -> Result<(), DeviceSdkError> {
        validate_upload_profile_selection(
            UploadProfileSelection {
                policy: UploadSecurityPolicy::V2Preferred,
                profile: RecordingUploadProfile::EncryptedUploadV2,
            },
            UploadProfileSelectionEvidence {
                encrypted_upload_v2_capabilities: Some(capabilities),
                recording_generation: Some(recording_generation),
                recording_storage_format: Some(storage_format),
                historical_p10_header_observed: false,
            },
        )?;
        Ok(())
    }

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
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let capabilities = command.required_capabilities();
        #[cfg(test)]
        {
            self.observed_start_capabilities = Some(capabilities.clone());
            self.observed_start_command = Some(command.clone());
        }
        self.engine.start(
            command,
            &capabilities,
            CancellationId::from_bytes(cancellation_id),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERIAL: &str = "EVFXXW67KP";
    const CANCELLATION_ID: [u8; 16] = [0x11; 16];
    const RECORDING_UUID: [u8; 16] = [0x22; 16];

    fn assert_start_capabilities(
        start: impl FnOnce(&mut BridgeCore) -> Result<Vec<EffectRequest>, DeviceSdkError>,
    ) {
        let mut bridge = BridgeCore::default();
        start(&mut bridge).expect("typed workflow start should succeed");
        let expected = bridge
            .observed_start_command
            .as_ref()
            .expect("typed start records its command")
            .required_capabilities();
        assert_eq!(bridge.observed_start_capabilities.as_ref(), Some(&expected));
    }

    #[test]
    fn typed_starts_supply_only_their_exact_required_capabilities() {
        assert_start_capabilities(|bridge| {
            bridge.start_exact_connection(
                SERIAL,
                "browser-peripheral-1",
                Some("Bota Pin"),
                CANCELLATION_ID,
            )
        });
        assert_start_capabilities(|bridge| {
            bridge.start_reconnect(SERIAL, ReconnectHint::default(), CANCELLATION_ID)
        });
        assert_start_capabilities(|bridge| {
            bridge.start_provisioning(SERIAL, "web-material-1", CANCELLATION_ID)
        });
        assert_start_capabilities(|bridge| {
            bridge.start_recording_transfer(
                SERIAL,
                RECORDING_UUID,
                "web-sink-1",
                4_096,
                CANCELLATION_ID,
            )
        });
        assert_start_capabilities(|bridge| {
            bridge.start_encrypted_upload_v2(
                SERIAL,
                RECORDING_UUID,
                9,
                bota_device_sdk_core::generated::protocol::STORAGE_FORMAT_BOTA_ENC_V2,
                [0x44; 16],
                3,
                0x1122_3344_5566,
                "web-v2-material-1",
                "web-v2-sink-1",
                UploadSecurityPolicy::V2Preferred,
                EncryptedUploadV2Capabilities {
                    flags: 0x7f,
                    maximum_signed_blob_bytes: 1_024,
                    maximum_manifest_bytes: 1_024,
                    maximum_data_payload_bytes: 244,
                    maximum_window_packets: 16,
                    durable_checkpoint_interval_blocks: 8,
                    maximum_missing_sequences: 16,
                },
                16,
                244,
                330,
                [0x33; 32],
                CANCELLATION_ID,
            )
        });
        assert_start_capabilities(|bridge| {
            bridge.start_firmware_update(
                SERIAL,
                "1.0.18",
                1_024,
                0x1234_5678,
                41,
                ReconnectHint::default(),
                CANCELLATION_ID,
            )
        });
        assert_start_capabilities(|bridge| bridge.start_device_logs(SERIAL, CANCELLATION_ID));
    }
}
