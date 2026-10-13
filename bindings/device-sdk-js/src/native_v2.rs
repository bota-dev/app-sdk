//! Native compatibility DTOs over shared Rust validation and managed policy.
use crate::{
    codecs::{input, output, public_output},
    engine::invalid,
    v2,
};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    model::{
        DeviceSerialNumber, HostMaterialId, ManagedUploadRequest, RecordingSinkId,
        RecordingUploadProfile, RecordingUuid, UploadProfileSelection, UploadSecurityPolicy,
    },
    protocol::{
        CommonHeaderV2, EncryptedUploadV2ReceiverCheckpoint, EncryptedUploadV2Transfer,
        decode_encrypted_upload_v2_capabilities, encode_encrypted_upload_v2_transfer,
        validate_encrypted_upload_v2_admission,
    },
    workflow::{EncryptedUploadV2BatchRequest, EncryptedUploadV2Checkpoint},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json as object};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bytes {
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recording {
    uuid: String,
    generation: u32,
    ciphertext_length: u64,
    ciphertext_sha256: String,
    #[serde(default)]
    started_at_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    plaintext_length: Option<u64>,
    #[serde(default)]
    storage_format: Option<u8>,
    #[serde(default)]
    markers_required: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    profile: String,
    upload_session_id: String,
    owner_revision: u32,
    security_policy: String,
    material_registration_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeCheckpoint {
    version: u32,
    upload_session_id: String,
    owner_revision: u32,
    revision: u32,
    next_ciphertext_offset: u64,
    prefix_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    highest_contiguous_sequence: Option<u32>,
    transport_session_id: u64,
    sink_registration_id: String,
    window_packets: u16,
    data_payload_bytes: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    serial_number: String,
    recording: Recording,
    capability_bytes: Vec<u8>,
    decision: Decision,
    transport_session_id: u64,
    sink_id: String,
    maximum_write_bytes: u32,
    #[serde(default)]
    checkpoint: Option<NativeCheckpoint>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    scope: String,
    checkpoint: EncryptedUploadV2Checkpoint,
    receiver_checkpoint: EncryptedUploadV2ReceiverCheckpoint,
    sink_registration_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalInput {
    journal: Option<Journal>,
    scope: String,
    #[serde(rename = "serialNumber")]
    serial_number: String,
    recording: Recording,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalIdentityInput {
    scope: String,
    serial_number: String,
    recording: Recording,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalIdentity {
    journal_key: String,
    sink_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogPlan {
    transport_session_id: u64,
    #[serde(default)]
    previous_error: Option<CatalogError>,
    #[serde(default = "initial_attempt")]
    attempt: u8,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogError {
    code: String,
    protocol_status: Option<u16>,
}
fn initial_attempt() -> u8 {
    1
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingInput {
    legacy: Vec<Value>,
    encrypted: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRecording {
    uuid: String,
    started_at_ms: u64,
    duration_ms: u64,
    file_size: u64,
    codec: String,
    is_encrypted: bool,
}

pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "reduceManagedUpload"
            | "isEmptyLegacyAndroidV2CheckpointCatalog"
            | "planEncryptedUploadV2Request"
            | "nativeEncryptedUploadV2Capability"
            | "nativeEncryptedUploadV2Checkpoint"
            | "encryptedUploadV2LocalIdentity"
            | "planEncryptedUploadV2Catalog"
            | "mergePendingRecordings"
    )
}
#[inline(never)]
pub(crate) fn execute(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "isEmptyLegacyAndroidV2CheckpointCatalog" => {
            let bytes = input::<Bytes>(value)?.bytes;
            // The legacy native writer persists this exact version-1 empty catalog
            // after clearing the last checkpoint. Any other evidence stays pending.
            output(&(bytes.as_slice() == [0x42, 0x56, 0x32, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0]))
        }
        "reduceManagedUpload" => reduce_managed(value),
        "planEncryptedUploadV2Request" => output(&plan(input(value)?)?),
        "nativeEncryptedUploadV2Capability" => {
            let bytes = input::<Bytes>(value)?.bytes;
            let capability = decode_encrypted_upload_v2_capabilities(&bytes)?;
            public_output(
                object!({"encodingVersion":wire::ENCRYPTED_UPLOAD_V2_CAPABILITY_ENCODING_VERSION,"transferProfileVersion":wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION,"rawValueHex":hex(&bytes),"sha256Hex":hex(&Sha256::digest(&bytes)),"flags":capability.flags,"maximumSignedBlobBytes":capability.maximum_signed_blob_bytes,"maximumManifestBytes":capability.maximum_manifest_bytes,"maximumDataPayloadBytes":capability.maximum_data_payload_bytes,"maximumWindowPackets":capability.maximum_window_packets,"durableCheckpointIntervalBlocks":capability.durable_checkpoint_interval_blocks,"maximumMissingSequences":capability.maximum_missing_sequences}),
            )
        }
        "nativeEncryptedUploadV2Checkpoint" => output(&native_checkpoint(input(value)?)?),
        "encryptedUploadV2LocalIdentity" => output(&local_identity(&input(value)?)?),
        "planEncryptedUploadV2Catalog" => catalog_plan(input(value)?),
        "mergePendingRecordings" => pending_recordings(input(value)?),
        _ => Err(invalid("unknown native v2 boundary codec")),
    }
}
fn catalog_plan(input: CatalogPlan) -> Result<Vec<u8>, DeviceSdkError> {
    let include_markers = match (input.attempt, &input.previous_error) {
        (1, None) => true,
        (2, Some(error))
            if error.code == ErrorCode::ProtocolRejected.as_str()
                && error.protocol_status
                    == Some(wire::ENCRYPTED_UPLOAD_V2_RESULT_NONCANONICAL_ENCODING) =>
        {
            false
        }
        (_, Some(previous)) => {
            let code = [
                ErrorCode::InvalidInput,
                ErrorCode::TruncatedPacket,
                ErrorCode::UnknownPacket,
                ErrorCode::PayloadTooLarge,
                ErrorCode::UnsupportedCapability,
                ErrorCode::UnsupportedOperation,
                ErrorCode::FeatureUnavailable,
                ErrorCode::OperationInProgress,
                ErrorCode::UnexpectedEvent,
                ErrorCode::DeviceNotFound,
                ErrorCode::IdentityMismatch,
                ErrorCode::ConnectionFailed,
                ErrorCode::PersistenceFailed,
                ErrorCode::NotConnected,
                ErrorCode::Timeout,
                ErrorCode::Cancelled,
                ErrorCode::ProtocolRejected,
                ErrorCode::IntegrityFailed,
                ErrorCode::UploadOwnershipUnknown,
                ErrorCode::DownloadFailed,
                ErrorCode::Internal,
            ]
            .into_iter()
            .find(|code| code.as_str() == previous.code)
            .unwrap_or(ErrorCode::Internal);
            let mut error = DeviceSdkError::new(
                code,
                Operation::TransferRecording,
                matches!(
                    code,
                    ErrorCode::Timeout | ErrorCode::ConnectionFailed | ErrorCode::NotConnected
                ),
            );
            error.protocol_status = previous.protocol_status;
            return Err(
                error.with_detail("encrypted catalog has no permitted fallback for this failure")
            );
        }
        _ => {
            return Err(invalid(
                "encrypted catalog retry has no preceding rejection",
            ));
        }
    };
    let common = CommonHeaderV2 {
        message_type: wire::ENCRYPTED_UPLOAD_V2_LIST,
        flags: 0,
        transport_session_id: input.transport_session_id,
    };
    let frame = if include_markers {
        EncryptedUploadV2Transfer::MarkedList(common)
    } else {
        EncryptedUploadV2Transfer::List(common)
    };
    public_output(
        object!({"command":encode_encrypted_upload_v2_transfer(&frame)?,"includeMarkers":include_markers}),
    )
}
fn pending_recordings(input: PendingInput) -> Result<Vec<u8>, DeviceSdkError> {
    let mut aliases = BTreeSet::new();
    let mut pending = Vec::new();
    for mut value in input.encrypted {
        let recording: Recording = crate::codecs::input(value.clone())?;
        let uuid = recording.uuid.parse::<RecordingUuid>()?.to_string();
        unhex32(&recording.ciphertext_sha256)?;
        if recording.generation == 0 {
            return Err(invalid("encrypted catalog recording generation is zero"));
        }
        let alias = format!("{}-0000-0000-0000-000000000000", &uuid[..8]);
        if !aliases.insert(alias) {
            return Err(DeviceSdkError::new(
                ErrorCode::IntegrityFailed,
                Operation::TransferRecording,
                false,
            )
            .with_detail("encrypted catalog contains colliding legacy aliases"));
        }
        let fields = value
            .as_object_mut()
            .ok_or_else(|| invalid("encrypted recording is not an object"))?;
        fields.insert("uuid".into(), Value::String(uuid));
        fields.insert(
            "ciphertextLength".into(),
            Value::String(recording.ciphertext_length.to_string()),
        );
        fields.insert(
            "ciphertextSha256".into(),
            Value::String(hex(&unhex32(&recording.ciphertext_sha256)?)),
        );
        for (name, number) in [
            ("startedAtMs", recording.started_at_ms),
            ("durationMs", recording.duration_ms),
            ("plaintextLength", recording.plaintext_length),
        ] {
            if let Some(number) = number {
                fields.insert(name.into(), Value::String(number.to_string()));
            }
        }
        pending.push(object!({"profile":"encrypted_upload_v2","encrypted":value}));
    }
    for value in input.legacy {
        let recording: LegacyRecording = crate::codecs::input(value)?;
        let uuid = recording.uuid.parse::<RecordingUuid>()?.to_string();
        if aliases.contains(&uuid) {
            continue;
        }
        if [
            recording.started_at_ms,
            recording.duration_ms,
            recording.file_size,
        ]
        .into_iter()
        .any(|value| value > 9_007_199_254_740_991)
        {
            return Err(invalid(
                "legacy catalog metadata exceeds its public number range",
            ));
        }
        pending.push(object!({"profile":"legacy","legacy":{"uuid":uuid,"startedAtMs":recording.started_at_ms,"durationMs":recording.duration_ms,"fileSize":recording.file_size,"codec":recording.codec,"isEncrypted":recording.is_encrypted}}));
    }
    public_output(Value::Array(pending))
}
fn reduce_managed(mut value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    // Internally tagged serde enums buffer their contents. Only nowMs is u64;
    // validate its exact decimal value before their normal serde deserializer.
    let parsed = (|| {
        if let Some(now) = value
            .get_mut("event")
            .and_then(|event| event.get_mut("nowMs"))
        {
            let number = match now {
                Value::String(text) => {
                    let parsed = text.parse::<u64>().ok()?;
                    if parsed.to_string() != *text {
                        return None;
                    }
                    parsed
                }
                Value::Number(number) => number
                    .as_u64()
                    .filter(|number| *number <= 9_007_199_254_740_991)?,
                _ => return None,
            };
            *now = Value::Number(number.into());
        }
        serde_json::from_value::<ManagedUploadRequest>(value).ok()
    })();
    match parsed {
        Some(request) => match request.reduce() {
            Ok(reply) => public_output(
                serde_json::to_value(reply)
                    .map_err(|_| invalid("managed upload reply serialization failed"))?,
            ),
            Err(error) => public_output(object!({"error":{"code":error.code()}})),
        },
        None => public_output(object!({"error":{"code":"BOTA_UPLOAD_INVALID_INPUT"}})),
    }
}
fn plan(input: Plan) -> Result<EncryptedUploadV2BatchRequest, DeviceSdkError> {
    let capabilities = validate_encrypted_upload_v2_admission(&input.capability_bytes, false)?;
    let maximum_frame_bytes = (input.maximum_write_bytes as usize).min(wire::MAX_MTU);
    if maximum_frame_bytes < wire::ENCRYPTED_UPLOAD_V2_START_ACK_FIXED_LENGTH {
        return Err(DeviceSdkError::new(
            ErrorCode::UnsupportedCapability,
            Operation::TransferRecording,
            false,
        )
        .with_detail("encrypted upload negotiated frame cannot carry START_ACK"));
    }
    let missing = usize::from(capabilities.maximum_missing_sequences).min(
        (maximum_frame_bytes - wire::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH)
            / std::mem::size_of::<u32>(),
    );
    let maximum_window = usize::from(capabilities.maximum_window_packets).min(missing);
    let maximum_data = usize::from(capabilities.maximum_data_payload_bytes)
        .min(maximum_frame_bytes - wire::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH);
    if maximum_window == 0 || maximum_data == 0 {
        return Err(invalid("encrypted upload negotiated window is unusable"));
    }
    let policy = match input.decision.security_policy.as_str() {
        "legacy_allowed" => UploadSecurityPolicy::LegacyAllowed,
        "v2_preferred" => UploadSecurityPolicy::V2Preferred,
        "v2_required" => UploadSecurityPolicy::V2Required,
        _ => return Err(invalid("encrypted upload security policy is unknown")),
    };
    if input.decision.profile != "encrypted_upload_v2"
        || input.decision.owner_revision == 0
        || input.decision.owner_revision > i32::MAX as u32
        || input.recording.generation == 0
    {
        return Err(invalid(
            "encrypted upload profile decision or recording generation is invalid",
        ));
    }
    let storage_format = input
        .recording
        .storage_format
        .unwrap_or(wire::STORAGE_FORMAT_BOTA_ENC_V2);
    let mut request = EncryptedUploadV2BatchRequest {
        device: DeviceSerialNumber::new(input.serial_number)?,
        recording: input.recording.uuid.parse::<RecordingUuid>()?,
        recording_generation: input.recording.generation,
        storage_format,
        upload_session_uuid: *input
            .decision
            .upload_session_id
            .parse::<RecordingUuid>()?
            .as_bytes(),
        owner_revision: input.decision.owner_revision,
        transport_session_id: input.transport_session_id,
        material_id: HostMaterialId::new(input.decision.material_registration_id)?,
        sink_id: RecordingSinkId::new(input.sink_id)?,
        selection: UploadProfileSelection {
            policy,
            profile: RecordingUploadProfile::EncryptedUploadV2,
        },
        capabilities,
        window_packets: maximum_window as u16,
        data_payload_bytes: maximum_data as u16,
        ciphertext_length: input.recording.ciphertext_length,
        ciphertext_sha256: unhex32(&input.recording.ciphertext_sha256)?,
    };
    // Optional public metadata is validated at this boundary; it is not used as
    // evidence that ciphertext or a private sink exists.
    if input
        .recording
        .started_at_ms
        .is_some_and(|value| value > 253_402_300_799_999)
        || input
            .recording
            .duration_ms
            .is_some_and(|value| value > 253_402_300_799_999)
        || input
            .recording
            .plaintext_length
            .is_some_and(|value| value > 9_007_199_254_740_991)
    {
        return Err(invalid(
            "encrypted recording metadata exceeds its public range",
        ));
    }
    if input.recording.markers_required == Some(true)
        && usize::from(capabilities.maximum_signed_blob_bytes) < 864
    {
        return Err(DeviceSdkError::new(
            ErrorCode::UnsupportedCapability,
            Operation::TransferRecording,
            false,
        )
        .with_detail("marked admission exceeds negotiated signed document capacity"));
    }
    if let Some(checkpoint) = input.checkpoint {
        validate_native_checkpoint(&checkpoint)?;
        let checkpoint_session = *checkpoint
            .upload_session_id
            .parse::<RecordingUuid>()?
            .as_bytes();
        if checkpoint_session == request.upload_session_uuid
            && checkpoint.owner_revision == request.owner_revision
        {
            if checkpoint.next_ciphertext_offset > request.ciphertext_length
                || usize::from(checkpoint.window_packets) > maximum_window
                || usize::from(checkpoint.data_payload_bytes) > maximum_data
            {
                return Err(DeviceSdkError::new(
                    ErrorCode::IntegrityFailed,
                    Operation::TransferRecording,
                    false,
                )
                .with_detail(
                    "resume checkpoint exceeds the selected recording or negotiated bounds",
                ));
            }
            request.transport_session_id = checkpoint.transport_session_id;
            request.sink_id = RecordingSinkId::new(checkpoint.sink_registration_id)?;
            request.window_packets = checkpoint.window_packets;
            request.data_payload_bytes = checkpoint.data_payload_bytes;
        } else if checkpoint.owner_revision >= request.owner_revision
            || checkpoint_session == request.upload_session_uuid
        {
            return Err(DeviceSdkError::new(
                ErrorCode::IdentityMismatch,
                Operation::TransferRecording,
                false,
            )
            .with_detail("encrypted upload successor does not advance the exact owner"));
        }
    }
    v2::validate_request(&request)?;
    Ok(request)
}
fn validate_native_checkpoint(checkpoint: &NativeCheckpoint) -> Result<(), DeviceSdkError> {
    checkpoint.upload_session_id.parse::<RecordingUuid>()?;
    RecordingSinkId::new(&checkpoint.sink_registration_id)?;
    unhex32(&checkpoint.prefix_sha256)?;
    if checkpoint.version != 1
        || checkpoint.owner_revision == 0
        || checkpoint.owner_revision > i32::MAX as u32
        || checkpoint.transport_session_id == 0
        || checkpoint.window_packets == 0
        || checkpoint.data_payload_bytes == 0
        || (checkpoint.revision == 0) != (checkpoint.next_ciphertext_offset == 0)
        || checkpoint.highest_contiguous_sequence == Some(0)
    {
        return Err(invalid(
            "encrypted upload native checkpoint shape is invalid",
        ));
    }
    Ok(())
}
fn native_checkpoint(input: JournalInput) -> Result<Option<NativeCheckpoint>, DeviceSdkError> {
    if input.scope.is_empty() || input.scope.len() > 4096 {
        return Err(invalid("encrypted upload checkpoint namespace is invalid"));
    }
    let expected_recording = input.recording.uuid.parse::<RecordingUuid>()?;
    let expected_generation = input.recording.generation;
    let expected_length = input.recording.ciphertext_length;
    let expected = local_identity(&LocalIdentityInput {
        scope: input.scope.clone(),
        serial_number: input.serial_number.clone(),
        recording: input.recording,
    })?;
    let Some(journal) = input.journal else {
        return Ok(None);
    };
    if journal.version != 1 || journal.scope.is_empty() || journal.scope.len() > 4096 {
        return Err(invalid(
            "encrypted upload journal scope or version is invalid",
        ));
    }
    if journal.scope != input.scope {
        return Err(DeviceSdkError::new(
            ErrorCode::IdentityMismatch,
            Operation::TransferRecording,
            false,
        )
        .with_detail("encrypted upload checkpoint belongs to another persistence scope"));
    }
    let core = journal.checkpoint;
    let receiver = journal.receiver_checkpoint;
    DeviceSerialNumber::new(core.device.as_str())?;
    // The durable key and sink belong to the exact immutable recording, not an
    // attempt or transport session. Reject foreign metadata before opening it.
    if core.device.as_str() != input.serial_number
        || core.recording != expected_recording
        || core.recording_generation != expected_generation
        || core.next_ciphertext_offset > expected_length
        || journal.sink_registration_id != expected.sink_id
    {
        return Err(DeviceSdkError::new(
            ErrorCode::IdentityMismatch,
            Operation::TransferRecording,
            false,
        )
        .with_detail("encrypted checkpoint belongs to another device or recording"));
    }
    if core.checkpoint_revision != receiver.revision
        || core.next_ciphertext_offset != receiver.next_ciphertext_offset
        || core.prefix_sha256 != receiver.prefix_sha256
    {
        return Err(DeviceSdkError::new(
            ErrorCode::IntegrityFailed,
            Operation::TransferRecording,
            false,
        )
        .with_detail("receiver checkpoint does not match its durable core journal"));
    }
    let checkpoint = NativeCheckpoint {
        version: 1,
        upload_session_id: RecordingUuid::from_bytes(core.upload_session_uuid).to_string(),
        owner_revision: core.owner_revision,
        revision: core.checkpoint_revision,
        next_ciphertext_offset: core.next_ciphertext_offset,
        prefix_sha256: hex(&core.prefix_sha256),
        highest_contiguous_sequence: receiver.highest_contiguous_sequence,
        transport_session_id: core.transport_session_id,
        sink_registration_id: journal.sink_registration_id,
        window_packets: core.window_packets,
        data_payload_bytes: core.data_payload_bytes,
    };
    validate_native_checkpoint(&checkpoint)?;
    Ok(Some(checkpoint))
}
fn local_identity(input: &LocalIdentityInput) -> Result<LocalIdentity, DeviceSdkError> {
    if input.scope.is_empty()
        || input.scope.len() > 4096
        || input.recording.generation == 0
        || input.recording.ciphertext_length == 0
        || input
            .recording
            .storage_format
            .is_some_and(|format| format != wire::STORAGE_FORMAT_BOTA_ENC_V2)
    {
        return Err(invalid("encrypted local recording identity is invalid"));
    }
    let serial = DeviceSerialNumber::new(&input.serial_number)?;
    let uuid = input.recording.uuid.parse::<RecordingUuid>()?;
    let hash = hex(&unhex32(&input.recording.ciphertext_sha256)?);
    let canonical = serde_json::to_vec(&(
        input.scope.as_str(),
        serial.as_str(),
        uuid.to_string(),
        input.recording.generation,
        input.recording.ciphertext_length.to_string(),
        hash,
        input.recording.markers_required.unwrap_or(false),
    ))
    .map_err(|_| invalid("cannot encode recording identity"))?;
    let digest = hex(&Sha256::digest(canonical));
    Ok(LocalIdentity {
        journal_key: format!("v1/{digest}"),
        sink_id: format!("encrypted-v2/{digest}"),
    })
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex32(text: &str) -> Result<[u8; 32], DeviceSdkError> {
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(
            "encrypted upload SHA-256 must be exactly 32 hexadecimal bytes",
        ));
    }
    let mut bytes = [0; 32];
    for (byte, pair) in bytes.iter_mut().zip(text.as_bytes().as_chunks::<2>().0) {
        *byte = u8::from_str_radix(
            std::str::from_utf8(pair).map_err(|_| invalid("invalid digest encoding"))?,
            16,
        )
        .map_err(|_| invalid("invalid digest encoding"))?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{codecs::CodecState, json};
    fn call(name: &str, value: Value) -> Result<Value, DeviceSdkError> {
        CodecState::default()
            .execute(name, value)
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    fn capability() -> Vec<u8> {
        vec![
            1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0,
        ]
    }
    fn plan_input() -> Value {
        object!({"serialNumber":"C8SU2XXWHI","recording":{"uuid":"22222222-2222-2222-2222-222222222222","generation":9,"ciphertextLength":"330","ciphertextSha256":"33".repeat(32)},"capabilityBytes":capability(),"decision":{"profile":"encrypted_upload_v2","uploadSessionId":"11111111-1111-1111-1111-111111111111","ownerRevision":3,"securityPolicy":"v2_preferred","materialRegistrationId":"material"},"transportSessionId":"18446744073709551615","sinkId":"new-sink","maximumWriteBytes":244})
    }
    #[test]
    fn native_request_plan_uses_negotiated_frames_and_restores_exact_resume_metadata() {
        let input = plan_input();
        let request = call("planEncryptedUploadV2Request", input.clone()).unwrap();
        assert_eq!(request["transport_session_id"], "18446744073709551615");
        assert_eq!(request["data_payload_bytes"], 216);
        assert_eq!(request["window_packets"], 16);
        let mut resumed = input.clone();
        resumed["checkpoint"] = object!({"version":1,"uploadSessionId":"11111111-1111-1111-1111-111111111111","ownerRevision":3,"revision":2,"nextCiphertextOffset":"128","prefixSha256":"77".repeat(32),"highestContiguousSequence":1,"transportSessionId":"55","sinkRegistrationId":"saved-sink","windowPackets":8,"dataPayloadBytes":100});
        let request = call("planEncryptedUploadV2Request", resumed.clone()).unwrap();
        assert_eq!(request["transport_session_id"], "55");
        assert_eq!(request["sink_id"], "saved-sink");
        assert_eq!(request["window_packets"], 8);
        assert_eq!(request["data_payload_bytes"], 100);
        resumed["checkpoint"]["dataPayloadBytes"] = object!(217);
        assert!(call("planEncryptedUploadV2Request", resumed).is_err());
        let mut too_small = input.clone();
        too_small["maximumWriteBytes"] = object!(139);
        assert_eq!(
            call("planEncryptedUploadV2Request", too_small)
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedCapability
        );
        let mut unsafe_id = input;
        unsafe_id["transportSessionId"] = object!(u64::MAX);
        assert!(call("planEncryptedUploadV2Request", unsafe_id).is_err());
    }
    #[test]
    fn native_capability_and_checkpoint_are_validated_metadata_only() {
        let expected = object!({"scope":"account/project/device","serialNumber":"C8SU2XXWHI","recording":plan_input()["recording"]});
        let identity = call("encryptedUploadV2LocalIdentity", expected.clone()).unwrap();
        let capability = call(
            "nativeEncryptedUploadV2Capability",
            object!({"bytes":capability()}),
        )
        .unwrap();
        assert_eq!(capability["flags"], 383);
        assert!(capability["maximumDataPayloadBytes"].is_number());
        assert_eq!(
            capability["sha256Hex"],
            hex(&Sha256::digest(super::tests::capability()))
        );
        assert_eq!(
            call("nativeEncryptedUploadV2Checkpoint", {
                let mut input = expected.clone();
                input["journal"] = Value::Null;
                input
            })
            .unwrap(),
            Value::Null
        );
        let request = call("planEncryptedUploadV2Request", plan_input()).unwrap();
        let parsed: EncryptedUploadV2BatchRequest =
            json::decode(&serde_json::to_vec(&request).unwrap()).unwrap();
        let core = EncryptedUploadV2Checkpoint {
            device: parsed.device,
            recording: parsed.recording,
            recording_generation: parsed.recording_generation,
            upload_session_uuid: parsed.upload_session_uuid,
            owner_revision: parsed.owner_revision,
            transport_session_id: parsed.transport_session_id,
            checkpoint_revision: 2,
            next_ciphertext_offset: 128,
            prefix_sha256: [7; 32],
            window_packets: 8,
            data_payload_bytes: 100,
        };
        let core: Value = serde_json::from_slice(&json::encode(&core).unwrap()).unwrap();
        let mut journal = object!({"version":1,"scope":"account/project/device","checkpoint":core,"receiverCheckpoint":{"revision":2,"next_ciphertext_offset":"128","prefix_sha256":vec![7;32],"highest_contiguous_sequence":1},"sinkRegistrationId":identity["sinkId"]});
        let native = call("nativeEncryptedUploadV2Checkpoint", {
            let mut input = expected.clone();
            input["journal"] = journal.clone();
            input
        })
        .unwrap();
        assert_eq!(native["transportSessionId"], "18446744073709551615");
        assert_eq!(native["sinkRegistrationId"], identity["sinkId"]);
        assert_eq!(native["highestContiguousSequence"], 1);
        assert_eq!(
            call("nativeEncryptedUploadV2Checkpoint", {
                let mut input = expected.clone();
                input["journal"] = journal.clone();
                input["scope"] = object!("other-account");
                input
            })
            .unwrap_err()
            .code,
            ErrorCode::IdentityMismatch
        );
        journal["receiverCheckpoint"]["revision"] = object!(3);
        assert_eq!(
            call("nativeEncryptedUploadV2Checkpoint", {
                let mut input = expected.clone();
                input["journal"] = journal.clone();
                input
            })
            .unwrap_err()
            .code,
            ErrorCode::IntegrityFailed
        );
    }
    #[test]
    fn durable_local_identity_survives_new_attempts_and_fences_recording_or_scope_changes() {
        let input = object!({"scope":"account/project/device","serialNumber":"C8SU2XXWHI","recording":plan_input()["recording"]});
        let stable = call("encryptedUploadV2LocalIdentity", input.clone()).unwrap();
        assert_eq!(
            stable,
            call("encryptedUploadV2LocalIdentity", input.clone()).unwrap()
        );
        assert!(stable["sinkId"].as_str().unwrap().len() <= 128);
        for (field, replacement) in [
            ("generation", object!(10)),
            ("ciphertextSha256", object!("44".repeat(32))),
            ("ciphertextLength", object!("331")),
        ] {
            let mut other = input.clone();
            other["recording"][field] = replacement;
            assert_ne!(
                call("encryptedUploadV2LocalIdentity", other).unwrap(),
                stable
            );
        }
        let mut other = input;
        other["scope"] = object!("replacement/project/device");
        assert_ne!(
            call("encryptedUploadV2LocalIdentity", other).unwrap(),
            stable
        );
    }
    #[test]
    fn legacy_android_checkpoint_catalog_accepts_only_the_exact_empty_encoding() {
        let empty = vec![0x42, 0x56, 0x32, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0];
        let inspect = |bytes: Vec<u8>| {
            call(
                "isEmptyLegacyAndroidV2CheckpointCatalog",
                object!({"bytes":bytes}),
            )
            .unwrap()
        };
        assert_eq!(inspect(empty.clone()), object!(true));
        for length in 0..empty.len() {
            assert_eq!(inspect(empty[..length].to_vec()), object!(false));
        }
        for index in 0..empty.len() {
            let mut changed = empty.clone();
            changed[index] ^= 1;
            assert_eq!(inspect(changed), object!(false));
        }
        let mut trailing = empty;
        trailing.push(0);
        assert_eq!(inspect(trailing), object!(false));
        assert!(
            call(
                "isEmptyLegacyAndroidV2CheckpointCatalog",
                object!({"bytes":[256]})
            )
            .is_err()
        );
        assert!(
            call(
                "isEmptyLegacyAndroidV2CheckpointCatalog",
                object!({"bytes":[],"unknown":true})
            )
            .is_err()
        );
    }
    #[test]
    fn managed_reducer_keeps_safe_public_numbers_and_exact_business_errors() {
        let input = object!({"operationId":"operation","scope":{"apiOrigin":"https://api.example.test","accountId":"account","projectId":"project","organizationId":"","environment":"development","endUserId":"end-user","deviceId":"device","bindingGeneration":7,"serialNumber":"C8SU2XXWHI","nativeDeviceId":"native","scopeKey":"scope"},"recording":{"uuid":"22222222-2222-2222-2222-222222222222","generation":9,"ciphertextLength":"330","ciphertextSha256":"33".repeat(32),"startedAtMs":"0","durationMs":"1000","plaintextLength":"38","storageFormat":3},"capability":{"rawValueHex":hex(&capability()),"flags":383},"checkpoint":null,"priorJournalEntry":null,"journalKey":null});
        let request = object!({"input":input,"event":{"type":"Limits"}});
        let direct: ManagedUploadRequest = serde_json::from_value(request.clone()).unwrap();
        let direct = serde_json::to_value(direct.reduce().unwrap()).unwrap();
        assert_eq!(call("reduceManagedUpload", request).unwrap(), direct);
        assert!(direct["value"]["requestTimeoutMs"].is_number());
        let mut invalid_input = input;
        invalid_input["scope"]["bindingGeneration"] = object!(0);
        assert_eq!(
            call(
                "reduceManagedUpload",
                object!({"input":invalid_input,"event":{"type":"Limits"}})
            )
            .unwrap(),
            object!({"error":{"code":"BOTA_UPLOAD_INVALID_INPUT"}})
        );
        assert_eq!(
            call(
                "reduceManagedUpload",
                object!({"input":{},"event":{"type":"Staging","nowMs":"01"}})
            )
            .unwrap(),
            object!({"error":{"code":"BOTA_UPLOAD_INVALID_INPUT"}})
        );
    }
    #[test]
    fn marked_catalog_fallback_is_exact_and_bounded_to_one_retry() {
        let plan = call(
            "planEncryptedUploadV2Catalog",
            object!({"transportSessionId":"18446744073709551615","previousError":null}),
        )
        .unwrap();
        let bytes: Vec<u8> = serde_json::from_value(plan["command"].clone()).unwrap();
        assert!(matches!(
            bota_device_sdk_core::protocol::decode_encrypted_upload_v2_transfer(&bytes).unwrap(),
            EncryptedUploadV2Transfer::MarkedList(_)
        ));
        let plan=call("planEncryptedUploadV2Catalog",object!({"transportSessionId":"18446744073709551615","attempt":2,"previousError":{"code":"protocol_rejected","protocolStatus":3}})).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(plan["command"].clone()).unwrap();
        assert!(matches!(
            bota_device_sdk_core::protocol::decode_encrypted_upload_v2_transfer(&bytes).unwrap(),
            EncryptedUploadV2Transfer::List(_)
        ));
        assert_eq!(call("planEncryptedUploadV2Catalog",object!({"transportSessionId":"1","attempt":2,"previousError":{"code":"protocol_rejected","protocolStatus":4}})).unwrap_err().protocol_status,Some(4));
        assert!(call("planEncryptedUploadV2Catalog",object!({"transportSessionId":"1","attempt":3,"previousError":{"code":"protocol_rejected","protocolStatus":3}})).is_err());
    }
    #[test]
    fn pending_catalog_orders_v2_and_rejects_colliding_legacy_aliases() {
        let encrypted = plan_input()["recording"].clone();
        let legacy = |uuid: &str| object!({"uuid":uuid,"startedAtMs":0,"durationMs":1000,"fileSize":330,"codec":"opus_16k","isEncrypted":false});
        let alias = legacy("22222222-0000-0000-0000-000000000000");
        let unrelated = legacy("44444444-0000-0000-0000-000000000000");
        let pending = call(
            "mergePendingRecordings",
            object!({"legacy":[alias,unrelated],"encrypted":[encrypted]}),
        )
        .unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 2);
        assert_eq!(pending[0]["profile"], "encrypted_upload_v2");
        assert_eq!(pending[1]["profile"], "legacy");
        let mut collision = encrypted.clone();
        collision["uuid"] = object!("22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        assert_eq!(
            call(
                "mergePendingRecordings",
                object!({"legacy":[],"encrypted":[encrypted,collision]})
            )
            .unwrap_err()
            .code,
            ErrorCode::IntegrityFailed
        );
    }
}
