use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    model::{
        AudioCodec, ConnectionType, DeviceConnectionSettings, DeviceModel, EnabledConnections,
        HeartbeatConnections, IdleTimeout, PowerManagement, RecordingUuid,
    },
    protocol::{
        CommonHeaderV2, ConfirmV2, DeprovisionResult, EncryptedUploadV2SignedBlob,
        EncryptedUploadV2Transfer, RecordingControlCommand, RecordingControlError, ResumeV2,
        StartV2, TransferCommand, WiFiConfigResult, WiFiScanUpdate, WiFiStatus, WindowAckV2,
        decode_encrypted_upload_v2_signed_blob, decode_encrypted_upload_v2_status,
        decode_encrypted_upload_v2_transfer, encode_connection_settings, encode_device_command,
        encode_encrypted_upload_v2_signed_blob, encode_encrypted_upload_v2_transfer,
        encode_recording_control_command, encode_transfer_command, parse_connection_settings,
        parse_deprovision_result, parse_recording_control_result, parse_recording_list,
        parse_wifi_config_result, parse_wifi_scan_result, parse_wifi_status_info,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use bota_device_sdk_core::protocol::{
    DeprovisionFailure, encode_wifi_credentials, encode_wifi_grant, encode_wifi_scan_command,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDeviceRecording {
    pub uuid: String,
    pub started_at_timestamp_seconds: u32,
    pub duration_milliseconds: u64,
    pub file_size_bytes: u64,
    pub codec: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_raw: Option<u8>,
    pub encrypted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebConnectionType {
    Wifi,
    Ble,
    Cellular,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebConnectionFlags {
    pub wifi: bool,
    pub cellular: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPowerManagement {
    pub cellular_idle_timeout_seconds: i32,
    pub wifi_idle_timeout_seconds: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebConnectionSettings {
    pub enabled_connections: WebConnectionFlags,
    pub heartbeat_enabled_connections: WebConnectionFlags,
    pub upload_network_preference: Vec<WebConnectionType>,
    pub power_management: WebPowerManagement,
    pub streaming_enabled: bool,
    pub streaming_flush_interval_seconds: u8,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDecodedConnectionSettings {
    #[serde(flatten)]
    pub settings: WebConnectionSettings,
    pub supported_version: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_raw: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebWiFiStatusInfo {
    pub status: &'static str,
    pub status_raw: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_strength: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebWiFiScanNetwork {
    pub ssid: String,
    pub quality: u8,
    pub is_current: bool,
    pub is_open: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WebWiFiScanUpdate {
    Pending {
        status_raw: u8,
    },
    Done {
        networks: Vec<WebWiFiScanNetwork>,
        current_ssid: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WebEncryptedUploadV2Transfer {
    List {
        flags: u16,
        transport_session_id: u64,
    },
    RecordingEntry {
        flags: u16,
        transport_session_id: u64,
        recording_uuid: String,
        recording_generation: u32,
        storage_format: u8,
        completion_state: u8,
        started_at: u64,
        duration_seconds: u32,
        plaintext_length: u64,
        ciphertext_length: u64,
        ciphertext_sha256: Vec<u8>,
    },
    RecordingListEnd {
        flags: u16,
        transport_session_id: u64,
        count: u32,
        list_revision: u32,
        list_sha256: Vec<u8>,
    },
    Start {
        flags: u16,
        transport_session_id: u64,
        upload_session_uuid: String,
        recording_uuid: String,
        recording_generation: u32,
        authorization_sha256: Vec<u8>,
        checkpoint_revision: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
        window_packets: u16,
        data_payload_bytes: u16,
    },
    StartAck {
        flags: u16,
        transport_session_id: u64,
        upload_session_uuid: String,
        recording_uuid: String,
        recording_generation: u32,
        ciphertext_length: u64,
        ciphertext_sha256: Vec<u8>,
        window_packets: u16,
        data_payload_bytes: u16,
        checkpoint_interval_blocks: u32,
        checkpoint_revision: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
    },
    Data {
        flags: u16,
        transport_session_id: u64,
        sequence: u32,
        offset: u64,
        data: Vec<u8>,
    },
    WindowEnd {
        flags: u16,
        transport_session_id: u64,
        window_index: u32,
        first_sequence: u32,
        last_sequence: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
        checkpoint_revision: u32,
    },
    WindowAck {
        flags: u16,
        transport_session_id: u64,
        window_index: u32,
        highest_contiguous_sequence: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
        checkpoint_revision: u32,
        missing_sequences: Vec<u32>,
    },
    ManifestChunk {
        flags: u16,
        transport_session_id: u64,
        total_manifest_length: u16,
        chunk_offset: u16,
        manifest_sha256: Vec<u8>,
        chunk: Vec<u8>,
    },
    Eof {
        flags: u16,
        transport_session_id: u64,
        final_sequence: u32,
        block_count: u32,
        ciphertext_length: u64,
        ciphertext_sha256: Vec<u8>,
        manifest_sha256: Vec<u8>,
    },
    ResumeRequest {
        flags: u16,
        transport_session_id: u64,
        upload_session_uuid: String,
        recording_uuid: String,
        recording_generation: u32,
        checkpoint_revision: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
        window_packets: u16,
        data_payload_bytes: u16,
    },
    ResumeAccept {
        flags: u16,
        transport_session_id: u64,
        upload_session_uuid: String,
        recording_uuid: String,
        recording_generation: u32,
        checkpoint_revision: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
        window_packets: u16,
        data_payload_bytes: u16,
    },
    ResumeReject {
        flags: u16,
        transport_session_id: u64,
        reason: u16,
        checkpoint_revision: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: Vec<u8>,
    },
    Confirm {
        flags: u16,
        transport_session_id: u64,
        upload_session_uuid: String,
        recording_uuid: String,
        recording_generation: u32,
        owner_revision: u32,
        receipt_sha256: Vec<u8>,
    },
    Abort {
        flags: u16,
        transport_session_id: u64,
        reason: u16,
    },
    Error {
        flags: u16,
        transport_session_id: u64,
        result: u16,
        failed_message_type: u8,
        checkpoint_revision: u32,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebEncryptedUploadV2Status {
    pub phase: u8,
    pub result: u16,
    pub transport_session_id: u64,
    pub durable_ciphertext_bytes: u64,
    pub progress_percent: u8,
    pub transport_profile: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebEncryptedUploadV2SignedBlobResult {
    pub kind: u8,
    pub write_id: u32,
    pub result: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSignedBlobKind {
    Authorization,
    Receipt,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WebEncryptedUploadV2SignedBlob {
    Begin {
        blob_kind: WebSignedBlobKind,
        write_id: u32,
        total_length: u16,
        sha256: Vec<u8>,
    },
    Data {
        blob_kind: WebSignedBlobKind,
        write_id: u32,
        offset: u16,
        data: Vec<u8>,
    },
    Commit {
        blob_kind: WebSignedBlobKind,
        write_id: u32,
    },
    Abort {
        blob_kind: WebSignedBlobKind,
        write_id: u32,
    },
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct WebIntegrityHasher {
    sha256: Sha256,
    crc32: u32,
    length: u64,
}

impl Default for WebIntegrityHasher {
    fn default() -> Self {
        Self {
            sha256: Sha256::new(),
            crc32: u32::MAX,
            length: 0,
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl WebIntegrityHasher {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.sha256.update(bytes);
        self.length += bytes.len() as u64;
        for byte in bytes {
            self.crc32 ^= u32::from(*byte);
            for _ in 0..8 {
                let mask = 0_u32.wrapping_sub(self.crc32 & 1);
                self.crc32 = (self.crc32 >> 1) ^ (0xedb8_8320 & mask);
            }
        }
    }

    pub fn length(&self) -> u64 {
        self.length
    }

    pub fn crc32(&self) -> u32 {
        self.crc32 ^ u32::MAX
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = sha256Snapshot))]
    pub fn sha256_snapshot(&self) -> Vec<u8> {
        self.sha256.clone().finalize().to_vec()
    }
}

pub fn decode_recording_list_dto(bytes: &[u8]) -> Result<Vec<WebDeviceRecording>, DeviceSdkError> {
    parse_recording_list(bytes).map(|recordings| {
        recordings
            .into_iter()
            .map(|recording| {
                let (codec, codec_raw) = match recording.codec {
                    AudioCodec::Pcm16k => ("pcm_16k", None),
                    AudioCodec::Pcm8k => ("pcm_8k", None),
                    AudioCodec::Opus16k => ("opus_16k", None),
                    AudioCodec::Opus8k => ("opus_8k", None),
                    AudioCodec::Unknown(value) => ("unknown", Some(value)),
                };
                WebDeviceRecording {
                    uuid: recording.uuid.to_string(),
                    started_at_timestamp_seconds: recording.started_at_timestamp,
                    duration_milliseconds: recording.duration_ms,
                    file_size_bytes: recording.file_size_bytes,
                    codec,
                    codec_raw,
                    encrypted: recording.encrypted,
                }
            })
            .collect()
    })
}

pub fn encode_recording_list_command() -> Result<Vec<u8>, DeviceSdkError> {
    encode_transfer_command(TransferCommand::List)
}

pub fn encode_recording_confirm(recording_uuid: &str) -> Result<Vec<u8>, DeviceSdkError> {
    encode_transfer_command(TransferCommand::Confirm(RecordingUuid::from_str(
        recording_uuid,
    )?))
}

pub fn encode_deprovision_command() -> Result<Vec<u8>, DeviceSdkError> {
    encode_device_command(bota_device_sdk_core::protocol::DeviceCommand::Deprovision)
}

pub fn decode_deprovision_result_dto(bytes: &[u8]) -> Result<DeprovisionResult, DeviceSdkError> {
    parse_deprovision_result(bytes)
}

pub fn decode_connection_settings_dto(
    bytes: &[u8],
) -> Result<WebDecodedConnectionSettings, DeviceSdkError> {
    let parsed = parse_connection_settings(bytes)?;
    Ok(WebDecodedConnectionSettings {
        settings: settings_to_web(parsed.settings),
        supported_version: parsed.supported_version,
    })
}

pub fn encode_connection_settings_dto(
    settings: WebConnectionSettings,
    model: &str,
) -> Result<Vec<u8>, DeviceSdkError> {
    let model = match model {
        "pin" => DeviceModel::Pin,
        "pin_4g" => DeviceModel::Pin4g,
        "note" => DeviceModel::Note,
        _ => return Err(invalid_input("unsupported device model")),
    };
    encode_connection_settings(&settings_from_web(settings)?, model)
}

pub fn decode_wifi_config_result_dto(bytes: &[u8]) -> Result<WebResult, DeviceSdkError> {
    let result = parse_wifi_config_result(bytes)?;
    Ok(match result {
        WiFiConfigResult::Success => success_result(),
        WiFiConfigResult::InvalidGrant => failure_result("invalid_grant", None),
        WiFiConfigResult::GrantExpired => failure_result("grant_expired", None),
        WiFiConfigResult::DecryptionError => failure_result("decryption_error", None),
        WiFiConfigResult::StorageError => failure_result("storage_error", None),
        WiFiConfigResult::Unknown(value) => failure_result("unknown", Some(value)),
    })
}

pub fn decode_wifi_status_dto(bytes: &[u8]) -> Result<WebWiFiStatusInfo, DeviceSdkError> {
    let info = parse_wifi_status_info(bytes)?;
    let (status, status_raw) = match info.status {
        WiFiStatus::Idle => ("idle", WiFiStatus::Idle.to_wire()),
        WiFiStatus::Connecting => ("connecting", WiFiStatus::Connecting.to_wire()),
        WiFiStatus::Connected => ("connected", WiFiStatus::Connected.to_wire()),
        WiFiStatus::Failed => ("failed", WiFiStatus::Failed.to_wire()),
        WiFiStatus::Disconnected => ("disconnected", WiFiStatus::Disconnected.to_wire()),
        WiFiStatus::Unknown(value) => ("unknown", value),
    };
    Ok(WebWiFiStatusInfo {
        status,
        status_raw,
        signal_strength: info.signal_strength,
        ssid: info.ssid,
        last_error: info.last_error,
    })
}

pub fn decode_wifi_scan_update_dto(bytes: &[u8]) -> Result<WebWiFiScanUpdate, DeviceSdkError> {
    Ok(match parse_wifi_scan_result(bytes)? {
        WiFiScanUpdate::Pending(status_raw) => WebWiFiScanUpdate::Pending { status_raw },
        WiFiScanUpdate::Done(result) => WebWiFiScanUpdate::Done {
            networks: result
                .networks
                .into_iter()
                .map(|network| WebWiFiScanNetwork {
                    ssid: network.ssid,
                    quality: network.quality,
                    is_current: network.is_current,
                    is_open: network.is_open,
                })
                .collect(),
            current_ssid: result.current_ssid,
        },
    })
}

pub fn encode_recording_control_command_dto(action: &str) -> Result<Vec<u8>, DeviceSdkError> {
    let command = match action {
        "start" => RecordingControlCommand::Start,
        "stop" => RecordingControlCommand::Stop,
        _ => return Err(invalid_input("unknown recording control action")),
    };
    Ok(encode_recording_control_command(command).to_vec())
}

pub fn decode_recording_control_result_dto(bytes: &[u8]) -> Result<WebResult, DeviceSdkError> {
    let result = parse_recording_control_result(bytes)?;
    Ok(match result.error {
        None => success_result(),
        Some(error) => failure_result(recording_control_error(error), None),
    })
}

pub fn decode_encrypted_upload_v2_transfer_dto(
    bytes: &[u8],
) -> Result<WebEncryptedUploadV2Transfer, DeviceSdkError> {
    encrypted_transfer_to_web(decode_encrypted_upload_v2_transfer(bytes)?)
}

pub fn encode_encrypted_upload_v2_transfer_dto(
    frame: WebEncryptedUploadV2Transfer,
) -> Result<Vec<u8>, DeviceSdkError> {
    match frame {
        WebEncryptedUploadV2Transfer::List {
            flags,
            transport_session_id,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::List(common(
            wire::ENCRYPTED_UPLOAD_V2_LIST,
            flags,
            transport_session_id,
        ))),
        WebEncryptedUploadV2Transfer::Start {
            flags,
            transport_session_id,
            upload_session_uuid,
            recording_uuid,
            recording_generation,
            authorization_sha256,
            checkpoint_revision,
            next_ciphertext_offset,
            prefix_sha256,
            window_packets,
            data_payload_bytes,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Start(StartV2 {
            common: common(wire::ENCRYPTED_UPLOAD_V2_START, flags, transport_session_id),
            upload_session_uuid: uuid(&upload_session_uuid)?,
            recording_uuid: uuid(&recording_uuid)?,
            recording_generation,
            authorization_sha256: fixed(authorization_sha256, "authorization SHA-256")?,
            checkpoint_revision,
            next_ciphertext_offset,
            prefix_sha256: fixed(prefix_sha256, "prefix SHA-256")?,
            window_packets,
            data_payload_bytes,
        })),
        WebEncryptedUploadV2Transfer::WindowAck {
            flags,
            transport_session_id,
            window_index,
            highest_contiguous_sequence,
            next_ciphertext_offset,
            prefix_sha256,
            checkpoint_revision,
            missing_sequences,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::WindowAck(
            WindowAckV2 {
                common: common(
                    wire::ENCRYPTED_UPLOAD_V2_WINDOW_ACK,
                    flags,
                    transport_session_id,
                ),
                window_index,
                highest_contiguous_sequence,
                next_ciphertext_offset,
                prefix_sha256: fixed(prefix_sha256, "prefix SHA-256")?,
                checkpoint_revision,
                missing_sequences,
            },
        )),
        WebEncryptedUploadV2Transfer::ResumeRequest {
            flags,
            transport_session_id,
            upload_session_uuid,
            recording_uuid,
            recording_generation,
            checkpoint_revision,
            next_ciphertext_offset,
            prefix_sha256,
            window_packets,
            data_payload_bytes,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ResumeRequest(
            ResumeV2 {
                common: common(
                    wire::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST,
                    flags,
                    transport_session_id,
                ),
                upload_session_uuid: uuid(&upload_session_uuid)?,
                recording_uuid: uuid(&recording_uuid)?,
                recording_generation,
                checkpoint_revision,
                next_ciphertext_offset,
                prefix_sha256: fixed(prefix_sha256, "prefix SHA-256")?,
                window_packets,
                data_payload_bytes,
            },
        )),
        WebEncryptedUploadV2Transfer::Confirm {
            flags,
            transport_session_id,
            upload_session_uuid,
            recording_uuid,
            recording_generation,
            owner_revision,
            receipt_sha256,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Confirm(ConfirmV2 {
            common: common(
                wire::ENCRYPTED_UPLOAD_V2_CONFIRM,
                flags,
                transport_session_id,
            ),
            upload_session_uuid: uuid(&upload_session_uuid)?,
            recording_uuid: uuid(&recording_uuid)?,
            recording_generation,
            owner_revision,
            receipt_sha256: fixed(receipt_sha256, "receipt SHA-256")?,
        })),
        WebEncryptedUploadV2Transfer::Abort {
            flags,
            transport_session_id,
            reason,
        } => encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Abort {
            common: common(wire::ENCRYPTED_UPLOAD_V2_ABORT, flags, transport_session_id),
            reason,
        }),
        _ => Err(invalid_input(
            "only app-originated encrypted upload v2 transfer frames may be encoded",
        )),
    }
}

pub fn decode_encrypted_upload_v2_status_dto(
    bytes: &[u8],
) -> Result<WebEncryptedUploadV2Status, DeviceSdkError> {
    let value = decode_encrypted_upload_v2_status(bytes)?;
    Ok(WebEncryptedUploadV2Status {
        phase: value.phase,
        result: value.result,
        transport_session_id: value.transport_session_id,
        durable_ciphertext_bytes: value.durable_ciphertext_bytes,
        progress_percent: value.progress_percent,
        transport_profile: value.transport_profile,
    })
}

pub fn encode_encrypted_upload_v2_signed_blob_dto(
    frame: WebEncryptedUploadV2SignedBlob,
) -> Result<Vec<u8>, DeviceSdkError> {
    match frame {
        WebEncryptedUploadV2SignedBlob::Begin {
            blob_kind,
            write_id,
            total_length,
            sha256,
        } => encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Begin {
            kind: signed_blob_kind(blob_kind),
            write_id,
            total_length,
            sha256: fixed(sha256, "signed blob SHA-256")?,
        }),
        WebEncryptedUploadV2SignedBlob::Data {
            blob_kind,
            write_id,
            offset,
            data,
        } => encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Data {
            kind: signed_blob_kind(blob_kind),
            write_id,
            offset,
            data: &data,
        }),
        WebEncryptedUploadV2SignedBlob::Commit {
            blob_kind,
            write_id,
        } => encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Commit {
            kind: signed_blob_kind(blob_kind),
            write_id,
        }),
        WebEncryptedUploadV2SignedBlob::Abort {
            blob_kind,
            write_id,
        } => encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Abort {
            kind: signed_blob_kind(blob_kind),
            write_id,
        }),
    }
}

pub fn decode_encrypted_upload_v2_signed_blob_result_dto(
    bytes: &[u8],
) -> Result<WebEncryptedUploadV2SignedBlobResult, DeviceSdkError> {
    match decode_encrypted_upload_v2_signed_blob(bytes)? {
        EncryptedUploadV2SignedBlob::Result {
            kind,
            write_id,
            result,
        } => Ok(WebEncryptedUploadV2SignedBlobResult {
            kind,
            write_id,
            result,
        }),
        _ => Err(
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false)
                .with_detail("signed blob notification is not a result frame"),
        ),
    }
}

fn settings_to_web(settings: DeviceConnectionSettings) -> WebConnectionSettings {
    WebConnectionSettings {
        enabled_connections: WebConnectionFlags {
            wifi: settings.enabled.wifi,
            cellular: settings.enabled.cellular,
        },
        heartbeat_enabled_connections: WebConnectionFlags {
            wifi: settings.heartbeat.wifi,
            cellular: settings.heartbeat.cellular,
        },
        upload_network_preference: settings
            .upload_priority
            .into_iter()
            .map(|connection| match connection {
                ConnectionType::Wifi => WebConnectionType::Wifi,
                ConnectionType::Ble => WebConnectionType::Ble,
                ConnectionType::Cellular => WebConnectionType::Cellular,
                ConnectionType::Unknown(_) => WebConnectionType::Unknown,
            })
            .collect(),
        power_management: WebPowerManagement {
            cellular_idle_timeout_seconds: settings.power.cellular.seconds(),
            wifi_idle_timeout_seconds: settings.power.wifi.seconds(),
        },
        streaming_enabled: settings.streaming_enabled,
        streaming_flush_interval_seconds: settings.streaming_flush_interval_seconds,
    }
}

fn settings_from_web(
    settings: WebConnectionSettings,
) -> Result<DeviceConnectionSettings, DeviceSdkError> {
    let upload_priority = settings
        .upload_network_preference
        .into_iter()
        .map(|connection| match connection {
            WebConnectionType::Wifi => Ok(ConnectionType::Wifi),
            WebConnectionType::Ble => Ok(ConnectionType::Ble),
            WebConnectionType::Cellular => Ok(ConnectionType::Cellular),
            WebConnectionType::Unknown => {
                Err(invalid_input("unknown connection types cannot be encoded"))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DeviceConnectionSettings {
        enabled: EnabledConnections {
            wifi: settings.enabled_connections.wifi,
            cellular: settings.enabled_connections.cellular,
        },
        heartbeat: HeartbeatConnections {
            wifi: settings.heartbeat_enabled_connections.wifi,
            cellular: settings.heartbeat_enabled_connections.cellular,
            unknown_mask: 0,
        },
        upload_priority,
        power: PowerManagement {
            cellular: IdleTimeout::try_from_seconds(
                settings.power_management.cellular_idle_timeout_seconds,
            )?,
            wifi: IdleTimeout::try_from_seconds(
                settings.power_management.wifi_idle_timeout_seconds,
            )?,
        },
        streaming_enabled: settings.streaming_enabled,
        streaming_flush_interval_seconds: settings.streaming_flush_interval_seconds,
    })
}

#[cfg(target_arch = "wasm32")]
fn deprovision_to_web(result: DeprovisionResult) -> WebResult {
    match result.error {
        None => success_result(),
        Some(DeprovisionFailure::InvalidToken) => failure_result("invalid_token", None),
        Some(DeprovisionFailure::StorageError) => failure_result("storage_error", None),
        Some(DeprovisionFailure::ChunkError) => failure_result("chunk_error", None),
        Some(DeprovisionFailure::AlreadyPaired) => failure_result("already_paired", None),
        Some(DeprovisionFailure::Unknown(value)) => failure_result("unknown", Some(value)),
    }
}

const fn success_result() -> WebResult {
    WebResult {
        success: true,
        error: None,
        error_raw: None,
    }
}

const fn failure_result(error: &'static str, error_raw: Option<u8>) -> WebResult {
    WebResult {
        success: false,
        error: Some(error),
        error_raw,
    }
}

const fn recording_control_error(error: RecordingControlError) -> &'static str {
    match error {
        RecordingControlError::AlreadyRecording => "already_recording",
        RecordingControlError::NotRecording => "not_recording",
        RecordingControlError::InvalidGrant => "invalid_grant",
        RecordingControlError::GrantExpired => "grant_expired",
        RecordingControlError::InvalidState => "invalid_state",
        RecordingControlError::InvalidResponse => "invalid_response",
        RecordingControlError::UnknownError => "unknown_error",
    }
}

fn common(message_type: u8, flags: u16, transport_session_id: u64) -> CommonHeaderV2 {
    CommonHeaderV2 {
        message_type,
        flags,
        transport_session_id,
    }
}

fn encrypted_transfer_to_web(
    frame: EncryptedUploadV2Transfer<'_>,
) -> Result<WebEncryptedUploadV2Transfer, DeviceSdkError> {
    Ok(match frame {
        EncryptedUploadV2Transfer::List(value) => WebEncryptedUploadV2Transfer::List {
            flags: value.flags,
            transport_session_id: value.transport_session_id,
        },
        EncryptedUploadV2Transfer::RecordingEntry(value) => {
            WebEncryptedUploadV2Transfer::RecordingEntry {
                flags: value.common.flags,
                transport_session_id: value.common.transport_session_id,
                recording_uuid: uuid_text(value.recording_uuid),
                recording_generation: value.recording_generation,
                storage_format: value.storage_format,
                completion_state: value.completion_state,
                started_at: value.started_at,
                duration_seconds: value.duration_seconds,
                plaintext_length: value.plaintext_length,
                ciphertext_length: value.ciphertext_length,
                ciphertext_sha256: value.ciphertext_sha256.to_vec(),
            }
        }
        EncryptedUploadV2Transfer::RecordingListEnd {
            common,
            count,
            list_revision,
            list_sha256,
        } => WebEncryptedUploadV2Transfer::RecordingListEnd {
            flags: common.flags,
            transport_session_id: common.transport_session_id,
            count,
            list_revision,
            list_sha256: list_sha256.to_vec(),
        },
        EncryptedUploadV2Transfer::Start(value) => WebEncryptedUploadV2Transfer::Start {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            upload_session_uuid: uuid_text(value.upload_session_uuid),
            recording_uuid: uuid_text(value.recording_uuid),
            recording_generation: value.recording_generation,
            authorization_sha256: value.authorization_sha256.to_vec(),
            checkpoint_revision: value.checkpoint_revision,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
            window_packets: value.window_packets,
            data_payload_bytes: value.data_payload_bytes,
        },
        EncryptedUploadV2Transfer::StartAck(value) => WebEncryptedUploadV2Transfer::StartAck {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            upload_session_uuid: uuid_text(value.upload_session_uuid),
            recording_uuid: uuid_text(value.recording_uuid),
            recording_generation: value.recording_generation,
            ciphertext_length: value.ciphertext_length,
            ciphertext_sha256: value.ciphertext_sha256.to_vec(),
            window_packets: value.window_packets,
            data_payload_bytes: value.data_payload_bytes,
            checkpoint_interval_blocks: value.checkpoint_interval_blocks,
            checkpoint_revision: value.checkpoint_revision,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
        },
        EncryptedUploadV2Transfer::Data {
            common,
            sequence,
            offset,
            data,
        } => WebEncryptedUploadV2Transfer::Data {
            flags: common.flags,
            transport_session_id: common.transport_session_id,
            sequence,
            offset,
            data: data.to_vec(),
        },
        EncryptedUploadV2Transfer::WindowEnd(value) => WebEncryptedUploadV2Transfer::WindowEnd {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            window_index: value.window_index,
            first_sequence: value.first_sequence,
            last_sequence: value.last_sequence,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
            checkpoint_revision: value.checkpoint_revision,
        },
        EncryptedUploadV2Transfer::WindowAck(value) => WebEncryptedUploadV2Transfer::WindowAck {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            window_index: value.window_index,
            highest_contiguous_sequence: value.highest_contiguous_sequence,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
            checkpoint_revision: value.checkpoint_revision,
            missing_sequences: value.missing_sequences,
        },
        EncryptedUploadV2Transfer::ManifestChunk(value) => {
            WebEncryptedUploadV2Transfer::ManifestChunk {
                flags: value.common.flags,
                transport_session_id: value.common.transport_session_id,
                total_manifest_length: value.total_manifest_length,
                chunk_offset: value.chunk_offset,
                manifest_sha256: value.manifest_sha256.to_vec(),
                chunk: value.chunk.to_vec(),
            }
        }
        EncryptedUploadV2Transfer::Eof(value) => WebEncryptedUploadV2Transfer::Eof {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            final_sequence: value.final_sequence,
            block_count: value.block_count,
            ciphertext_length: value.ciphertext_length,
            ciphertext_sha256: value.ciphertext_sha256.to_vec(),
            manifest_sha256: value.manifest_sha256.to_vec(),
        },
        EncryptedUploadV2Transfer::ResumeRequest(value) => resume_to_web(value, true),
        EncryptedUploadV2Transfer::ResumeAccept(value) => resume_to_web(value, false),
        EncryptedUploadV2Transfer::ResumeReject(value) => {
            WebEncryptedUploadV2Transfer::ResumeReject {
                flags: value.common.flags,
                transport_session_id: value.common.transport_session_id,
                reason: value.reason,
                checkpoint_revision: value.checkpoint_revision,
                next_ciphertext_offset: value.next_ciphertext_offset,
                prefix_sha256: value.prefix_sha256.to_vec(),
            }
        }
        EncryptedUploadV2Transfer::Confirm(value) => WebEncryptedUploadV2Transfer::Confirm {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            upload_session_uuid: uuid_text(value.upload_session_uuid),
            recording_uuid: uuid_text(value.recording_uuid),
            recording_generation: value.recording_generation,
            owner_revision: value.owner_revision,
            receipt_sha256: value.receipt_sha256.to_vec(),
        },
        EncryptedUploadV2Transfer::Abort { common, reason } => {
            WebEncryptedUploadV2Transfer::Abort {
                flags: common.flags,
                transport_session_id: common.transport_session_id,
                reason,
            }
        }
        EncryptedUploadV2Transfer::Error {
            common,
            result,
            failed_message_type,
            checkpoint_revision,
        } => WebEncryptedUploadV2Transfer::Error {
            flags: common.flags,
            transport_session_id: common.transport_session_id,
            result,
            failed_message_type,
            checkpoint_revision,
        },
    })
}

fn resume_to_web(value: ResumeV2, request: bool) -> WebEncryptedUploadV2Transfer {
    if request {
        WebEncryptedUploadV2Transfer::ResumeRequest {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            upload_session_uuid: uuid_text(value.upload_session_uuid),
            recording_uuid: uuid_text(value.recording_uuid),
            recording_generation: value.recording_generation,
            checkpoint_revision: value.checkpoint_revision,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
            window_packets: value.window_packets,
            data_payload_bytes: value.data_payload_bytes,
        }
    } else {
        WebEncryptedUploadV2Transfer::ResumeAccept {
            flags: value.common.flags,
            transport_session_id: value.common.transport_session_id,
            upload_session_uuid: uuid_text(value.upload_session_uuid),
            recording_uuid: uuid_text(value.recording_uuid),
            recording_generation: value.recording_generation,
            checkpoint_revision: value.checkpoint_revision,
            next_ciphertext_offset: value.next_ciphertext_offset,
            prefix_sha256: value.prefix_sha256.to_vec(),
            window_packets: value.window_packets,
            data_payload_bytes: value.data_payload_bytes,
        }
    }
}

fn uuid(value: &str) -> Result<[u8; 16], DeviceSdkError> {
    RecordingUuid::from_str(value).map(|uuid| *uuid.as_bytes())
}

fn uuid_text(value: [u8; 16]) -> String {
    RecordingUuid::from_bytes(value).to_string()
}

fn fixed<const N: usize>(bytes: Vec<u8>, label: &str) -> Result<[u8; N], DeviceSdkError> {
    bytes
        .try_into()
        .map_err(|_| invalid_input(format!("{label} must contain exactly {N} bytes")))
}

const fn signed_blob_kind(kind: WebSignedBlobKind) -> u8 {
    match kind {
        WebSignedBlobKind::Authorization => wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION,
        WebSignedBlobKind::Receipt => wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_RECEIPT,
    }
}

fn invalid_input(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false).with_detail(detail)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use serde::{Serialize, de::DeserializeOwned};

    #[wasm_bindgen(js_name = decodeRecordingList)]
    pub fn decode_recording_list(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_recording_list_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = encodeRecordingListCommand)]
    pub fn encode_recording_list_command_wasm() -> Result<Vec<u8>, JsValue> {
        super::encode_recording_list_command().map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encodeRecordingConfirm)]
    pub fn encode_recording_confirm_wasm(recording_uuid: &str) -> Result<Vec<u8>, JsValue> {
        super::encode_recording_confirm(recording_uuid).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encodeDeprovisionCommand)]
    pub fn encode_deprovision_command_wasm() -> Result<Vec<u8>, JsValue> {
        super::encode_deprovision_command().map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = decodeDeprovisionResult)]
    pub fn decode_deprovision_result(bytes: &[u8]) -> Result<JsValue, JsValue> {
        let result = decode_deprovision_result_dto(bytes).map_err(error_to_js)?;
        to_js(&deprovision_to_web(result))
    }

    #[wasm_bindgen(js_name = decodeConnectionSettings)]
    pub fn decode_connection_settings(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_connection_settings_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = encodeConnectionSettings)]
    pub fn encode_connection_settings_wasm(
        settings: JsValue,
        model: &str,
    ) -> Result<Vec<u8>, JsValue> {
        encode_connection_settings_dto(from_js(settings)?, model).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encodeWiFiGrant)]
    pub fn encode_wifi_grant_wasm(grant: &str, capacity: usize) -> Result<Vec<u8>, JsValue> {
        encode_wifi_grant(grant, capacity).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encodeWiFiCredentials)]
    pub fn encode_wifi_credentials_wasm(ssid: &str, password: &str) -> Result<Vec<u8>, JsValue> {
        encode_wifi_credentials(ssid, password).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encodeWiFiScanCommand)]
    pub fn encode_wifi_scan_command_wasm() -> Result<Vec<u8>, JsValue> {
        encode_wifi_scan_command().map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = decodeWiFiConfigResult)]
    pub fn decode_wifi_config_result(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_wifi_config_result_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = decodeWiFiStatus)]
    pub fn decode_wifi_status(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_wifi_status_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = decodeWiFiScanUpdate)]
    pub fn decode_wifi_scan_update(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_wifi_scan_update_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = encodeRecordingControlCommand)]
    pub fn encode_recording_control_command_wasm(action: &str) -> Result<Vec<u8>, JsValue> {
        encode_recording_control_command_dto(action).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = decodeRecordingControlResult)]
    pub fn decode_recording_control_result(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_recording_control_result_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = decodeEncryptedUploadV2Transfer)]
    pub fn decode_encrypted_upload_v2_transfer_wasm(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_encrypted_upload_v2_transfer_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = encodeEncryptedUploadV2Transfer)]
    pub fn encode_encrypted_upload_v2_transfer_wasm(frame: JsValue) -> Result<Vec<u8>, JsValue> {
        encode_encrypted_upload_v2_transfer_dto(from_js(frame)?).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = decodeEncryptedUploadV2Status)]
    pub fn decode_encrypted_upload_v2_status_wasm(bytes: &[u8]) -> Result<JsValue, JsValue> {
        to_js(&decode_encrypted_upload_v2_status_dto(bytes).map_err(error_to_js)?)
    }

    #[wasm_bindgen(js_name = encodeEncryptedUploadV2SignedBlob)]
    pub fn encode_encrypted_upload_v2_signed_blob_wasm(frame: JsValue) -> Result<Vec<u8>, JsValue> {
        encode_encrypted_upload_v2_signed_blob_dto(from_js(frame)?).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = decodeEncryptedUploadV2SignedBlobResult)]
    pub fn decode_encrypted_upload_v2_signed_blob_result_wasm(
        bytes: &[u8],
    ) -> Result<JsValue, JsValue> {
        to_js(&decode_encrypted_upload_v2_signed_blob_result_dto(bytes).map_err(error_to_js)?)
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
                    .with_detail("bridge input does not match the typed codec contract"),
            )
        })
    }

    fn error_to_js(error: DeviceSdkError) -> JsValue {
        to_js(&error).unwrap_or_else(|_| JsValue::from_str("internal_error"))
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
