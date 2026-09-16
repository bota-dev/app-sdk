use bota_device_sdk_core::{
    engine::{
        CancellationId, Capability, CapabilitySet, Command, EffectRequest, Event, HostEvent,
        WorkflowEngine, WorkflowStatus,
    },
    error::DeviceSdkError,
    model::{DeviceCandidate, DeviceSerialNumber, DeviceStatus},
    protocol::{
        EncryptedUploadV2Capabilities, decode_encrypted_upload_v2_capabilities, parse_device_status,
    },
};

#[derive(Default)]
pub struct BridgeCore {
    engine: WorkflowEngine,
}

impl BridgeCore {
    pub fn start_exact_connection(
        &mut self,
        expected_serial: &str,
        peripheral_id: &str,
        name: Option<&str>,
        cancellation_id: [u8; 16],
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let command = Command::Connect {
            device: DeviceSerialNumber::new(expected_serial)?,
            candidate: DeviceCandidate {
                peripheral_id: peripheral_id.to_owned(),
                name: name.map(str::to_owned),
                advertised_address: None,
                rssi: 0,
            },
        };
        self.engine.start(
            command,
            &CapabilitySet::from([Capability::Ble, Capability::Timer, Capability::Persistence]),
            CancellationId::from_bytes(cancellation_id),
        )
    }

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
    use bota_device_sdk_core::{engine::HostEvent, error::DeviceSdkError};
    use serde::{Serialize, de::DeserializeOwned};
    use wasm_bindgen::prelude::*;

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
        serde_wasm_bindgen::from_value(value).map_err(|_| JsValue::from_str("invalid_input"))
    }

    fn error_to_js(error: DeviceSdkError) -> JsValue {
        to_js(&error).unwrap_or_else(|_| JsValue::from_str("internal_error"))
    }
}
