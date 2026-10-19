//! Boundary DTOs and codec calls. Protocol decisions remain in device-sdk-core.

use crate::{MAX_MESSAGE_BYTES, dto, engine::invalid, json};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    model::{DeviceState, DeviceStatus},
    protocol::*,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json as object};
use std::collections::BTreeMap;

const MAX_DECODERS: usize = 16;
const MAX_LOG_PENDING_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub(crate) struct CodecState {
    logs: BTreeMap<String, LogState>,
    diagnostics: BTreeMap<String, DeviceDiagnosticsDecoder>,
    hashers: BTreeMap<String, dto::WebIntegrityHasher>,
    catalogs: BTreeMap<String, EncryptedUploadV2CatalogDecoder>,
    receivers: BTreeMap<u32, EncryptedUploadV2Receiver>,
    next_receiver_id: u32,
}

#[derive(Default)]
struct LogState {
    decoder: DeviceLogDecoder,
    pending_bytes: usize,
}

#[inline(never)]
pub(crate) fn input<T: DeserializeOwned>(value: Value) -> Result<T, DeviceSdkError> {
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid("invalid codec input"))?;
    json::decode(&bytes).map_err(|_| invalid("codec input does not match its typed contract"))
}
#[inline(never)]
pub(crate) fn output<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, DeviceSdkError> {
    json::encode_bounded(value, MAX_MESSAGE_BYTES)
        .map_err(|_| invalid("codec output exceeds the message bound"))
}
#[inline(never)]
pub(crate) fn public_output(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    // Native public DTO numbers are range checked or derived from u8/u16/u32 fields.
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid("invalid public DTO"))?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("codec output exceeds the message bound"));
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bytes {
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecodeText {
    bytes: Vec<u8>,
    #[serde(default)]
    required: bool,
}
#[derive(Deserialize)]
struct DecodeHex {
    bytes: Vec<u8>,
    length: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    settings: dto::WebConnectionSettings,
    model: String,
    serial_number: Option<String>,
    bound_model: Option<BoundDeviceModel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundDeviceModel {
    serial_number: String,
    model: String,
    binding_generation: u64,
}

fn settings_model(model: &str) -> Option<&'static str> {
    match model {
        "pin" | "bota_pin" | "Bota Pin" => Some("pin"),
        "pin_4g" | "bota_pin_4g" | "Bota Pin 4G" => Some("pin_4g"),
        "note" | "bota_note" | "Bota Note" => Some("note"),
        _ => None,
    }
}

fn connection_settings_model(request: &Settings) -> Result<&'static str, DeviceSdkError> {
    let observed = settings_model(&request.model);
    let Some(hint) = &request.bound_model else {
        return observed.ok_or_else(|| invalid("unsupported device model"));
    };
    let serial = request.serial_number.as_deref().unwrap_or("");
    if serial != hint.serial_number
        || bota_device_sdk_core::model::DeviceSerialNumber::new(serial).is_err()
        || hint.binding_generation == 0
        || hint.binding_generation > 9_007_199_254_740_991
    {
        return Err(invalid("bound device model identity is invalid"));
    }
    let bound =
        settings_model(&hint.model).ok_or_else(|| invalid("unsupported bound device model"))?;
    match observed {
        Some(known) if known == bound => Ok(known),
        Some(_) => Err(invalid("bound device model conflicts with device identity")),
        None if request.model == "BOTA_DEV" => Ok(bound),
        None => Err(invalid("unsupported device model")),
    }
}
#[derive(Deserialize)]
struct Action {
    action: String,
}
#[derive(Deserialize)]
struct RecordingNotification {
    bytes: Vec<u8>,
    action: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextGrant {
    grant_blob: String,
    capacity: u32,
}
#[derive(Deserialize)]
struct WifiGrant {
    grant: String,
    capacity: u32,
}
#[derive(Deserialize)]
struct Credentials {
    ssid: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Certificate {
    certificate_pem: String,
    private_key_pem: String,
    mtu: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicKey {
    public_key_hex: String,
}
#[derive(Deserialize)]
struct Environment {
    environment: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeSync {
    epoch_milliseconds: u64,
    timezone_offset_minutes: i16,
}
#[derive(Deserialize)]
struct Enabled {
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decoder {
    decoder_id: String,
    #[serde(default)]
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Uuid {
    recording_uuid: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    attempt_id: u32,
}
#[derive(Deserialize)]
struct Document {
    kind: u8,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
struct FirmwareData {
    sequence: u16,
    payload: Vec<u8>,
}
#[derive(Deserialize)]
struct FirmwareSize {
    size: u32,
}
#[derive(Deserialize)]
struct FirmwareCrc {
    crc32: u32,
}
#[derive(Deserialize)]
struct Sequence {
    sequence: u16,
}
#[derive(Deserialize)]
struct Ack {
    ack_type: String,
    sequence: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogInput {
    decoder_id: String,
    transport_session_id: u64,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogError {
    transport_session_id: u64,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
struct ReceiverConfig {
    config: EncryptedUploadV2ReceiverConfig,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverId {
    receiver_id: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverPacket {
    receiver_id: u32,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverEvent {
    receiver_id: u32,
    event: EncryptedUploadV2ReceiverEvent,
}

impl CodecState {
    #[inline(never)]
    pub(crate) fn execute(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        if crate::find_device::supports(name) {
            return crate::find_device::call(name, value);
        }
        if crate::host_policy::supports(name) {
            return crate::host_policy::call(name, value);
        }
        if crate::recording_upload::supports(name) {
            return crate::recording_upload::call(name, value);
        }
        if crate::byo::supports(name) {
            return crate::byo::execute(name, value);
        }
        if crate::planners::supports(name) {
            return crate::planners::execute(name, value);
        }
        if crate::native_v2::supports(name) {
            return crate::native_v2::execute(name, value);
        }
        match name {
            "protocolMetadata" | "decodeText" | "decodeHex" | "decodeProvisioningState" => {
                self.execute_basic(name, value)
            }
            "decodeDeviceStatus"
            | "decodeConnectionSettings"
            | "decodeConnectionSettingsRaw"
            | "encodeConnectionSettings"
            | "encodeRecordingControlCommand"
            | "decodeRecordingControlResult"
            | "decodeRecordingControlNotification"
            | "decodeRecordingState"
            | "encodeWiFiGrant"
            | "encodeWiFiCredentials"
            | "encodeWiFiScanCommand"
            | "decodeWiFiConfigResult"
            | "decodeWiFiStatus"
            | "decodeWiFiScanUpdate"
            | "encodeTimeSync" => self.execute_control(name, value),
            "encodeApiEndpoint"
            | "encodeCertificateChunks"
            | "encodeBackendPublicKey"
            | "encodeGrant"
            | "encodeDeprovisionCommand"
            | "decodeDeprovisionResult"
            | "decodeFactoryResetResult" => self.execute_provision(name, value),
            "encodeDeviceLogControl"
            | "resetDeviceLogs"
            | "decodeDeviceLogs"
            | "decodeDiagnostics"
            | "resetDiagnostics"
            | "encodeDiagnosticsList"
            | "encodeDiagnosticsAcknowledge" => self.execute_diagnostic(name, value),
            "decodeRecordingList"
            | "decodeRecordingListWebDto"
            | "encodeRecordingListCommand"
            | "encodeRecordingConfirm"
            | "decodeTransferPacket"
            | "decodeTriggerUploadResponse"
            | "decodeOtaStatus"
            | "encodeOtaStatus"
            | "encodeFirmwareUploadStart"
            | "encodeFirmwareData"
            | "encodeFirmwareWindowAck"
            | "encodeFirmwareVerify"
            | "encodeAck"
            | "decodeAck" => self.execute_transfer(name, value),
            "decodeEncryptedUploadV2Capabilities"
            | "normalizeEncryptedUploadV2Checkpoint"
            | "createEncryptedUploadV2Receiver"
            | "startEncryptedUploadV2Receiver"
            | "receiveEncryptedUploadV2Receiver"
            | "applyEncryptedUploadV2Receiver"
            | "checkpointEncryptedUploadV2Receiver"
            | "cancelEncryptedUploadV2Receiver"
            | "freeEncryptedUploadV2Receiver"
            | "validateEncryptedUploadV2HostIdentity"
            | "decodeEncryptedUploadV2Catalog"
            | "resetEncryptedUploadV2Catalog"
            | "decodeEncryptedUploadV2CatalogError"
            | "decodeEncryptedUploadV2Transfer"
            | "encodeEncryptedUploadV2Transfer"
            | "decodeEncryptedUploadV2Status"
            | "encodeEncryptedUploadV2SignedBlob"
            | "decodeEncryptedUploadV2SignedBlobResult"
            | "encodeUploadContextBegin"
            | "decodeUploadContextSnapshot"
            | "validateUploadContextDocument"
            | "decodeUploadAuthorizationIdentity"
            | "decodeRecordingMarker" => self.execute_v2(name, value),
            "hasherNew" | "hasherUpdate" | "hasherSnapshot" | "hasherFree" => {
                self.execute_hash(name, value)
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_basic(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "protocolMetadata" => public_output(metadata()),
            "decodeText" => {
                let request: DecodeText = input(value)?;
                let text = std::str::from_utf8(&request.bytes)
                    .map_err(|_| invalid("device text is not UTF-8"))?
                    .trim_end_matches('\0')
                    .trim();
                if text.contains('\0') || (request.required && text.is_empty()) {
                    return Err(invalid("device text is empty or contains an embedded NUL"));
                }
                if text.is_empty() {
                    output(&Option::<String>::None)
                } else {
                    output(text)
                }
            }
            "decodeHex" => {
                let request: DecodeHex = input(value)?;
                output(&if request.bytes.len() == request.length as usize {
                    Some(hex(&request.bytes))
                } else {
                    None
                })
            }
            "decodeProvisioningState" => {
                let request: Bytes = input(value)?;
                output(&(request.bytes.first() == Some(&wire::PAIRING_STATE_PAIRED)))
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_control(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "decodeDeviceStatus" => {
                let request: Bytes = input(value)?;
                public_output(native_status(parse_device_status(&request.bytes)?))
            }
            "decodeConnectionSettings" => output(
                &dto::decode_connection_settings_dto(&input::<Bytes>(value)?.bytes)?.settings,
            ),
            "decodeConnectionSettingsRaw" => {
                output(&parse_connection_settings(&input::<Bytes>(value)?.bytes)?)
            }
            "encodeConnectionSettings" => {
                let request: Settings = input(value)?;
                let model = connection_settings_model(&request)?;
                output(&dto::encode_connection_settings_dto(
                    request.settings,
                    model,
                )?)
            }
            "encodeRecordingControlCommand" => output(&dto::encode_recording_control_command_dto(
                &input::<Action>(value)?.action,
            )?),
            "decodeRecordingControlResult" => output(&dto::decode_recording_control_result_dto(
                &input::<Bytes>(value)?.bytes,
            )?),
            "decodeRecordingControlNotification" => {
                let request: RecordingNotification = input(value)?;
                if !matches!(request.action.as_str(), "start" | "stop") {
                    return Err(invalid("invalid recording control action"));
                }
                if request.bytes.len() == 18 {
                    let state = parse_recording_state(&request.bytes)?;
                    if request.bytes[0] <= 1 && state.active != (request.action == "start") {
                        return output(&Option::<dto::WebResult>::None);
                    }
                }
                output(&dto::decode_recording_control_result_dto(&request.bytes)?)
            }
            "decodeRecordingState" => {
                let state = parse_recording_state(&input::<Bytes>(value)?.bytes)?;
                let mut result = object!({"active":state.active,"initiatedBy":if state.initiated_remotely {"remote"} else {"local"}});
                if let Some(uuid) = state.recording_uuid {
                    result["recordingId"] = Value::String(uuid.to_string());
                }
                public_output(result)
            }
            "encodeWiFiGrant" => {
                let request: WifiGrant = input(value)?;
                output(&encode_wifi_grant(
                    &request.grant,
                    request.capacity as usize,
                )?)
            }
            "encodeWiFiCredentials" => {
                let request: Credentials = input(value)?;
                output(&encode_wifi_credentials(&request.ssid, &request.password)?)
            }
            "encodeWiFiScanCommand" => output(&encode_wifi_scan_command()?),
            "decodeWiFiConfigResult" => output(&dto::decode_wifi_config_result_dto(
                &input::<Bytes>(value)?.bytes,
            )?),
            "decodeWiFiStatus" => {
                output(&dto::decode_wifi_status_dto(&input::<Bytes>(value)?.bytes)?)
            }
            "decodeWiFiScanUpdate" => {
                match dto::decode_wifi_scan_update_dto(&input::<Bytes>(value)?.bytes)? {
                    dto::WebWiFiScanUpdate::Pending { .. } => {
                        public_output(object!({"kind":"pending"}))
                    }
                    dto::WebWiFiScanUpdate::Done {
                        networks,
                        current_ssid,
                    } => {
                        #[derive(Serialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Result {
                            networks: Vec<dto::WebWiFiScanNetwork>,
                            #[serde(skip_serializing_if = "Option::is_none")]
                            current_ssid: Option<String>,
                        }
                        #[derive(Serialize)]
                        struct Done {
                            kind: &'static str,
                            result: Result,
                        }
                        output(&Done {
                            kind: "done",
                            result: Result {
                                networks,
                                current_ssid,
                            },
                        })
                    }
                }
            }
            "encodeTimeSync" => {
                let request: TimeSync = input(value)?;
                output(&encode_time_sync(
                    request.epoch_milliseconds,
                    request.timezone_offset_minutes,
                )?)
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_provision(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "encodeApiEndpoint" => {
                let request: Environment = input(value)?;
                let code: u8 = match request.environment.as_str() {
                    "development" | "dev" => 0,
                    "production" | "prod" => 1,
                    "gamma" => 2,
                    _ => return Err(invalid("unknown API environment")),
                };
                output(&vec![code])
            }
            "encodeCertificateChunks" => {
                let request: Certificate = input(value)?;
                let payload = format!(
                    "{}\n{}\n",
                    request.certificate_pem.trim(),
                    request.private_key_pem.trim()
                )
                .into_bytes();
                output(&encode_provisioning_chunks(&payload, request.mtu as usize)?)
            }
            "encodeBackendPublicKey" => {
                let request: PublicKey = input(value)?;
                let bytes = unhex(&request.public_key_hex)?;
                if bytes.len() != 32 {
                    return Err(invalid("backend public key must contain 32 bytes"));
                }
                output(&bytes)
            }
            "encodeGrant" => {
                let request: TextGrant = input(value)?;
                let bytes = STANDARD
                    .decode(&request.grant_blob)
                    .map_err(|_| invalid("grant blob is not canonical base64"))?;
                if bytes.is_empty() {
                    return Err(invalid("grant blob is empty"));
                }
                output(&encode_bounded_payload(&bytes, request.capacity as usize)?)
            }
            "encodeDeprovisionCommand" => output(&dto::encode_deprovision_command()?),
            "decodeDeprovisionResult" => output(&dto::deprovision_to_web(
                dto::decode_deprovision_result_dto(&input::<Bytes>(value)?.bytes)?,
            )),
            "decodeFactoryResetResult" => {
                output(&parse_factory_reset_result(&input::<Bytes>(value)?.bytes)?)
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_diagnostic(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "encodeDeviceLogControl" => output(&vec![if input::<Enabled>(value)?.enabled {
                wire::DEVICE_LOG_CMD_START
            } else {
                wire::DEVICE_LOG_CMD_STOP
            }]),
            "resetDeviceLogs" => {
                self.logs
                    .remove(&decoder_id(input::<Decoder>(value)?.decoder_id)?);
                output(&())
            }
            "decodeDeviceLogs" => {
                let request: Decoder = input(value)?;
                let id = decoder_id(request.decoder_id)?;
                if !self.logs.contains_key(&id) && self.logs.len() >= MAX_DECODERS {
                    return Err(invalid("too many log decoders"));
                }
                let state = self.logs.entry(id).or_default();
                if request.bytes.len() >= wire::DEVICE_LOG_PACKET_MINIMUM_LENGTH {
                    let payload = &request.bytes[wire::DEVICE_LOG_PACKET_MINIMUM_LENGTH..];
                    state.pending_bytes =
                        if let Some(last) = payload.iter().rposition(|byte| *byte == b'\n') {
                            payload.len() - last - 1
                        } else {
                            state.pending_bytes.saturating_add(payload.len())
                        };
                    if state.pending_bytes > MAX_LOG_PENDING_BYTES {
                        state.decoder.reset();
                        state.pending_bytes = 0;
                        return Err(invalid("device log line exceeds the pending byte bound"));
                    }
                }
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Line {
                    message: String,
                    is_backlog: bool,
                }
                output(
                    &state
                        .decoder
                        .push(&request.bytes)
                        .into_iter()
                        .map(|line| Line {
                            message: line.message,
                            is_backlog: line.is_backlog,
                        })
                        .collect::<Vec<_>>(),
                )
            }
            "decodeDiagnostics" => {
                let request: Decoder = input(value)?;
                let id = decoder_id(request.decoder_id)?;
                if !self.diagnostics.contains_key(&id) && self.diagnostics.len() >= MAX_DECODERS {
                    return Err(invalid("too many diagnostics decoders"));
                }
                output(
                    &self
                        .diagnostics
                        .entry(id)
                        .or_default()
                        .push(&request.bytes)?,
                )
            }
            "resetDiagnostics" => {
                self.diagnostics
                    .remove(&decoder_id(input::<Decoder>(value)?.decoder_id)?);
                output(&())
            }
            "encodeDiagnosticsList" => output(&encode_diagnostic_command(DiagnosticCommand::List)?),
            "encodeDiagnosticsAcknowledge" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Id {
                    event_id: String,
                }
                output(&encode_diagnostic_command(DiagnosticCommand::Acknowledge(
                    &input::<Id>(value)?.event_id,
                ))?)
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_transfer(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "decodeRecordingList" => native_recordings(&input::<Bytes>(value)?.bytes),
            "decodeRecordingListWebDto" => output(&dto::decode_recording_list_dto(
                &input::<Bytes>(value)?.bytes,
            )?),
            "encodeRecordingListCommand" => output(&dto::encode_recording_list_command()?),
            "encodeRecordingConfirm" => output(&dto::encode_recording_confirm(
                &input::<Uuid>(value)?.recording_uuid,
            )?),
            "decodeTransferPacket" => {
                output(&parse_transfer_packet(&input::<Bytes>(value)?.bytes)?)
            }
            "decodeTriggerUploadResponse" => output(&parse_trigger_upload_response(
                &input::<Bytes>(value)?.bytes,
            )?),
            "decodeOtaStatus" => output(&parse_ota_status(&input::<Bytes>(value)?.bytes)?),
            "encodeOtaStatus" => output(&encode_ota_status(input(value)?)?),
            "encodeFirmwareUploadStart" => output(&encode_firmware_upload_start(
                input::<FirmwareSize>(value)?.size,
            )?),
            "encodeFirmwareData" => {
                let request: FirmwareData = input(value)?;
                output(&encode_firmware_data(request.sequence, &request.payload)?)
            }
            "encodeFirmwareWindowAck" => output(&encode_firmware_window_ack(
                input::<Sequence>(value)?.sequence,
            )?),
            "encodeFirmwareVerify" => output(&encode_firmware_upload_verify(
                input::<FirmwareCrc>(value)?.crc32,
            )?),
            "encodeAck" => {
                let request: Ack = input(value)?;
                let kind = match request.ack_type.as_str() {
                    "ack" => AckType::Ack,
                    "nack" => AckType::Nack,
                    "abort" => AckType::Abort,
                    _ => return Err(invalid("invalid ACK kind")),
                };
                output(&encode_ack(kind, request.sequence)?)
            }
            "decodeAck" => {
                let (kind, sequence) = parse_ack(&input::<Bytes>(value)?.bytes)?;
                public_output(
                    object!({"kind":match kind {AckType::Ack=>"ack",AckType::Nack=>"nack",AckType::Abort=>"abort"},"sequence":sequence}),
                )
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_v2(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "decodeEncryptedUploadV2Capabilities" => output(
                &decode_encrypted_upload_v2_capabilities(&input::<Bytes>(value)?.bytes)?,
            ),
            "normalizeEncryptedUploadV2Checkpoint" => {
                output(&crate::v2::normalize_checkpoint(input(value)?)?)
            }
            "createEncryptedUploadV2Receiver" => {
                if self.receivers.len() >= MAX_DECODERS {
                    return Err(invalid("too many v2 receivers"));
                }
                let id = self
                    .next_receiver_id
                    .checked_add(1)
                    .ok_or_else(|| invalid("v2 receiver IDs exhausted"))?;
                let value = EncryptedUploadV2Receiver::new(input::<ReceiverConfig>(value)?.config)?;
                self.next_receiver_id = id;
                self.receivers.insert(id, value);
                public_output(object!({"receiverId":id}))
            }
            "startEncryptedUploadV2Receiver" => {
                let id = input::<ReceiverId>(value)?.receiver_id;
                output(&receiver(&mut self.receivers, id)?.start()?)
            }
            "receiveEncryptedUploadV2Receiver" => {
                let request: ReceiverPacket = input(value)?;
                output(
                    &receiver(&mut self.receivers, request.receiver_id)?.receive(&request.bytes)?,
                )
            }
            "applyEncryptedUploadV2Receiver" => {
                let request: ReceiverEvent = input(value)?;
                output(&receiver(&mut self.receivers, request.receiver_id)?.apply(request.event)?)
            }
            "checkpointEncryptedUploadV2Receiver" => {
                let id = input::<ReceiverId>(value)?.receiver_id;
                output(receiver(&mut self.receivers, id)?.checkpoint())
            }
            "cancelEncryptedUploadV2Receiver" => {
                let id = input::<ReceiverId>(value)?.receiver_id;
                receiver(&mut self.receivers, id)?.cancel();
                output(&())
            }
            "freeEncryptedUploadV2Receiver" => {
                let id = input::<ReceiverId>(value)?.receiver_id;
                let mut value = self
                    .receivers
                    .remove(&id)
                    .ok_or_else(|| invalid("unknown v2 receiver"))?;
                value.cancel();
                output(&())
            }
            "validateEncryptedUploadV2HostIdentity" => {
                crate::v2::validate_identity(input(value)?)?;
                output(&())
            }
            "decodeEncryptedUploadV2Catalog" => {
                let request: CatalogInput = input(value)?;
                let id = decoder_id(request.decoder_id)?;
                if !self.catalogs.contains_key(&id) && self.catalogs.len() >= MAX_DECODERS {
                    return Err(invalid("too many v2 catalog decoders"));
                }
                let catalog = self
                    .catalogs
                    .entry(id)
                    .or_default()
                    .push(request.transport_session_id, &request.bytes)?;
                match catalog {
                    None => output(&()),
                    Some(catalog) => {
                        let entries=catalog.entries.into_iter().map(|entry|object!({
                            "uuid":bota_device_sdk_core::model::RecordingUuid::from_bytes(entry.recording_uuid).to_string(),
                            "generation":entry.recording_generation,"ciphertextLength":entry.ciphertext_length.to_string(),
                            "ciphertextSha256":hex(&entry.ciphertext_sha256),"startedAtMs":entry.started_at.checked_mul(1000).map(|value|value.to_string()),
                            "durationMs":(u64::from(entry.duration_seconds)*1000).to_string(),"plaintextLength":entry.plaintext_length.to_string(),
                            "storageFormat":entry.storage_format,"markersRequired":entry.completion_state == 2,
                        })).collect::<Vec<_>>();
                        public_output(
                            object!({"entries":entries,"listRevision":catalog.list_revision}),
                        )
                    }
                }
            }
            "resetEncryptedUploadV2Catalog" => {
                self.catalogs
                    .remove(&decoder_id(input::<Decoder>(value)?.decoder_id)?);
                output(&())
            }
            "decodeEncryptedUploadV2CatalogError" => {
                let request: CatalogError = input(value)?;
                if request.transport_session_id == 0 {
                    return Err(invalid("catalog error session must be nonzero"));
                }
                match decode_encrypted_upload_v2_transfer(&request.bytes)? {
                    EncryptedUploadV2Transfer::Error {
                        common,
                        result,
                        failed_message_type,
                        ..
                    } if common.transport_session_id == request.transport_session_id
                        && failed_message_type == wire::ENCRYPTED_UPLOAD_V2_LIST =>
                    {
                        Err(DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::Decode,
                            false,
                        )
                        .with_protocol_status(result)
                        .with_detail("v2 catalog request rejected"))
                    }
                    _ => output(&()),
                }
            }
            "decodeEncryptedUploadV2Transfer" => output(
                &dto::decode_encrypted_upload_v2_transfer_dto(&input::<Bytes>(value)?.bytes)?,
            ),
            "encodeEncryptedUploadV2Transfer" => output(
                &dto::encode_encrypted_upload_v2_transfer_dto(frame_input(value)?)?,
            ),
            "decodeEncryptedUploadV2Status" => output(&dto::decode_encrypted_upload_v2_status_dto(
                &input::<Bytes>(value)?.bytes,
            )?),
            "encodeEncryptedUploadV2SignedBlob" => output(
                &dto::encode_encrypted_upload_v2_signed_blob_dto(input(value)?)?,
            ),
            "decodeEncryptedUploadV2SignedBlobResult" => {
                output(&dto::decode_encrypted_upload_v2_signed_blob_result_dto(
                    &input::<Bytes>(value)?.bytes,
                )?)
            }
            "encodeUploadContextBegin" => output(&encode_upload_context_begin(
                input::<Attempt>(value)?.attempt_id,
            )?),
            "decodeUploadContextSnapshot" => {
                let request: Bytes = input(value)?;
                let snapshot = decode_upload_context_snapshot(&request.bytes)?;
                public_output(
                    object!({"attemptId":snapshot.attempt_id,"state":snapshot.state,"result":snapshot.result,"payload":snapshot.payload}),
                )
            }
            "validateUploadContextDocument" => {
                let request: Document = input(value)?;
                decode_upload_context_document(request.kind, &request.bytes)?;
                output(&())
            }
            "decodeUploadAuthorizationIdentity" => {
                let request: Bytes = input(value)?;
                let identity = decode_encrypted_upload_v2_authorization_identity(&request.bytes)?;
                public_output(
                    object!({"profile":identity.profile,"storageFormat":identity.storage_format,"policy":identity.policy,"channels":identity.channels,"flags":identity.flags,"ownerRevision":identity.owner_revision,"recordingGeneration":identity.recording_generation,"minimumCiphertextLength":identity.minimum_ciphertext_length.to_string(),"maximumCiphertextLength":identity.maximum_ciphertext_length.to_string(),"uploadSessionUuid":identity.upload_session_uuid,"recordingUuid":identity.recording_uuid,"ciphertextSha256":identity.ciphertext_sha256}),
                )
            }
            "decodeRecordingMarker" => {
                let marker = decode_marker_body(&input::<Bytes>(value)?.bytes)?;
                public_output(
                    object!({"id":marker.id,"sequence":marker.sequence,"mediaOffsetMs":marker.media_offset_ms.to_string(),"segmentIndex":marker.segment_index,"segmentOffsetMs":marker.segment_offset_ms.to_string(),"createdAtUtcMs":marker.created_at_utc_ms.map(|value|value.to_string()),"digest":marker.digest}),
                )
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }

    #[inline(never)]
    fn execute_hash(&mut self, name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match name {
            "hasherNew" => {
                let id = decoder_id(input::<Decoder>(value)?.decoder_id)?;
                if self.hashers.contains_key(&id) {
                    return Err(invalid("hasher ID already exists"));
                }
                if self.hashers.len() >= MAX_DECODERS {
                    return Err(invalid("too many integrity hashers"));
                }
                self.hashers.insert(id, dto::WebIntegrityHasher::new());
                output(&())
            }
            "hasherUpdate" => {
                let request: Decoder = input(value)?;
                self.hashers
                    .get_mut(&request.decoder_id)
                    .ok_or_else(|| invalid("unknown integrity hasher"))?
                    .update(&request.bytes);
                output(&())
            }
            "hasherSnapshot" => {
                let request: Decoder = input(value)?;
                let hasher = self
                    .hashers
                    .get(&request.decoder_id)
                    .ok_or_else(|| invalid("unknown integrity hasher"))?;
                public_output(
                    object!({"length":hasher.length().to_string(),"crc32":hasher.crc32(),"sha256":hasher.sha256_snapshot()}),
                )
            }
            "hasherFree" => {
                let id = input::<Decoder>(value)?.decoder_id;
                if self.hashers.remove(&id).is_none() {
                    return Err(invalid("unknown integrity hasher"));
                }
                output(&())
            }
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, Operation::Decode, false)
                        .with_detail("unknown bridge codec"),
                )
            }
        }
    }
}

fn receiver(
    receivers: &mut BTreeMap<u32, EncryptedUploadV2Receiver>,
    id: u32,
) -> Result<&mut EncryptedUploadV2Receiver, DeviceSdkError> {
    receivers
        .get_mut(&id)
        .ok_or_else(|| invalid("unknown v2 receiver"))
}

fn native_recordings(bytes: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
    use bota_device_sdk_core::model::AudioCodec;
    let recordings=parse_recording_list(bytes)?.into_iter().map(|recording|{
        if recording.duration_ms>9_007_199_254_740_991||recording.file_size_bytes>9_007_199_254_740_991{return Err(invalid("recording public metadata exceeds the exact JS number range"));}
        let codec=match recording.codec{AudioCodec::Pcm16k=>"pcm_16k",AudioCodec::Pcm8k=>"pcm_8k",AudioCodec::Opus16k=>"opus_16k",AudioCodec::Opus8k=>"opus_8k",AudioCodec::Unknown(_)=>"unknown"};
        Ok(object!({"uuid":recording.uuid.to_string(),"startedAtMs":u64::from(recording.started_at_timestamp)*1000,"durationMs":recording.duration_ms,"fileSize":recording.file_size_bytes,"codec":codec,"isEncrypted":recording.encrypted}))
    }).collect::<Result<Vec<_>,DeviceSdkError>>()?;
    public_output(Value::Array(recordings))
}

// Internally tagged serde DTOs buffer their contents. Convert only their declared
// u64 fields inside Rust, before deserialization, never through a JS Number.
fn frame_input(mut value: Value) -> Result<dto::WebEncryptedUploadV2Transfer, DeviceSdkError> {
    let fields = [
        "transportSessionId",
        "startedAt",
        "plaintextLength",
        "ciphertextLength",
        "offset",
        "nextCiphertextOffset",
    ];
    if let Some(object) = value.as_object_mut() {
        for key in fields {
            if let Some(Value::String(text)) = object.get(key) {
                let parsed: u64 = text.parse().map_err(|_| invalid("invalid frame integer"))?;
                if parsed.to_string() != *text {
                    return Err(invalid("non-canonical frame integer"));
                }
                object.insert(key.into(), Value::Number(parsed.into()));
            } else if let Some(Value::Number(number)) = object.get(key)
                && number
                    .as_u64()
                    .is_none_or(|number| number > 9_007_199_254_740_991)
            {
                return Err(invalid("frame integer must be an exact decimal string"));
            }
        }
    }
    serde_json::from_value(value).map_err(|_| invalid("invalid encrypted transfer frame"))
}

fn decoder_id(id: String) -> Result<String, DeviceSdkError> {
    if id.is_empty() || id.len() > 512 {
        return Err(invalid("invalid decoder ID"));
    }
    Ok(id)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(value: &str) -> Result<Vec<u8>, DeviceSdkError> {
    if !value.is_ascii() || !value.len().is_multiple_of(2) {
        return Err(invalid("invalid hexadecimal value"));
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let text =
                std::str::from_utf8(pair).map_err(|_| invalid("invalid hexadecimal value"))?;
            u8::from_str_radix(text, 16).map_err(|_| invalid("invalid hexadecimal value"))
        })
        .collect()
}

fn native_status(status: DeviceStatus) -> Value {
    let state = match status.state {
        DeviceState::Idle => "idle",
        DeviceState::Recording => "recording",
        DeviceState::Syncing => "syncing",
        DeviceState::Uploading => "uploading",
        DeviceState::Charging => "charging",
        DeviceState::LowBattery => "lowBattery",
        DeviceState::StorageFull => "storageFull",
        DeviceState::Error => "error",
        DeviceState::Unknown(_) => "idle",
    };
    let lte = [
        "off",
        "searching",
        "registered",
        "connected",
        "denied",
        "noSim",
        "error",
        "lowVoltage",
        "disabled",
    ]
    .get(status.lte_status_raw as usize)
    .copied()
    .unwrap_or("off");
    let mut result = object!({"batteryLevel":status.battery_percent,"storageTotalMb":status.storage_total_mb,"storageUsedMb":status.storage_used_mb,"state":state,"pendingRecordings":status.pending_recordings,"signalStrength":0,"flags":{"charging":status.flags.charging,"lowBattery":status.flags.low_battery,"storageFull":status.flags.storage_full,"wifiConnected":status.flags.wifi_connected,"lteConnected":status.flags.lte_connected,"syncActive":status.flags.sync_active},"timestamp":status.last_time_sync_timestamp,"lteStatus":lte});
    if let Some(value) = status.battery_mv {
        result["batteryMv"] = object!(value);
    }
    if status.last_time_sync_timestamp != 0 {
        result["lastTimeSyncAtMs"] = object!(f64::from(status.last_time_sync_timestamp) * 1000.0);
    }
    if let Some(value) = status.lte_signal_quality {
        result["lteSignalQuality"] = object!(value);
    }
    if let Some(raw) = status.wifi_status_raw {
        result["wifiStatus"] = object!(
            [
                "off",
                "scanning",
                "connecting",
                "connected",
                "connectFailed",
                "noCredentials",
                "disabled",
                "error"
            ]
            .get(raw as usize)
            .copied()
            .unwrap_or("off")
        );
    }
    if let Some(modem) = status.modem_info {
        let mut value = object!({});
        for (key, text) in [
            ("imei", modem.imei),
            ("iccid", modem.iccid),
            ("operator", modem.operator),
            ("rat", modem.rat),
            ("band", modem.band),
            ("apn", modem.apn),
            ("simStatus", modem.sim_status),
            ("ipAddress", modem.ip_address),
            ("modemFirmware", modem.firmware),
        ] {
            if let Some(text) = text {
                value[key] = object!(text);
            }
        }
        if let Some(csq) = modem.csq {
            value["csq"] = object!(csq);
        }
        if let Some(voltage) = modem.voltage_mv {
            value["modemVoltage"] = object!(voltage);
        }
        if let Some(roaming) = modem.roaming {
            value["roaming"] = object!(roaming);
        }
        result["modemInfo"] = value;
    }
    result
}

fn metadata() -> Value {
    let mut result = object!({"recordingStopDelayMs":50,"findAckTimeoutMs": 3000,
        "operationTimeoutMs":30000,"contextTimeoutMs":30000,"contextPollIntervalMs":150,"protocolRevision":wire::PROTOCOL_REVISION,"firmwareRecoveryTimeoutMs":bota_device_sdk_core::workflow::RECONNECT_TIMEOUT_MS,"mtuObservationAttempts":crate::host_policy::BLE_MTU_OBSERVATION_ATTEMPTS,"mtuObservationDelayMs":crate::host_policy::BLE_MTU_OBSERVATION_DELAY_MS});
    macro_rules! constants { ($($name:ident),* $(,)?) => { $(result[stringify!($name)]=object!(wire::$name);)* }; }
    constants!(
        DEFAULT_MTU,
        MAX_MTU,
        SERVICE_DEVICE_INFO,
        CHAR_MANUFACTURER_NAME,
        CHAR_MODEL_NUMBER,
        CHAR_SERIAL_NUMBER,
        CHAR_HARDWARE_REVISION,
        CHAR_FIRMWARE_REVISION,
        SERVICE_BATTERY,
        CHAR_BATTERY_LEVEL,
        SERVICE_BOTA_AUDIO,
        CHAR_AUDIO_DATA,
        CHAR_AUDIO_CODEC,
        CHAR_AUDIO_CONTROL,
        SERVICE_BOTA_CONTROL,
        CHAR_DEVICE_STATUS,
        CHAR_RECORDING_CONTROL,
        CHAR_RECORDING_STATUS,
        CHAR_TIME_SYNC,
        CHAR_DEVICE_COMMAND,
        SERVICE_BOTA_FIND,
        CHAR_FIND_CAPABILITIES,
        CHAR_FIND_CONTROL,
        CHAR_FIND_STATUS,
        CHAR_FIND_GRANT,
        CHAR_FIND_CHALLENGE,
        CHAR_FIND_BINDING_CHALLENGE,
        CHAR_FIND_BINDING_CONFIRM,
        CHAR_FIND_BINDING_ACK,
        SERVICE_BOTA_PROVISIONING,
        CHAR_PAIRING_STATE,
        CHAR_DEVICE_TOKEN,
        CHAR_API_ENDPOINT,
        CHAR_WIFI_CONFIG,
        CHAR_PROVISIONING_RESULT,
        CHAR_DEVICE_SETTINGS,
        SERVICE_BOTA_STORAGE,
        CHAR_STORAGE_INFO,
        CHAR_RECORDING_LIST,
        CHAR_RECORDING_TRANSFER,
        CHAR_TRANSFER_CONTROL,
        CHAR_TRANSFER_STATUS,
        CHAR_STORAGE_TRANSFER_CAPABILITIES_V2,
        CHAR_TRANSFER_SIGNED_BLOB_V2,
        CHAR_TRANSFER_CONTROL_V2,
        CHAR_RECORDING_TRANSFER_V2,
        CHAR_TRANSFER_STATUS_V2,
        CHAR_RECORDING_LIST_V2,
        CHAR_UPLOAD_CONTEXT_V2,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_RECEIPT,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_CHALLENGE,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_RESULT,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_MARKED_AUTHORIZATION,
        ENCRYPTED_UPLOAD_V2_BLOB_KIND_MARKED_RECEIPT,
        SERVICE_BOTA_AUTH,
        CHAR_PK_D,
        CHAR_AUTH_NONCE,
        CHAR_BACKEND_PUBKEY,
        CHAR_DEVICE_CERT,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_GRANT,
        CHAR_WIFI_CREDENTIAL,
        CHAR_WIFI_STATUS,
        CHAR_WIFI_SCAN,
        SERVICE_BOTA_DIAGNOSTICS,
        CHAR_DEVICE_LOG_CONTROL,
        CHAR_DEVICE_LOG_DATA,
        SERVICE_BOTA_IDENTITY,
        CHAR_BOTA_SERIAL_NUMBER
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_request(model: &str, bound_model: Value) -> Value {
        let settings =
            dto::decode_connection_settings_dto(&[2, 3, 1, 2, 3, 18, 18, 0, 60, 0x83, 0, 0])
                .unwrap()
                .settings;
        object!({"settings":settings,"model":model,"serialNumber":"4KF6NOHWX0","boundModel":bound_model})
    }

    #[test]
    fn generic_model_uses_only_exact_bound_identity_and_shared_normalization() {
        let mut codecs = CodecState::default();
        for (model, canonical) in [("bota_pin", "pin"), ("bota_note", "note")] {
            let request = settings_request(
                "BOTA_DEV",
                object!({"serialNumber":"4KF6NOHWX0","model":model,"bindingGeneration":3}),
            );
            let actual = codecs.execute("encodeConnectionSettings", request).unwrap();
            let expected = codecs
                .execute(
                    "encodeConnectionSettings",
                    settings_request(canonical, Value::Null),
                )
                .unwrap();
            assert_eq!(actual, expected);
            if canonical == "note" {
                let bytes: Vec<u8> = serde_json::from_slice(&actual).unwrap();
                let decoded = parse_connection_settings(&bytes).unwrap().settings;
                assert!(!decoded.enabled.cellular && !decoded.heartbeat.cellular);
                assert!(
                    !decoded
                        .upload_priority
                        .contains(&bota_device_sdk_core::model::ConnectionType::Cellular)
                );
            }
        }
        for model in [
            "pin",
            "bota_pin",
            "Bota Pin",
            "note",
            "bota_note",
            "Bota Note",
            "pin_4g",
            "bota_pin_4g",
            "Bota Pin 4G",
        ] {
            assert!(
                codecs
                    .execute(
                        "encodeConnectionSettings",
                        settings_request(model, Value::Null)
                    )
                    .is_ok()
            );
        }
    }

    #[test]
    fn model_hint_cannot_override_known_or_arbitrary_unknown_identity() {
        let mut codecs = CodecState::default();
        let valid = object!({"serialNumber":"4KF6NOHWX0","model":"pin","bindingGeneration":3});
        for model in ["BOTA_DEV", "unknown", "", "Bota-Device"] {
            assert!(
                codecs
                    .execute(
                        "encodeConnectionSettings",
                        settings_request(model, Value::Null)
                    )
                    .is_err()
            );
        }
        for model in ["unknown", "", "Bota-Device", "bota_note"] {
            assert!(
                codecs
                    .execute(
                        "encodeConnectionSettings",
                        settings_request(model, valid.clone())
                    )
                    .is_err()
            );
        }
        for (field, value) in [
            ("serialNumber", object!("OTHERDEVICE")),
            ("model", object!("BOTA_DEV")),
            ("bindingGeneration", object!(0)),
            ("bindingGeneration", object!(-1)),
            ("bindingGeneration", object!(1.5)),
            ("bindingGeneration", object!(9_007_199_254_740_992_u64)),
        ] {
            let mut invalid_hint = valid.clone();
            invalid_hint[field] = value;
            assert!(
                codecs
                    .execute(
                        "encodeConnectionSettings",
                        settings_request("BOTA_DEV", invalid_hint)
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn canonical_time_wifi_and_ota_codecs_match_core_bytes() {
        let mut codecs = CodecState::default();
        let bytes = codecs
            .execute(
                "encodeTimeSync",
                object!({"epochMilliseconds":"1700000000123","timezoneOffsetMinutes":-480}),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<u8>>(&bytes).unwrap(),
            encode_time_sync(1_700_000_000_123, -480).unwrap()
        );
        let bytes = codecs
            .execute(
                "encodeWiFiCredentials",
                object!({"ssid":"fixture","password":"password"}),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<u8>>(&bytes).unwrap(),
            encode_wifi_credentials("fixture", "password").unwrap()
        );
        assert!(
            codecs
                .execute(
                    "encodeWiFiCredentials",
                    object!({"ssid":"a\u{0000}b","password":""})
                )
                .is_err()
        );
        let bytes = codecs
            .execute("encodeFirmwareVerify", object!({"crc32":305419896}))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<u8>>(&bytes).unwrap(),
            encode_firmware_upload_verify(0x12345678).unwrap()
        );
    }
    #[test]
    fn activity_snapshot_is_not_interpreted_as_a_six_byte_result() {
        let mut codecs = CodecState::default();
        let mut snapshot = vec![1, 0];
        snapshot.extend([0x55; 16]);
        snapshot[5] = wire::RECORDING_RESULT_INVALID_GRANT;
        let result = codecs
            .execute(
                "decodeRecordingControlNotification",
                object!({"bytes":snapshot,"action":"start"}),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&result).unwrap()["success"],
            true
        );
        let result = codecs
            .execute(
                "decodeRecordingControlNotification",
                object!({"bytes":snapshot,"action":"stop"}),
            )
            .unwrap();
        assert_eq!(result, b"null");
        assert!(
            codecs
                .execute(
                    "decodeRecordingControlNotification",
                    object!({"bytes":snapshot,"action":"invalid"})
                )
                .is_err()
        );
    }
    #[test]
    fn log_decoders_are_independent_and_bound_incomplete_lines() {
        let mut codecs = CodecState::default();
        assert_eq!(
            codecs
                .execute(
                    "decodeDeviceLogs",
                    object!({"decoderId":"a","bytes":[0,0,0,97]})
                )
                .unwrap(),
            b"[]"
        );
        assert_eq!(
            codecs
                .execute(
                    "decodeDeviceLogs",
                    object!({"decoderId":"b","bytes":[0,0,0,98,10]})
                )
                .unwrap(),
            b"[{\"message\":\"b\",\"isBacklog\":false}]"
        );
        assert_eq!(
            codecs
                .execute(
                    "decodeDeviceLogs",
                    object!({"decoderId":"a","bytes":[1,0,0,10]})
                )
                .unwrap(),
            b"[{\"message\":\"a\",\"isBacklog\":false}]"
        );
        let mut bytes = vec![2, 0, 0];
        bytes.extend(vec![b'x'; MAX_LOG_PENDING_BYTES + 1]);
        assert!(
            codecs
                .execute("decodeDeviceLogs", object!({"decoderId":"a","bytes":bytes}))
                .is_err()
        );
    }

    #[test]
    fn canonical_ota_golden_fixture_bytes_survive_the_json_boundary() {
        let suite: Value =
            serde_json::from_str(include_str!("../../../protocol/fixtures/ota.json")).unwrap();
        let mut codecs = CodecState::default();
        for case in suite["cases"].as_array().unwrap() {
            let value = &case["input"];
            let (codec, input) = match case["operation"].as_str().unwrap() {
                "firmwareUploadStart" => ("encodeFirmwareUploadStart", value.clone()),
                "firmwareDataPacket" => (
                    "encodeFirmwareData",
                    object!({"sequence":value["sequenceNumber"],"payload":unhex(value["payloadHex"].as_str().unwrap()).unwrap()}),
                ),
                "firmwareWindowAck" => (
                    "encodeFirmwareWindowAck",
                    object!({"sequence":value["sequenceNumber"]}),
                ),
                "firmwareUploadVerify" => ("encodeFirmwareVerify", value.clone()),
                "firmwareStatus" => (
                    "encodeOtaStatus",
                    object!({"command":value["command"],"result":value["result"],"sequence":null}),
                ),
                operation => panic!("uncovered OTA fixture {operation}"),
            };
            let result = codecs.execute(codec, input).unwrap();
            let bytes: Vec<u8> = serde_json::from_slice(&result).unwrap();
            assert_eq!(
                hex(&bytes),
                case["expectedHex"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn native_status_preserves_golden_wire_timestamp_and_public_fields() {
        let suite: Value = serde_json::from_str(include_str!(
            "../../../protocol/fixtures/device-status.json"
        ))
        .unwrap();
        let mut codecs = CodecState::default();
        for case in suite["cases"].as_array().unwrap() {
            let result=codecs.execute("decodeDeviceStatus",object!({"bytes":unhex(case["inputHex"].as_str().unwrap()).unwrap(),"timestampMs":987654321}));
            if case.get("expectedError").is_some() {
                assert!(result.is_err());
                continue;
            }
            let result: Value = serde_json::from_slice(&result.unwrap()).unwrap();
            for (key, value) in case["expected"].as_object().unwrap() {
                if key == "lastTimeSyncAt" {
                    continue;
                }
                assert_eq!(&result[key], value, "{} field {key}", case["name"]);
            }
        }
    }

    #[test]
    fn native_recording_list_matches_frozen_recording_metadata() {
        let suite: Value = serde_json::from_str(include_str!(
            "../../../protocol/fixtures/recording-list.json"
        ))
        .unwrap();
        let mut codecs = CodecState::default();
        for case in suite["cases"].as_array().unwrap() {
            let result: Value = serde_json::from_slice(
                &codecs
                    .execute(
                        "decodeRecordingList",
                        object!({"bytes":unhex(case["inputHex"].as_str().unwrap()).unwrap()}),
                    )
                    .unwrap(),
            )
            .unwrap();
            let entries = result.as_array().unwrap();
            let expected = case["expected"].as_array().unwrap();
            assert_eq!(entries.len(), expected.len());
            for (entry, expected) in entries.iter().zip(expected) {
                for key in ["uuid", "durationMs", "codec", "isEncrypted"] {
                    assert_eq!(entry[key], expected[key]);
                }
                assert_eq!(entry["fileSize"], expected["fileSizeBytes"]);
                assert_eq!(entry["startedAtMs"], 1_700_000_000_000_u64);
                assert!(entry["fileSize"].is_number());
            }
        }
    }

    #[test]
    fn encrypted_catalog_opens_and_consumes_an_exact_session() {
        use sha2::{Digest, Sha256};
        let session = 9_007_199_254_740_993_u64;
        let entry = encode_encrypted_upload_v2_transfer(
            &EncryptedUploadV2Transfer::RecordingEntry(RecordingEntryV2 {
                common: CommonHeaderV2 {
                    message_type: wire::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY,
                    flags: 0,
                    transport_session_id: session,
                },
                recording_uuid: [0x22; 16],
                recording_generation: 7,
                storage_format: wire::STORAGE_FORMAT_BOTA_ENC_V2,
                completion_state: 2,
                started_at: 99,
                duration_seconds: 5,
                plaintext_length: 100,
                ciphertext_length: 600,
                ciphertext_sha256: [2; 32],
            }),
        )
        .unwrap();
        let end =
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::RecordingListEnd {
                common: CommonHeaderV2 {
                    message_type: wire::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END,
                    flags: 0,
                    transport_session_id: session,
                },
                count: 1,
                list_revision: 9,
                list_sha256: Sha256::digest(
                    &entry[wire::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FIXED_LENGTH..],
                )
                .into(),
            })
            .unwrap();
        let mut codecs = CodecState::default();
        let call = |bytes: &[u8]| object!({"decoderId":"catalog","transportSessionId":session.to_string(),"bytes":bytes});
        assert_eq!(
            codecs
                .execute("decodeEncryptedUploadV2Catalog", call(&[]))
                .unwrap(),
            b"null"
        );
        assert_eq!(
            codecs
                .execute("decodeEncryptedUploadV2Catalog", call(&entry))
                .unwrap(),
            b"null"
        );
        let result: Value = serde_json::from_slice(
            &codecs
                .execute("decodeEncryptedUploadV2Catalog", call(&end))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["entries"][0]["generation"], 7);
        assert_eq!(result["entries"][0]["ciphertextLength"], "600");
        assert_eq!(result["entries"][0]["startedAtMs"], "99000");
        assert_eq!(result["entries"][0]["markersRequired"], true);
        assert_eq!(result["listRevision"], 9);
        assert!(
            codecs
                .execute("decodeEncryptedUploadV2Catalog", call(&end))
                .is_err()
        );
        codecs
            .execute("decodeEncryptedUploadV2Catalog", call(&[]))
            .unwrap();
        assert!(
            codecs
                .execute(
                    "decodeEncryptedUploadV2Catalog",
                    object!({"decoderId":"catalog","transportSessionId":"7","bytes":entry})
                )
                .is_err()
        );
    }

    #[test]
    fn receiver_codec_uses_shared_policy_and_retires_exact_io_owners() {
        use sha2::{Digest, Sha256};
        let prefix: [u8; 32] = Sha256::digest([]).into();
        let config = EncryptedUploadV2ReceiverConfig {
            transport_session_id: 9_007_199_254_740_993,
            expected_ciphertext_length: 600,
            expected_ciphertext_sha256: [2; 32],
            maximum_data_payload_bytes: 244,
            maximum_window_packets: 16,
            maximum_missing_sequences: 16,
            checkpoint: EncryptedUploadV2ReceiverCheckpoint::initial(),
            markers_required: false,
        };
        let config: Value = serde_json::from_slice(&output(&config).unwrap()).unwrap();
        let mut codecs = CodecState::default();
        let created: Value = serde_json::from_slice(
            &codecs
                .execute(
                    "createEncryptedUploadV2Receiver",
                    object!({"config":config}),
                )
                .unwrap(),
        )
        .unwrap();
        let id = created["receiverId"].as_u64().unwrap() as u32;
        let action: Value = serde_json::from_slice(
            &codecs
                .execute("startEncryptedUploadV2Receiver", object!({"receiverId":id}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(action["InspectSink"]["request_id"], "1");
        assert_eq!(action["InspectSink"]["prefix_length"], "0");
        let event = |request_id: &str| object!({"receiverId":id,"event":{"SinkProof":{"request_id":request_id,"byte_length":"1","prefix_sha256":prefix}}});
        assert!(
            codecs
                .execute("applyEncryptedUploadV2Receiver", event("2"))
                .is_err()
        );
        let applied: Value = serde_json::from_slice(
            &codecs
                .execute("applyEncryptedUploadV2Receiver", event("1"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(applied["TruncateSink"]["request_id"], "2");
        codecs
            .execute(
                "cancelEncryptedUploadV2Receiver",
                object!({"receiverId":id}),
            )
            .unwrap();
        assert!(
            codecs
                .execute(
                    "applyEncryptedUploadV2Receiver",
                    object!({"receiverId":id,"event":{"Applied":{"request_id":"2"}}})
                )
                .is_err()
        );
        codecs
            .execute("freeEncryptedUploadV2Receiver", object!({"receiverId":id}))
            .unwrap();
        assert!(
            codecs
                .execute(
                    "checkpointEncryptedUploadV2Receiver",
                    object!({"receiverId":id})
                )
                .is_err()
        );
        let next: Value = serde_json::from_slice(
            &codecs
                .execute(
                    "createEncryptedUploadV2Receiver",
                    object!({"config":config}),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(next["receiverId"].as_u64().unwrap() > u64::from(id));
    }
}
