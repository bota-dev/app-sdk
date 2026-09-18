use bota_device_sdk_core::{
    engine::{EffectRequest, Event, HostEvent, WorkflowEngine, WorkflowStatus},
    error::DeviceSdkError,
    model::DeviceStatus,
    protocol::{
        EncryptedUploadV2Capabilities, decode_encrypted_upload_v2_capabilities, parse_device_status,
    },
};

mod workflows;

#[derive(Default)]
pub struct BridgeCore {
    engine: WorkflowEngine,
}

impl BridgeCore {
    pub fn dispatch(&mut self, event: HostEvent) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.engine.dispatch(Event::Host(event))
    }

    pub const fn status(&self) -> &WorkflowStatus {
        self.engine.status()
    }
}

pub fn decode_device_status_dto(bytes: &[u8]) -> Result<DeviceStatus, DeviceSdkError> {
    parse_device_status(bytes)
}

pub fn decode_encrypted_upload_v2_capabilities_dto(
    bytes: &[u8],
) -> Result<EncryptedUploadV2Capabilities, DeviceSdkError> {
    decode_encrypted_upload_v2_capabilities(bytes)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{
        BridgeCore, decode_device_status_dto, decode_encrypted_upload_v2_capabilities_dto,
    };
    use bota_device_sdk_core::{
        engine::HostEvent,
        error::{DeviceSdkError, ErrorCode, Operation},
        model::{ReconnectHint, RecordingUuid, UploadSecurityPolicy},
        protocol::EncryptedUploadV2Capabilities,
    };
    use serde::{Deserialize, Serialize, de::DeserializeOwned};
    use wasm_bindgen::prelude::*;

    #[derive(Deserialize)]
    struct ReconnectInput {
        expected_serial: String,
        hint: ReconnectHint,
        cancellation_id: Vec<u8>,
    }

    #[derive(Deserialize)]
    struct ProvisioningInput {
        serial_number: String,
        material_id: String,
        cancellation_id: Vec<u8>,
    }

    #[derive(Deserialize)]
    struct RecordingTransferInput {
        serial_number: String,
        recording_uuid: String,
        sink_id: String,
        total_units: u64,
        cancellation_id: Vec<u8>,
    }

    #[derive(Deserialize)]
    struct EncryptedUploadV2Input {
        serial_number: String,
        recording_uuid: String,
        recording_generation: u32,
        storage_format: u8,
        upload_session_id: String,
        owner_revision: u32,
        transport_session_id: u64,
        material_id: String,
        sink_id: String,
        policy: UploadSecurityPolicy,
        capabilities: EncryptedUploadV2Capabilities,
        window_packets: u16,
        data_payload_bytes: u16,
        ciphertext_length: u64,
        ciphertext_sha256: Vec<u8>,
        cancellation_id: Vec<u8>,
    }

    #[derive(Deserialize)]
    struct FirmwareUpdateInput {
        serial_number: String,
        version: String,
        size_bytes: u32,
        crc32: u32,
        download_id: u64,
        reconnect_hint: ReconnectHint,
        cancellation_id: Vec<u8>,
    }

    #[derive(Deserialize)]
    struct DeviceLogsInput {
        serial_number: String,
        cancellation_id: Vec<u8>,
    }

    #[wasm_bindgen]
    pub struct WebCoreBridge {
        inner: BridgeCore,
    }

    #[wasm_bindgen]
    impl WebCoreBridge {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: BridgeCore::default(),
            }
        }

        #[wasm_bindgen(js_name = startExactConnection)]
        pub fn start_exact_connection(
            &mut self,
            expected_serial: &str,
            peripheral_id: &str,
            name: Option<String>,
            cancellation_id: &[u8],
        ) -> Result<JsValue, JsValue> {
            let cancellation_id: [u8; 16] = cancellation_id.try_into().map_err(|_| {
                error_to_js(
                    DeviceSdkError::new(
                        bota_device_sdk_core::error::ErrorCode::InvalidInput,
                        bota_device_sdk_core::error::Operation::Connect,
                        false,
                    )
                    .with_detail("cancellation ID must contain exactly 16 bytes"),
                )
            })?;
            let effects = self
                .inner
                .start_exact_connection(
                    expected_serial,
                    peripheral_id,
                    name.as_deref(),
                    cancellation_id,
                )
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startReconnect)]
        pub fn start_reconnect(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: ReconnectInput = from_js(input)?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_reconnect(&input.expected_serial, input.hint, cancellation_id)
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startProvisioning)]
        pub fn start_provisioning(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: ProvisioningInput = from_js(input)?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_provisioning(&input.serial_number, &input.material_id, cancellation_id)
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startRecordingTransfer)]
        pub fn start_recording_transfer(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: RecordingTransferInput = from_js(input)?;
            let recording_uuid = uuid_bytes(&input.recording_uuid)?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_recording_transfer(
                    &input.serial_number,
                    recording_uuid,
                    &input.sink_id,
                    input.total_units,
                    cancellation_id,
                )
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startEncryptedUploadV2)]
        pub fn start_encrypted_upload_v2(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: EncryptedUploadV2Input = from_js(input)?;
            let recording_uuid = uuid_bytes(&input.recording_uuid)?;
            let upload_session_id = uuid_bytes(&input.upload_session_id)?;
            let ciphertext_sha256 = fixed_bytes(&input.ciphertext_sha256, "ciphertext SHA-256")?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_encrypted_upload_v2(
                    &input.serial_number,
                    recording_uuid,
                    input.recording_generation,
                    input.storage_format,
                    upload_session_id,
                    input.owner_revision,
                    input.transport_session_id,
                    &input.material_id,
                    &input.sink_id,
                    input.policy,
                    input.capabilities,
                    input.window_packets,
                    input.data_payload_bytes,
                    input.ciphertext_length,
                    ciphertext_sha256,
                    cancellation_id,
                )
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startFirmwareUpdate)]
        pub fn start_firmware_update(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: FirmwareUpdateInput = from_js(input)?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_firmware_update(
                    &input.serial_number,
                    &input.version,
                    input.size_bytes,
                    input.crc32,
                    input.download_id,
                    input.reconnect_hint,
                    cancellation_id,
                )
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        #[wasm_bindgen(js_name = startDeviceLogs)]
        pub fn start_device_logs(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
            let input: DeviceLogsInput = from_js(input)?;
            let cancellation_id = fixed_bytes(&input.cancellation_id, "cancellation ID")?;
            let effects = self
                .inner
                .start_device_logs(&input.serial_number, cancellation_id)
                .map_err(error_to_js)?;
            to_js(&effects)
        }

        pub fn cancel(&mut self, cancellation_id: &[u8]) -> Result<JsValue, JsValue> {
            let cancellation_id = fixed_bytes(cancellation_id, "cancellation ID")?;
            let effects = self.inner.cancel(cancellation_id).map_err(error_to_js)?;
            to_js(&effects)
        }

        pub fn dispatch(&mut self, event: JsValue) -> Result<JsValue, JsValue> {
            let event: HostEvent = from_js(event)?;
            let effects = self.inner.dispatch(event).map_err(error_to_js)?;
            to_js(&effects)
        }

        pub fn status(&self) -> Result<JsValue, JsValue> {
            to_js(self.inner.status())
        }
    }

    #[wasm_bindgen(js_name = decodeDeviceStatus)]
    pub fn decode_device_status(bytes: &[u8]) -> Result<JsValue, JsValue> {
        let status = decode_device_status_dto(bytes).map_err(error_to_js)?;
        to_js(&status)
    }

    #[wasm_bindgen(js_name = decodeEncryptedUploadV2Capabilities)]
    pub fn decode_encrypted_upload_v2_capabilities(bytes: &[u8]) -> Result<JsValue, JsValue> {
        let capabilities =
            decode_encrypted_upload_v2_capabilities_dto(bytes).map_err(error_to_js)?;
        to_js(&capabilities)
    }

    fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
        value
            .serialize(
                &serde_wasm_bindgen::Serializer::new()
                    .serialize_maps_as_objects(true)
                    .serialize_large_number_types_as_bigints(true),
            )
            .map_err(|_| JsValue::from_str("internal_error"))
    }

    fn from_js<T: DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
        serde_wasm_bindgen::from_value(value).map_err(|_| {
            error_to_js(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
                    .with_detail("bridge input does not match the typed workflow contract"),
            )
        })
    }

    fn error_to_js(error: DeviceSdkError) -> JsValue {
        to_js(&error).unwrap_or_else(|_| JsValue::from_str("internal_error"))
    }

    fn fixed_bytes<const N: usize>(bytes: &[u8], label: &str) -> Result<[u8; N], JsValue> {
        bytes.try_into().map_err(|_| {
            error_to_js(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
                    .with_detail(format!("{label} must contain exactly {N} bytes")),
            )
        })
    }

    fn uuid_bytes(value: &str) -> Result<[u8; 16], JsValue> {
        value
            .parse::<RecordingUuid>()
            .map(|uuid| *uuid.as_bytes())
            .map_err(error_to_js)
    }
}
