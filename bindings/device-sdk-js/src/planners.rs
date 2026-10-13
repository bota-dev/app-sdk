//! Rust-owned host framing and acceptance; cryptographic trust stays external.

use crate::{
    codecs::{input, output, public_output},
    engine::invalid,
    v2,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bota_device_sdk_core::{
    engine::{Command, EncryptedUploadV2HostEvent, HostEventKind},
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    model::{DeviceSerialNumber, FactoryResetCommandId, FactoryResetResult, UploadSecurityPolicy},
    protocol::*,
    workflow::{EncryptedUploadV2BatchRequest, EncryptedUploadV2Checkpoint},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json as object};
use sha2::{Digest, Sha256};

// Frozen CompletionReceiptV2 verified-publication result. BLOB_RESULT uses
// a separate status namespace whose success is zero.
const RECEIPT_VERIFIED_RESULT: u8 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Opening {
    request: EncryptedUploadV2BatchRequest,
    checkpoint: Option<EncryptedUploadV2Checkpoint>,
    #[serde(default)]
    authorization_sha256: Option<[u8; 32]>,
    #[serde(default)]
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedBlob {
    blob_kind: u8,
    write_id: u32,
    bytes: Vec<u8>,
    capacity: u16,
    maximum_blob_bytes: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedResult {
    blob_kind: u8,
    write_id: u32,
    bytes: Vec<u8>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedPlan {
    frames: Vec<Vec<u8>>,
    abort_frame: Vec<u8>,
    sha256: [u8; 32],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirm {
    request: EncryptedUploadV2BatchRequest,
    receipt_sha256: [u8; 32],
    #[serde(default)]
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestOnly {
    request: EncryptedUploadV2BatchRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authorization {
    request: EncryptedUploadV2BatchRequest,
    bytes: Vec<u8>,
    #[serde(default)]
    checkpoint: Option<EncryptedUploadV2Checkpoint>,
    #[serde(default)]
    markers_required: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkerFileRecovery {
    bytes: Vec<u8>,
    existing_bytes: Vec<u8>,
    durable_length: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    request: EncryptedUploadV2BatchRequest,
    bytes: Vec<u8>,
    markers_required: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdmittedDocument {
    blob_kind: u8,
    markers_required: bool,
    sha256: [u8; 32],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    attempt_id: u32,
    expected_state: u8,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetGrant {
    grant_blob: String,
    binding_generation: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetJournal {
    serial_number: String,
    command_id: String,
    binding_generation: u64,
    result: FactoryResetResult,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetJournalInput {
    journal: Option<ResetJournal>,
    serial_number: String,
    current_binding_generation: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayChunk {
    ephemeral_public_key: [u8; 32],
    salt: [u8; 4],
    sequence: u16,
    ciphertext: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptedUnits {
    encrypted: bool,
    ciphertext_length: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadPolicy {
    encrypted: bool,
    sequence: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Failure {
    code: String,
    protocol_status: Option<u16>,
    detail: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartupPolicy {
    command: Command,
}

pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "planEncryptedUploadV2Opening"
            | "acceptEncryptedUploadV2Opening"
            | "planEncryptedUploadV2SignedBlob"
            | "acceptEncryptedUploadV2SignedBlobResult"
            | "planEncryptedUploadV2Confirm"
            | "acceptEncryptedUploadV2Confirm"
            | "planEncryptedUploadV2Abort"
            | "initialEncryptedUploadV2ReceiverCheckpoint"
            | "validateEncryptedUploadV2Authorization"
            | "validateEncryptedUploadV2Receipt"
            | "acceptUploadContextSnapshot"
            | "validateFactoryResetGrant"
            | "validateFactoryResetJournal"
            | "encodeStreamingRelayChunk"
            | "streamingAcceptedUnits"
            | "streamingUploadPolicy"
            | "encryptedUploadV2Failure"
            | "subscriptionStartupPolicy"
            | "planEncryptedUploadV2MarkerFileRecovery"
    )
}
#[inline(never)]
pub(crate) fn execute(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "planEncryptedUploadV2Opening" => output(&plan_opening(input(value)?)?),
        "acceptEncryptedUploadV2Opening" => output(&accept_opening(input(value)?)?),
        "planEncryptedUploadV2SignedBlob" => output(&plan_blob(input(value)?)?),
        "acceptEncryptedUploadV2SignedBlobResult" => output(&accept_blob(input(value)?)?),
        "planEncryptedUploadV2Confirm" => output(&plan_confirm(input(value)?)?),
        "acceptEncryptedUploadV2Confirm" => output(&accept_confirm(input(value)?)?),
        "planEncryptedUploadV2Abort" => {
            let request: RequestOnly = input(value)?;
            v2::validate_request(&request.request)?;
            output(&encode_encrypted_upload_v2_transfer(
                &EncryptedUploadV2Transfer::Abort {
                    common: common(&request.request, wire::ENCRYPTED_UPLOAD_V2_ABORT),
                    reason: wire::ENCRYPTED_UPLOAD_V2_RESULT_INTERNAL,
                },
            )?)
        }
        "initialEncryptedUploadV2ReceiverCheckpoint" => {
            let _: Empty = input(value)?;
            output(&EncryptedUploadV2ReceiverCheckpoint::initial())
        }
        "validateEncryptedUploadV2Authorization" => output(&admit_authorization(input(value)?)?),
        "planEncryptedUploadV2MarkerFileRecovery" => {
            let recovery: MarkerFileRecovery = input(value)?;
            if recovery.bytes.is_empty() || recovery.bytes.len() > 65536 {
                return Err(invalid("marker document exceeds bounded file recovery"));
            }
            if recovery.durable_length != recovery.existing_bytes.len() as u64
                || !recovery.bytes.starts_with(&recovery.existing_bytes)
            {
                return Err(error(
                    ErrorCode::IntegrityFailed,
                    "retained marker document does not match the selected document",
                ));
            }
            let complete = recovery.existing_bytes.len() == recovery.bytes.len();
            public_output(
                object!({"write":!complete,"truncate":!complete && !recovery.existing_bytes.is_empty()}),
            )
        }
        "validateEncryptedUploadV2Receipt" => output(&admit_receipt(input(value)?)?),
        "acceptUploadContextSnapshot" => output(&accept_context(input(value)?)?),
        "validateFactoryResetGrant" => output(&reset_grant(input(value)?)?),
        "validateFactoryResetJournal" => output(&reset_journal(input(value)?)?),
        "encodeStreamingRelayChunk" => output(&relay_chunk(input(value)?)?),
        "streamingAcceptedUnits" => {
            let request: AcceptedUnits = input(value)?;
            let units = if request.encrypted {
                request
                    .ciphertext_length
                    .checked_sub(wire::E2E_TAG_LENGTH as u64)
                    .ok_or_else(|| {
                        invalid("encrypted streaming chunk is shorter than its authentication tag")
                    })?
            } else {
                request.ciphertext_length
            };
            output(&units)
        }
        "streamingUploadPolicy" => {
            let request: UploadPolicy = input(value)?;
            public_output(
                object!({"attempts":3,"retryDelaysMs":[50,100],"allowGap":request.encrypted&&request.sequence>0}),
            )
        }
        "encryptedUploadV2Failure" => output(&failure_event(input(value)?)?),
        "subscriptionStartupPolicy" => {
            let request: StartupPolicy = input(value)?;
            crate::engine::validate_command(&request.command)?;
            public_output(
                object!({"replayBeforeSubscribed":matches!(request.command,Command::ResumeFactoryReset{..})}),
            )
        }
        _ => Err(invalid("unknown host planning helper")),
    }
}

fn error(code: ErrorCode, detail: &str) -> DeviceSdkError {
    DeviceSdkError::new(code, Operation::TransferRecording, false).with_detail(detail)
}
fn identity(valid: bool, detail: &str) -> Result<(), DeviceSdkError> {
    if valid {
        Ok(())
    } else {
        Err(error(ErrorCode::IdentityMismatch, detail))
    }
}
fn protocol_rejected(status: u16) -> DeviceSdkError {
    error(
        ErrorCode::ProtocolRejected,
        "device rejected the exact encrypted upload request",
    )
    .with_protocol_status(status)
}
fn common(request: &EncryptedUploadV2BatchRequest, message_type: u8) -> CommonHeaderV2 {
    CommonHeaderV2 {
        message_type,
        flags: 0,
        transport_session_id: request.transport_session_id,
    }
}
fn checkpoint(input: &Opening) -> Result<EncryptedUploadV2ReceiverCheckpoint, DeviceSdkError> {
    v2::validate_request(&input.request)?;
    match &input.checkpoint {
        None => Ok(EncryptedUploadV2ReceiverCheckpoint::initial()),
        Some(checkpoint) => {
            let check = v2::normalize_checkpoint(v2::CheckpointInput {
                request: input.request.clone(),
                checkpoint: Some(checkpoint.clone()),
            })?;
            if check.is_none() {
                return Err(error(
                    ErrorCode::IdentityMismatch,
                    "opening checkpoint is not owned by the selected request",
                ));
            }
            Ok(EncryptedUploadV2ReceiverCheckpoint {
                revision: checkpoint.checkpoint_revision,
                next_ciphertext_offset: checkpoint.next_ciphertext_offset,
                prefix_sha256: checkpoint.prefix_sha256,
                highest_contiguous_sequence: None,
            })
        }
    }
}
fn plan_opening(input: Opening) -> Result<Vec<u8>, DeviceSdkError> {
    let checkpoint = checkpoint(&input)?;
    let request = &input.request;
    let frame = if input.checkpoint.is_some() {
        EncryptedUploadV2Transfer::ResumeRequest(ResumeV2 {
            common: common(request, wire::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST),
            upload_session_uuid: request.upload_session_uuid,
            recording_uuid: *request.recording.as_bytes(),
            recording_generation: request.recording_generation,
            checkpoint_revision: checkpoint.revision,
            next_ciphertext_offset: checkpoint.next_ciphertext_offset,
            prefix_sha256: checkpoint.prefix_sha256,
            window_packets: request.window_packets,
            data_payload_bytes: request.data_payload_bytes,
        })
    } else {
        EncryptedUploadV2Transfer::Start(StartV2 {
            common: common(request, wire::ENCRYPTED_UPLOAD_V2_START),
            upload_session_uuid: request.upload_session_uuid,
            recording_uuid: *request.recording.as_bytes(),
            recording_generation: request.recording_generation,
            authorization_sha256: input
                .authorization_sha256
                .ok_or_else(|| invalid("opening requires the prepared authorization digest"))?,
            checkpoint_revision: checkpoint.revision,
            next_ciphertext_offset: checkpoint.next_ciphertext_offset,
            prefix_sha256: checkpoint.prefix_sha256,
            window_packets: request.window_packets,
            data_payload_bytes: request.data_payload_bytes,
        })
    };
    encode_encrypted_upload_v2_transfer(&frame)
}
fn accept_opening(input: Opening) -> Result<Option<&'static str>, DeviceSdkError> {
    let checkpoint = checkpoint(&input)?;
    let request = &input.request;
    match decode_encrypted_upload_v2_transfer(&input.bytes)? {
        EncryptedUploadV2Transfer::StartAck(ack) => {
            if input.checkpoint.is_some() {
                return Err(error(
                    ErrorCode::UnexpectedEvent,
                    "RESUME received a START acknowledgement",
                ));
            }
            identity(
                ack.common.transport_session_id == request.transport_session_id
                    && ack.upload_session_uuid == request.upload_session_uuid
                    && ack.recording_uuid == *request.recording.as_bytes()
                    && ack.recording_generation == request.recording_generation
                    && ack.ciphertext_length == request.ciphertext_length
                    && ack.ciphertext_sha256 == request.ciphertext_sha256
                    && ack.window_packets == request.window_packets
                    && ack.data_payload_bytes == request.data_payload_bytes
                    && ack.checkpoint_interval_blocks
                        == request.capabilities.durable_checkpoint_interval_blocks
                    && ack.checkpoint_revision == checkpoint.revision
                    && ack.next_ciphertext_offset == checkpoint.next_ciphertext_offset
                    && ack.prefix_sha256 == checkpoint.prefix_sha256,
                "START acknowledgement identity does not match the selected transfer",
            )?;
            Ok(Some("opened"))
        }
        EncryptedUploadV2Transfer::ResumeAccept(ack) => {
            if input.checkpoint.is_none() {
                return Err(error(
                    ErrorCode::UnexpectedEvent,
                    "START received a RESUME acknowledgement",
                ));
            }
            identity(
                ack.common.transport_session_id == request.transport_session_id
                    && ack.upload_session_uuid == request.upload_session_uuid
                    && ack.recording_uuid == *request.recording.as_bytes()
                    && ack.recording_generation == request.recording_generation
                    && ack.checkpoint_revision == checkpoint.revision
                    && ack.next_ciphertext_offset == checkpoint.next_ciphertext_offset
                    && ack.prefix_sha256 == checkpoint.prefix_sha256
                    && ack.window_packets == request.window_packets
                    && ack.data_payload_bytes == request.data_payload_bytes,
                "RESUME acknowledgement does not match the durable checkpoint",
            )?;
            Ok(Some("opened"))
        }
        EncryptedUploadV2Transfer::ResumeReject(reject) => {
            identity(
                reject.common.transport_session_id == request.transport_session_id,
                "RESUME rejection belongs to another transport session",
            )?;
            identity(
                input.checkpoint.is_some()
                    && reject.reason == wire::ENCRYPTED_UPLOAD_V2_RESULT_CHECKPOINT_MISMATCH
                    && reject.checkpoint_revision < checkpoint.revision
                    && reject.next_ciphertext_offset < checkpoint.next_ciphertext_offset
                    && ((reject.next_ciphertext_offset == 0) == (reject.checkpoint_revision == 0)),
                "RESUME rejection cannot reconcile the durable checkpoint",
            )?;
            Ok(Some("resume_rejected"))
        }
        EncryptedUploadV2Transfer::Error {
            common,
            result,
            failed_message_type,
            ..
        } => {
            identity(
                common.transport_session_id == request.transport_session_id,
                "opening ERROR belongs to another transport session",
            )?;
            let expected = if input.checkpoint.is_some() {
                wire::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST
            } else {
                wire::ENCRYPTED_UPLOAD_V2_START
            };
            if result == 0 || failed_message_type != expected {
                return Err(error(
                    ErrorCode::UnexpectedEvent,
                    "opening ERROR does not match the active request",
                ));
            }
            Err(protocol_rejected(result))
        }
        _ => Ok(None),
    }
}
fn plan_blob(input: SignedBlob) -> Result<SignedPlan, DeviceSdkError> {
    if input.write_id == 0
        || input.bytes.is_empty()
        || input.bytes.len() > usize::from(input.maximum_blob_bytes)
        || input.capacity < 64
    {
        return Err(invalid("signed document is outside the negotiated bounds"));
    }
    let capacity = usize::from(input.capacity).min(wire::MAX_MTU);
    let sha256 = Sha256::digest(&input.bytes).into();
    let total_length = u16::try_from(input.bytes.len())
        .map_err(|_| invalid("signed document exceeds its wire length"))?;
    let mut frames = vec![encode_encrypted_upload_v2_signed_blob(
        &EncryptedUploadV2SignedBlob::Begin {
            kind: input.blob_kind,
            write_id: input.write_id,
            total_length,
            sha256,
        },
    )?];
    let chunk_capacity = capacity
        .checked_sub(wire::ENCRYPTED_UPLOAD_V2_BLOB_DATA_MINIMUM_LENGTH)
        .ok_or_else(|| invalid("write cannot carry signed document data"))?;
    for (index, chunk) in input.bytes.chunks(chunk_capacity).enumerate() {
        let offset = u16::try_from(index * chunk_capacity)
            .map_err(|_| invalid("signed document offset exceeds its wire range"))?;
        frames.push(encode_encrypted_upload_v2_signed_blob(
            &EncryptedUploadV2SignedBlob::Data {
                kind: input.blob_kind,
                write_id: input.write_id,
                offset,
                data: chunk,
            },
        )?);
    }
    frames.push(encode_encrypted_upload_v2_signed_blob(
        &EncryptedUploadV2SignedBlob::Commit {
            kind: input.blob_kind,
            write_id: input.write_id,
        },
    )?);
    if frames.iter().any(|frame| frame.len() > capacity) {
        return Err(invalid(
            "signed document frame exceeds its negotiated write capacity",
        ));
    }
    let abort_frame =
        encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Abort {
            kind: input.blob_kind,
            write_id: input.write_id,
        })?;
    Ok(SignedPlan {
        frames,
        abort_frame,
        sha256,
    })
}
fn accept_blob(input: SignedResult) -> Result<Option<&'static str>, DeviceSdkError> {
    if input.write_id == 0 {
        return Err(invalid("signed document write ID must be nonzero"));
    }
    encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Abort {
        kind: input.blob_kind,
        write_id: input.write_id,
    })?;
    let EncryptedUploadV2SignedBlob::Result {
        kind,
        write_id,
        result,
    } = decode_encrypted_upload_v2_signed_blob(&input.bytes)?
    else {
        return Err(error(
            ErrorCode::UnexpectedEvent,
            "signed document received a non-result frame",
        ));
    };
    if kind != input.blob_kind || write_id != input.write_id {
        return Ok(None);
    }
    if result != wire::ENCRYPTED_UPLOAD_V2_RESULT_SUCCESS {
        return Err(protocol_rejected(result));
    }
    Ok(Some("accepted"))
}
fn plan_confirm(input: Confirm) -> Result<Vec<u8>, DeviceSdkError> {
    v2::validate_request(&input.request)?;
    let request = &input.request;
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Confirm(ConfirmV2 {
        common: common(request, wire::ENCRYPTED_UPLOAD_V2_CONFIRM),
        upload_session_uuid: request.upload_session_uuid,
        recording_uuid: *request.recording.as_bytes(),
        recording_generation: request.recording_generation,
        owner_revision: request.owner_revision,
        receipt_sha256: input.receipt_sha256,
    }))
}
fn accept_confirm(input: Confirm) -> Result<Option<&'static str>, DeviceSdkError> {
    v2::validate_request(&input.request)?;
    // There is no CONFIRM_ACK. Exact successful GATT write and subscription
    // cleanup settle CONFIRM in the existing host; no received frame proves it.
    if let EncryptedUploadV2Transfer::Error {
        common,
        result,
        failed_message_type,
        ..
    } = decode_encrypted_upload_v2_transfer(&input.bytes)?
    {
        identity(
            common.transport_session_id == input.request.transport_session_id,
            "CONFIRM ERROR belongs to another transport session",
        )?;
        if failed_message_type == wire::ENCRYPTED_UPLOAD_V2_CONFIRM && result != 0 {
            return Err(protocol_rejected(result));
        }
        return Err(error(
            ErrorCode::UnexpectedEvent,
            "CONFIRM ERROR does not match the active request",
        ));
    }
    Ok(None)
}
fn signed_length(kind: u8, bytes: &[u8], maximum: u16) -> Result<(), DeviceSdkError> {
    if bytes.is_empty() || bytes.len() > usize::from(maximum) {
        return Err(invalid("signed document exceeds its negotiated bound"));
    }
    let total_length = u16::try_from(bytes.len())
        .map_err(|_| invalid("signed document exceeds its wire length"))?;
    // The shared codec, including its marked profile lengths, is authoritative.
    encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Begin {
        kind,
        write_id: 1,
        total_length,
        sha256: Sha256::digest(bytes).into(),
    })
    .map(|_| ())
}
fn admit_authorization(input: Authorization) -> Result<AdmittedDocument, DeviceSdkError> {
    let request = &input.request;
    v2::validate_request(request)?;
    let markers_required = input.bytes.len() != wire::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH;
    let blob_kind = if markers_required {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_MARKED_AUTHORIZATION
    } else {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION
    };
    signed_length(
        blob_kind,
        &input.bytes,
        request.capabilities.maximum_signed_blob_bytes,
    )?;
    let ordinary = &input.bytes[..wire::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH];
    let auth = decode_encrypted_upload_v2_authorization_identity(ordinary)?;
    let replacement = auth.flags & 8 != 0;
    validate_encrypted_upload_v2_capabilities_admission(request.capabilities, replacement)?;
    if let Some(expected) = input.markers_required {
        identity(
            expected == markers_required,
            "authorization marker profile does not match the recording",
        )?;
    }
    if let Some(checkpoint) = &input.checkpoint {
        identity(
            checkpoint.device == request.device
                && checkpoint.recording == request.recording
                && checkpoint.recording_generation == request.recording_generation,
            "retained checkpoint belongs to a different recording",
        )?;
        if checkpoint.upload_session_uuid != request.upload_session_uuid
            || checkpoint.owner_revision != request.owner_revision
        {
            identity(
                replacement
                    && request.owner_revision > checkpoint.owner_revision
                    && request.upload_session_uuid != checkpoint.upload_session_uuid,
                "replacement authorization does not advance the retained owner",
            )?;
        }
    }
    let policy = match request.selection.policy {
        UploadSecurityPolicy::LegacyAllowed => 0,
        UploadSecurityPolicy::V2Preferred => 1,
        UploadSecurityPolicy::V2Required => 2,
    };
    identity(
        request.owner_revision <= i32::MAX as u32
            && auth.owner_revision == request.owner_revision
            && auth.profile == wire::UPLOAD_PROFILE_ENCRYPTED_UPLOAD_V2
            && auth.storage_format == request.storage_format
            && auth.policy == policy
            && auth.channels & 1 != 0
            && auth.flags & !0x0f == 0
            && auth.flags & 1 != 0
            && auth.upload_session_uuid == request.upload_session_uuid
            && auth.recording_uuid == *request.recording.as_bytes()
            && auth.recording_generation == request.recording_generation
            && auth.minimum_ciphertext_length == request.ciphertext_length
            && auth.maximum_ciphertext_length == request.ciphertext_length
            && auth.ciphertext_sha256 == request.ciphertext_sha256,
        "authorization does not match the selected encrypted recording",
    )?;
    if markers_required {
        let marker =
            &input.bytes[input.bytes.len() - wire::RECORDING_MARKER_AUTHORIZATION_LENGTH..];
        let header = decode_marker_document_header(
            marker,
            wire::RECORDING_MARKER_AUTHORIZATION_LENGTH as u32,
        )?;
        identity(
            header.kind == wire::RECORDING_MARKER_AUTHORIZATION,
            "marked admission has no marker authorization",
        )?;
    }
    Ok(AdmittedDocument {
        blob_kind,
        markers_required,
        sha256: Sha256::digest(ordinary).into(),
    })
}
fn admit_receipt(input: Receipt) -> Result<AdmittedDocument, DeviceSdkError> {
    let request = &input.request;
    v2::validate_request(request)?;
    let blob_kind = if input.markers_required {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_MARKED_RECEIPT
    } else {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_RECEIPT
    };
    signed_length(
        blob_kind,
        &input.bytes,
        request.capabilities.maximum_signed_blob_bytes,
    )?;
    let ordinary = &input.bytes[..wire::COMPLETION_RECEIPT_V2_FIXED_LENGTH];
    if &ordinary[wire::COMPLETION_RECEIPT_V2_MAGIC_OFFSET
        ..wire::COMPLETION_RECEIPT_V2_MAGIC_OFFSET + wire::COMPLETION_RECEIPT_V2_MAGIC_WIDTH]
        != wire::COMPLETION_RECEIPT_V2_MAGIC
        || read_u16(ordinary, wire::COMPLETION_RECEIPT_V2_VERSION_OFFSET)
            != u16::from(wire::ENCRYPTED_UPLOAD_V2_DOCUMENT_VERSION)
        || usize::from(read_u16(
            ordinary,
            wire::COMPLETION_RECEIPT_V2_TOTAL_LENGTH_OFFSET,
        )) != wire::COMPLETION_RECEIPT_V2_FIXED_LENGTH
    {
        return Err(invalid("completion receipt shape is invalid"));
    }
    identity(
        ordinary[wire::COMPLETION_RECEIPT_V2_RESULT_OFFSET] == RECEIPT_VERIFIED_RESULT
            && ordinary[wire::COMPLETION_RECEIPT_V2_TRANSPORT_PROFILE_OFFSET]
                == wire::UPLOAD_PROFILE_ENCRYPTED_UPLOAD_V2
            && ordinary[wire::COMPLETION_RECEIPT_V2_STORAGE_FORMAT_OFFSET]
                == request.storage_format
            && read_u32(
                ordinary,
                wire::COMPLETION_RECEIPT_V2_UPLOAD_OWNER_REVISION_OFFSET,
            ) == request.owner_revision
            && read_u32(
                ordinary,
                wire::COMPLETION_RECEIPT_V2_RECORDING_GENERATION_OFFSET,
            ) == request.recording_generation
            && ordinary[wire::COMPLETION_RECEIPT_V2_UPLOAD_SESSION_UUID_OFFSET
                ..wire::COMPLETION_RECEIPT_V2_UPLOAD_SESSION_UUID_OFFSET + 16]
                == request.upload_session_uuid
            && ordinary[wire::COMPLETION_RECEIPT_V2_RECORDING_UUID_OFFSET
                ..wire::COMPLETION_RECEIPT_V2_RECORDING_UUID_OFFSET + 16]
                == *request.recording.as_bytes()
            && ordinary[wire::COMPLETION_RECEIPT_V2_CIPHERTEXT_SHA256_OFFSET
                ..wire::COMPLETION_RECEIPT_V2_CIPHERTEXT_SHA256_OFFSET + 32]
                == request.ciphertext_sha256,
        "completion receipt identity does not match the selected recording",
    )?;
    if input.markers_required {
        let marker = &input.bytes[wire::COMPLETION_RECEIPT_V2_FIXED_LENGTH..];
        let header =
            decode_marker_document_header(marker, wire::RECORDING_MARKER_COMPLETION_LENGTH as u32)?;
        identity(
            header.kind == wire::RECORDING_MARKER_COMPLETION,
            "marked receipt has no logical completion document",
        )?;
    }
    Ok(AdmittedDocument {
        blob_kind,
        markers_required: input.markers_required,
        sha256: Sha256::digest(ordinary).into(),
    })
}
fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}
fn accept_context(input: Context) -> Result<Option<Vec<u8>>, DeviceSdkError> {
    if input.attempt_id == 0 || !(1..=3).contains(&input.expected_state) {
        return Err(invalid("context attempt or expected state is invalid"));
    }
    let snapshot = decode_upload_context_snapshot(&input.bytes)?;
    if snapshot.attempt_id != input.attempt_id {
        return Ok(None);
    }
    if snapshot.state == 4 {
        return Err(protocol_rejected(snapshot.result));
    }
    if snapshot.state == input.expected_state {
        return Ok(Some(snapshot.payload.to_vec()));
    }
    if snapshot.state > input.expected_state {
        return Err(error(
            ErrorCode::UnexpectedEvent,
            "upload context advanced past the expected state",
        ));
    }
    Ok(None)
}
fn reset_grant(input: ResetGrant) -> Result<Vec<u8>, DeviceSdkError> {
    let generation = u32::try_from(input.binding_generation)
        .map_err(|_| invalid("reset binding generation exceeds its wire range"))?;
    if generation == 0 || input.grant_blob.len() != wire::FACTORY_RESET_GRANT_LENGTH.div_ceil(3) * 4
    {
        return Err(invalid(
            "reset grant must have the dedicated envelope shape",
        ));
    }
    let grant = STANDARD
        .decode(&input.grant_blob)
        .map_err(|_| invalid("reset grant must use canonical base64"))?;
    if grant.len() != wire::FACTORY_RESET_GRANT_LENGTH
        || STANDARD.encode(&grant) != input.grant_blob
    {
        return Err(invalid(
            "reset grant must have the dedicated canonical envelope",
        ));
    }
    let declared = u32::from_be_bytes([grant[0], grant[1], grant[2], grant[3]]);
    if declared != generation {
        return Err(DeviceSdkError::new(
            ErrorCode::IdentityMismatch,
            Operation::FactoryReset,
            false,
        )
        .with_detail("reset grant binding generation does not match"));
    }
    Ok(grant)
}
fn relay_chunk(input: RelayChunk) -> Result<Vec<u8>, DeviceSdkError> {
    if input.ciphertext.len() < wire::E2E_TAG_LENGTH || input.ciphertext.len() > 64 * 1024 {
        return Err(invalid(
            "encrypted streaming chunk exceeds its bounded relay format",
        ));
    }
    if input.sequence == 0 {
        let mut bytes = Vec::with_capacity(
            wire::E2E_EPHEMERAL_PUBLIC_KEY_LENGTH + wire::E2E_SALT_LENGTH + input.ciphertext.len(),
        );
        bytes.extend_from_slice(&input.ephemeral_public_key);
        bytes.extend_from_slice(&input.salt);
        bytes.extend_from_slice(&input.ciphertext);
        Ok(bytes)
    } else {
        Ok(input.ciphertext)
    }
}
fn reset_journal(input: ResetJournalInput) -> Result<Option<ResetJournal>, DeviceSdkError> {
    DeviceSerialNumber::new(&input.serial_number)?;
    if input.current_binding_generation == 0
        || input.current_binding_generation > u64::from(u32::MAX)
    {
        return Err(
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::FactoryReset, false)
                .with_detail("reset binding generation exceeds its nonzero wire range"),
        );
    }
    let Some(journal) = input.journal else {
        return Ok(None);
    };
    DeviceSerialNumber::new(&journal.serial_number)?;
    FactoryResetCommandId::new(&journal.command_id)?;
    if journal.serial_number != input.serial_number
        || journal.binding_generation != input.current_binding_generation
    {
        return Err(DeviceSdkError::new(
            ErrorCode::IdentityMismatch,
            Operation::FactoryReset,
            false,
        )
        .with_detail("pending reset journal belongs to another device or binding generation"));
    }
    if journal.result.result_code != wire::PROVISIONING_SUCCESS {
        return Err(DeviceSdkError::new(
            ErrorCode::PersistenceFailed,
            Operation::FactoryReset,
            false,
        )
        .with_detail("pending reset journal has no successful durable device result"));
    }
    Ok(Some(journal))
}
fn failure_event(input: Failure) -> Result<HostEventKind, DeviceSdkError> {
    let code = match input.code.as_str() {
        "invalid_input" => ErrorCode::InvalidInput,
        "truncated_packet" => ErrorCode::TruncatedPacket,
        "unknown_packet" => ErrorCode::UnknownPacket,
        "payload_too_large" => ErrorCode::PayloadTooLarge,
        "unsupported_capability" => ErrorCode::UnsupportedCapability,
        "unsupported_operation" => ErrorCode::UnsupportedOperation,
        "feature_unavailable" => ErrorCode::FeatureUnavailable,
        "operation_in_progress" => ErrorCode::OperationInProgress,
        "unexpected_event" => ErrorCode::UnexpectedEvent,
        "device_not_found" => ErrorCode::DeviceNotFound,
        "identity_mismatch" => ErrorCode::IdentityMismatch,
        "connection_failed" => ErrorCode::ConnectionFailed,
        "persistence_failed" => ErrorCode::PersistenceFailed,
        "not_connected" => ErrorCode::NotConnected,
        "timeout" => ErrorCode::Timeout,
        "cancelled" | "operation_cancelled" => ErrorCode::Cancelled,
        "protocol_rejected" => ErrorCode::ProtocolRejected,
        "integrity_failed" => ErrorCode::IntegrityFailed,
        "upload_ownership_unknown" => ErrorCode::UploadOwnershipUnknown,
        "download_failed" => ErrorCode::DownloadFailed,
        _ => ErrorCode::Internal,
    };
    let retryable = matches!(
        code,
        ErrorCode::ConnectionFailed
            | ErrorCode::NotConnected
            | ErrorCode::PersistenceFailed
            | ErrorCode::Timeout
            | ErrorCode::DownloadFailed
    );
    let mut error = DeviceSdkError::new(code, Operation::TransferRecording, retryable);
    error.protocol_status = input.protocol_status;
    if input
        .detail
        .as_ref()
        .is_some_and(|detail| detail.len() > 512)
    {
        return Err(invalid("encrypted upload failure detail is too long"));
    }
    error.detail = input.detail;
    Ok(HostEventKind::EncryptedUploadV2(
        EncryptedUploadV2HostEvent::Failed { error },
    ))
}

#[cfg(test)]
mod tests {
    use crate::{codecs::CodecState, json};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use bota_device_sdk_core::{error::ErrorCode, workflow::EncryptedUploadV2Checkpoint};
    use bota_device_sdk_core::{
        generated::protocol as wire,
        model::{
            DeviceSerialNumber, HostMaterialId, RecordingSinkId, RecordingUploadProfile,
            RecordingUuid, UploadProfileSelection, UploadSecurityPolicy,
        },
        protocol::*,
        workflow::EncryptedUploadV2BatchRequest,
    };
    use serde_json::{Value, json as object};
    use sha2::{Digest, Sha256};

    fn request() -> EncryptedUploadV2BatchRequest {
        EncryptedUploadV2BatchRequest {
            device: DeviceSerialNumber::new("C8SU2XXWHI").unwrap(),
            recording: RecordingUuid::from_bytes([0x22; 16]),
            recording_generation: 9,
            storage_format: wire::STORAGE_FORMAT_BOTA_ENC_V2,
            upload_session_uuid: [0x11; 16],
            owner_revision: 3,
            transport_session_id: u64::MAX,
            material_id: HostMaterialId::new("material").unwrap(),
            sink_id: RecordingSinkId::new("sink").unwrap(),
            selection: UploadProfileSelection {
                policy: UploadSecurityPolicy::V2Preferred,
                profile: RecordingUploadProfile::EncryptedUploadV2,
            },
            capabilities: decode_encrypted_upload_v2_capabilities(&[
                1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0,
            ])
            .unwrap(),
            window_packets: 16,
            data_payload_bytes: 244,
            ciphertext_length: 330,
            ciphertext_sha256: [0x33; 32],
        }
    }
    fn value<T: serde::Serialize>(input: &T) -> Value {
        serde_json::from_slice(&json::encode(input).unwrap()).unwrap()
    }
    fn call(
        name: &str,
        input: Value,
    ) -> Result<Value, bota_device_sdk_core::error::DeviceSdkError> {
        CodecState::default()
            .execute(name, input)
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    #[test]
    fn opening_plan_and_admission_require_exact_identity() {
        let request = request();
        let input =
            object!({"request":value(&request),"checkpoint":null,"authorizationSha256":vec![7;32]});
        let bytes: Vec<u8> =
            serde_json::from_value(call("planEncryptedUploadV2Opening", input).unwrap()).unwrap();
        let EncryptedUploadV2Transfer::Start(start) =
            decode_encrypted_upload_v2_transfer(&bytes).unwrap()
        else {
            panic!()
        };
        assert_eq!(start.common.transport_session_id, u64::MAX);
        assert_eq!(start.prefix_sha256, Sha256::digest([]).as_slice());
        let mut ack = StartAckV2 {
            common: CommonHeaderV2 {
                message_type: wire::ENCRYPTED_UPLOAD_V2_START_ACK,
                flags: 0,
                transport_session_id: request.transport_session_id,
            },
            upload_session_uuid: request.upload_session_uuid,
            recording_uuid: *request.recording.as_bytes(),
            recording_generation: request.recording_generation,
            ciphertext_length: request.ciphertext_length,
            ciphertext_sha256: request.ciphertext_sha256,
            window_packets: request.window_packets,
            data_payload_bytes: request.data_payload_bytes,
            checkpoint_interval_blocks: request.capabilities.durable_checkpoint_interval_blocks,
            checkpoint_revision: 0,
            next_ciphertext_offset: 0,
            prefix_sha256: Sha256::digest([]).into(),
        };
        let bytes =
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::StartAck(ack)).unwrap();
        assert_eq!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":null,"bytes":bytes})
            )
            .unwrap(),
            "opened"
        );
        ack.recording_generation += 1;
        let bytes =
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::StartAck(ack)).unwrap();
        assert!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":null,"bytes":bytes})
            )
            .is_err()
        );
    }
    #[test]
    fn signed_blob_plan_reassembles_and_rejects_wrong_result_owner() {
        let bytes = vec![9; wire::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH];
        let plan=call("planEncryptedUploadV2SignedBlob",object!({"blobKind":wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION,"writeId":7,"bytes":bytes,"capacity":64,"maximumBlobBytes":1024})).unwrap();
        let frames: Vec<Vec<u8>> = serde_json::from_value(plan["frames"].clone()).unwrap();
        assert!(frames.iter().all(|frame| frame.len() <= 64));
        let first = decode_encrypted_upload_v2_signed_blob(&frames[0]).unwrap();
        let mut assembler = SignedBlobAssemblerV2::from_begin(&first).unwrap();
        for frame in &frames[1..frames.len() - 1] {
            assembler
                .push(&decode_encrypted_upload_v2_signed_blob(frame).unwrap())
                .unwrap();
        }
        assert_eq!(
            assembler
                .finish(&decode_encrypted_upload_v2_signed_blob(frames.last().unwrap()).unwrap())
                .unwrap(),
            bytes
        );
        for (write_id, status) in [
            (8, 0),
            (7, 0),
            (7, wire::ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID),
        ] {
            let reply =
                encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Result {
                    kind: 1,
                    write_id,
                    result: status,
                })
                .unwrap();
            let result = call(
                "acceptEncryptedUploadV2SignedBlobResult",
                object!({"blobKind":1,"writeId":7,"bytes":reply}),
            );
            if write_id == 8 {
                assert_eq!(result.unwrap(), Value::Null);
            } else if status == 0 {
                assert_eq!(result.unwrap(), "accepted");
            } else {
                assert_eq!(result.unwrap_err().protocol_status, Some(status));
            }
        }
        assert!(call("planEncryptedUploadV2SignedBlob",object!({"blobKind":1,"writeId":7,"bytes":bytes,"capacity":63,"maximumBlobBytes":1024})).is_err());
    }
    #[test]
    fn reset_grants_have_canonical_encoding_and_exact_generation() {
        let mut grant = vec![8; wire::FACTORY_RESET_GRANT_LENGTH];
        grant[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        let encoded = STANDARD.encode(&grant);
        assert_eq!(
            call(
                "validateFactoryResetGrant",
                object!({"grantBlob":encoded,"bindingGeneration":"4294967295"})
            )
            .unwrap(),
            object!(grant)
        );
        assert!(
            call(
                "validateFactoryResetGrant",
                object!({"grantBlob":encoded,"bindingGeneration":"1"})
            )
            .is_err()
        );
        assert!(
            call(
                "validateFactoryResetGrant",
                object!({"grantBlob":format!("{encoded}\n"),"bindingGeneration":"4294967295"})
            )
            .is_err()
        );
        assert!(
            call(
                "validateFactoryResetGrant",
                object!({"grantBlob":STANDARD.encode([0;171]),"bindingGeneration":"1"})
            )
            .is_err()
        );
    }
    #[test]
    fn reset_journal_recovery_never_accepts_a_newer_or_other_device_owner() {
        let journal = object!({"serialNumber":"C8SU2XXWHI","commandId":"command","bindingGeneration":"7","result":{"result_code":0,"deleted_recording_count":u16::MAX}});
        let input =
            object!({"journal":journal,"serialNumber":"C8SU2XXWHI","currentBindingGeneration":"7"});
        assert_eq!(call("validateFactoryResetJournal", input).unwrap(), journal);
        assert_eq!(
            call(
                "validateFactoryResetJournal",
                object!({"journal":null,"serialNumber":"C8SU2XXWHI","currentBindingGeneration":"8"})
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(call("validateFactoryResetJournal",object!({"journal":journal,"serialNumber":"C8SU2XXWHI","currentBindingGeneration":"8"})).unwrap_err().code,bota_device_sdk_core::error::ErrorCode::IdentityMismatch);
        let mut failed = journal;
        failed["result"]["result_code"] = object!(1);
        assert_eq!(call("validateFactoryResetJournal",object!({"journal":failed,"serialNumber":"C8SU2XXWHI","currentBindingGeneration":"7"})).unwrap_err().code,bota_device_sdk_core::error::ErrorCode::PersistenceFailed);
    }
    #[test]
    fn streaming_header_tag_units_and_gap_policy_match_native() {
        let header=call("encodeStreamingRelayChunk",object!({"ephemeralPublicKey":vec![1;32],"salt":vec![2;4],"sequence":0,"ciphertext":vec![3;16]})).unwrap();
        let header: Vec<u8> = serde_json::from_value(header).unwrap();
        assert_eq!(header, [vec![1; 32], vec![2; 4], vec![3; 16]].concat());
        assert_eq!(call("encodeStreamingRelayChunk",object!({"ephemeralPublicKey":vec![1;32],"salt":vec![2;4],"sequence":1,"ciphertext":vec![3;16]})).unwrap(),object!(vec![3;16]));
        assert!(
            call(
                "streamingAcceptedUnits",
                object!({"encrypted":true,"ciphertextLength":"15"})
            )
            .is_err()
        );
        assert_eq!(
            call(
                "streamingAcceptedUnits",
                object!({"encrypted":true,"ciphertextLength":"18446744073709551615"})
            )
            .unwrap(),
            "18446744073709551599"
        );
        assert_eq!(
            call(
                "streamingUploadPolicy",
                object!({"encrypted":true,"sequence":0})
            )
            .unwrap()["allowGap"],
            false
        );
        assert_eq!(
            call(
                "streamingUploadPolicy",
                object!({"encrypted":true,"sequence":1})
            )
            .unwrap(),
            object!({"attempts":3,"retryDelaysMs":[50,100],"allowGap":true})
        );
    }
    fn vector(name: &str) -> Vec<u8> {
        let suite: Value = serde_json::from_str(include_str!(
            "../../../protocol/vectors/encrypted-upload-v2.json"
        ))
        .unwrap();
        let case = suite["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        case["inputHex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    fn marker(kind: u16, length: usize) -> Vec<u8> {
        let mut bytes = vec![0; length];
        bytes[..8].copy_from_slice(wire::RECORDING_MARKER_MAGIC);
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&kind.to_le_bytes());
        bytes[12..16].copy_from_slice(&(length as u32).to_le_bytes());
        bytes[16..32].fill(7);
        bytes
    }
    #[test]
    fn canonical_signed_document_vectors_admit_metadata_and_hash_only_audio_portions() {
        let authorization = vector("authorization-development");
        let auth = decode_encrypted_upload_v2_authorization_identity(&authorization).unwrap();
        let mut request = request();
        request.recording = RecordingUuid::from_bytes(auth.recording_uuid);
        request.upload_session_uuid = auth.upload_session_uuid;
        request.ciphertext_length = auth.minimum_ciphertext_length;
        request.ciphertext_sha256 = auth.ciphertext_sha256;
        request.selection.policy = match auth.policy {
            0 => UploadSecurityPolicy::LegacyAllowed,
            1 => UploadSecurityPolicy::V2Preferred,
            2 => UploadSecurityPolicy::V2Required,
            _ => panic!(),
        };
        let ordinary = call(
            "validateEncryptedUploadV2Authorization",
            object!({"request":value(&request),"bytes":authorization}),
        )
        .unwrap();
        assert_eq!(
            ordinary["blobKind"],
            wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION
        );
        let marked = [
            authorization.clone(),
            vec![0; 176],
            marker(
                wire::RECORDING_MARKER_AUTHORIZATION,
                wire::RECORDING_MARKER_AUTHORIZATION_LENGTH,
            ),
        ]
        .concat();
        let admitted = call(
            "validateEncryptedUploadV2Authorization",
            object!({"request":value(&request),"bytes":marked}),
        )
        .unwrap();
        assert_eq!(admitted["sha256"], ordinary["sha256"]);
        assert_eq!(admitted["markersRequired"], true);
        let receipt = vector("completion-receipt");
        let ordinary = call(
            "validateEncryptedUploadV2Receipt",
            object!({"request":value(&request),"markersRequired":false,"bytes":receipt}),
        )
        .unwrap();
        let marked = [
            receipt.clone(),
            marker(
                wire::RECORDING_MARKER_COMPLETION,
                wire::RECORDING_MARKER_COMPLETION_LENGTH,
            ),
        ]
        .concat();
        let admitted = call(
            "validateEncryptedUploadV2Receipt",
            object!({"request":value(&request),"markersRequired":true,"bytes":marked}),
        )
        .unwrap();
        assert_eq!(ordinary["sha256"], admitted["sha256"]);
        let mut malformed = receipt;
        malformed[wire::COMPLETION_RECEIPT_V2_RESULT_OFFSET] = 0;
        assert!(
            call(
                "validateEncryptedUploadV2Receipt",
                object!({"request":value(&request),"markersRequired":false,"bytes":malformed})
            )
            .is_err()
        );
        request.owner_revision += 1;
        assert!(
            call(
                "validateEncryptedUploadV2Authorization",
                object!({"request":value(&request),"bytes":authorization})
            )
            .is_err()
        );
    }
    #[test]
    fn marker_file_recovery_replaces_only_matching_partial_bytes() {
        let bytes = vec![5; 200];
        for (existing, expected) in [
            (vec![], object!({"write":true,"truncate":false})),
            (vec![5; 80], object!({"write":true,"truncate":true})),
            (bytes.clone(), object!({"write":false,"truncate":false})),
        ] {
            assert_eq!(call("planEncryptedUploadV2MarkerFileRecovery", object!({"bytes":bytes,"existingBytes":existing,"durableLength":existing.len().to_string()})).unwrap(), expected);
        }
        for (existing, length) in [(vec![6; 80], 80), (vec![5; 201], 201), (vec![5; 80], 81)] {
            assert_eq!(call("planEncryptedUploadV2MarkerFileRecovery", object!({"bytes":bytes,"existingBytes":existing,"durableLength":length.to_string()})).unwrap_err().code, ErrorCode::IntegrityFailed);
        }
    }

    #[test]
    fn replacement_authorization_requires_recovery_capability_and_exact_recording_owner_advance() {
        let mut bytes = vector("authorization-development");
        let auth = decode_encrypted_upload_v2_authorization_identity(&bytes).unwrap();
        let mut request = request();
        request.recording = RecordingUuid::from_bytes(auth.recording_uuid);
        request.upload_session_uuid = auth.upload_session_uuid;
        request.owner_revision = auth.owner_revision;
        request.recording_generation = auth.recording_generation;
        request.ciphertext_length = auth.minimum_ciphertext_length;
        request.ciphertext_sha256 = auth.ciphertext_sha256;
        request.selection.policy = match auth.policy {
            0 => UploadSecurityPolicy::LegacyAllowed,
            1 => UploadSecurityPolicy::V2Preferred,
            _ => UploadSecurityPolicy::V2Required,
        };
        let checkpoint = EncryptedUploadV2Checkpoint {
            device: request.device.clone(),
            recording: request.recording,
            recording_generation: request.recording_generation,
            upload_session_uuid: [9; 16],
            owner_revision: request.owner_revision - 1,
            transport_session_id: 1,
            checkpoint_revision: 1,
            next_ciphertext_offset: 128,
            prefix_sha256: [7; 32],
            window_packets: 16,
            data_payload_bytes: 244,
        };
        let input = |bytes: &Vec<u8>,
                     checkpoint: &EncryptedUploadV2Checkpoint,
                     request: &EncryptedUploadV2BatchRequest| object!({"request":value(request),"bytes":bytes,"checkpoint":value(checkpoint),"markersRequired":false});
        assert!(
            call(
                "validateEncryptedUploadV2Authorization",
                input(&bytes, &checkpoint, &request)
            )
            .is_err()
        );
        bytes[wire::UPLOAD_AUTHORIZATION_V2_FLAGS_OFFSET] |= 8;
        assert_eq!(
            call(
                "validateEncryptedUploadV2Authorization",
                input(&bytes, &checkpoint, &request)
            )
            .unwrap_err()
            .code,
            ErrorCode::UnsupportedCapability
        );
        request.capabilities.flags |= wire::ENCRYPTED_UPLOAD_V2_CAP_RECOVERY_REQUIRED_MASK;
        assert!(
            call(
                "validateEncryptedUploadV2Authorization",
                input(&bytes, &checkpoint, &request)
            )
            .is_ok()
        );
        let mut foreign = checkpoint;
        foreign.recording_generation += 1;
        assert_eq!(
            call(
                "validateEncryptedUploadV2Authorization",
                input(&bytes, &foreign, &request)
            )
            .unwrap_err()
            .code,
            ErrorCode::IdentityMismatch
        );
    }
    #[test]
    fn resume_and_opening_errors_preserve_exact_request_scope() {
        let request = request();
        let checkpoint = bota_device_sdk_core::workflow::EncryptedUploadV2Checkpoint {
            device: request.device.clone(),
            recording: request.recording,
            recording_generation: request.recording_generation,
            upload_session_uuid: request.upload_session_uuid,
            owner_revision: request.owner_revision,
            transport_session_id: request.transport_session_id,
            checkpoint_revision: 2,
            next_ciphertext_offset: 128,
            prefix_sha256: [7; 32],
            window_packets: request.window_packets,
            data_payload_bytes: request.data_payload_bytes,
        };
        let bytes:Vec<u8>=serde_json::from_value(call("planEncryptedUploadV2Opening",object!({"request":value(&request),"checkpoint":value(&checkpoint),"authorizationSha256":vec![8;32]})).unwrap()).unwrap();
        let EncryptedUploadV2Transfer::ResumeRequest(mut resume) =
            decode_encrypted_upload_v2_transfer(&bytes).unwrap()
        else {
            panic!()
        };
        resume.common.message_type = wire::ENCRYPTED_UPLOAD_V2_RESUME_ACCEPT;
        let bytes =
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ResumeAccept(resume))
                .unwrap();
        assert_eq!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":value(&checkpoint),"bytes":bytes})
            )
            .unwrap(),
            "opened"
        );
        let reject = ResumeRejectV2 {
            common: CommonHeaderV2 {
                message_type: wire::ENCRYPTED_UPLOAD_V2_RESUME_REJECT,
                flags: 0,
                transport_session_id: request.transport_session_id,
            },
            reason: wire::ENCRYPTED_UPLOAD_V2_RESULT_CHECKPOINT_MISMATCH,
            checkpoint_revision: 1,
            next_ciphertext_offset: 64,
            prefix_sha256: [9; 32],
        };
        let bytes =
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ResumeReject(reject))
                .unwrap();
        assert_eq!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":value(&checkpoint),"bytes":bytes})
            )
            .unwrap(),
            "resume_rejected"
        );
        let error = EncryptedUploadV2Transfer::Error {
            common: CommonHeaderV2 {
                message_type: wire::ENCRYPTED_UPLOAD_V2_ERROR,
                flags: 0,
                transport_session_id: request.transport_session_id,
            },
            result: wire::ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID,
            failed_message_type: wire::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST,
            checkpoint_revision: 0,
        };
        let bytes = encode_encrypted_upload_v2_transfer(&error).unwrap();
        assert_eq!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":value(&checkpoint),"bytes":bytes})
            )
            .unwrap_err()
            .protocol_status,
            Some(wire::ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID)
        );
        assert!(
            call(
                "acceptEncryptedUploadV2Opening",
                object!({"request":value(&request),"checkpoint":null,"bytes":bytes})
            )
            .is_err()
        );
    }
    #[test]
    fn context_snapshots_are_exact_attempt_and_state_owned() {
        let snapshot = |attempt: u32, state: u8, result: u16, payload: &[u8]| {
            let mut bytes = vec![0; wire::UPLOAD_CONTEXT_SNAPSHOT_MINIMUM_LENGTH];
            bytes[wire::UPLOAD_CONTEXT_SNAPSHOT_OPCODE_OFFSET] =
                wire::ENCRYPTED_UPLOAD_V2_CONTEXT_SNAPSHOT;
            bytes[wire::UPLOAD_CONTEXT_SNAPSHOT_VERSION_OFFSET] =
                wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION;
            bytes[wire::UPLOAD_CONTEXT_SNAPSHOT_STATE_OFFSET] = state;
            bytes[4..8].copy_from_slice(&attempt.to_le_bytes());
            bytes[8..10].copy_from_slice(&result.to_le_bytes());
            bytes[10..12].copy_from_slice(&(payload.len() as u16).to_le_bytes());
            bytes.extend_from_slice(payload);
            bytes
        };
        let nonce = vec![1; wire::UPLOAD_CONTEXT_NONCE_LENGTH];
        let bytes = snapshot(7, 1, 0, &nonce);
        assert_eq!(
            call(
                "acceptUploadContextSnapshot",
                object!({"attemptId":8,"expectedState":1,"bytes":bytes})
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            call(
                "acceptUploadContextSnapshot",
                object!({"attemptId":7,"expectedState":1,"bytes":bytes})
            )
            .unwrap(),
            object!(nonce)
        );
        let bytes = snapshot(
            7,
            4,
            wire::ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID,
            &[],
        );
        assert_eq!(
            call(
                "acceptUploadContextSnapshot",
                object!({"attemptId":7,"expectedState":3,"bytes":bytes})
            )
            .unwrap_err()
            .protocol_status,
            Some(wire::ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID)
        );
        let bytes = snapshot(7, 3, 0, &[]);
        assert!(
            call(
                "acceptUploadContextSnapshot",
                object!({"attemptId":7,"expectedState":1,"bytes":bytes})
            )
            .is_err()
        );
    }
    #[test]
    fn confirm_has_no_positive_received_frame_and_failures_keep_core_types() {
        let request = request();
        let bytes: Vec<u8> = serde_json::from_value(
            call(
                "planEncryptedUploadV2Confirm",
                object!({"request":value(&request),"receiptSha256":vec![8;32]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            call(
                "acceptEncryptedUploadV2Confirm",
                object!({"request":value(&request),"receiptSha256":vec![8;32],"bytes":bytes})
            )
            .unwrap(),
            Value::Null
        );
        let abort: Vec<u8> = serde_json::from_value(
            call(
                "planEncryptedUploadV2Abort",
                object!({"request":value(&request)}),
            )
            .unwrap(),
        )
        .unwrap();
        let EncryptedUploadV2Transfer::Abort { common, reason } =
            decode_encrypted_upload_v2_transfer(&abort).unwrap()
        else {
            panic!()
        };
        assert_eq!(common.transport_session_id, u64::MAX);
        assert_eq!(reason, wire::ENCRYPTED_UPLOAD_V2_RESULT_INTERNAL);
        let failure = call(
            "encryptedUploadV2Failure",
            object!({"code":"protocol_rejected","protocolStatus":4,"detail":"device rejected"}),
        )
        .unwrap();
        assert_eq!(
            failure["EncryptedUploadV2"]["Failed"]["error"]["code"],
            "ProtocolRejected"
        );
        assert_eq!(
            failure["EncryptedUploadV2"]["Failed"]["error"]["protocol_status"],
            4
        );
        assert_eq!(
            failure["EncryptedUploadV2"]["Failed"]["error"]["retryable"],
            false
        );
        assert_eq!(
            call(
                "encryptedUploadV2Failure",
                object!({"code":"operation_cancelled"})
            )
            .unwrap()["EncryptedUploadV2"]["Failed"]["error"]["code"],
            "Cancelled"
        );
        assert_eq!(
            call("initialEncryptedUploadV2ReceiverCheckpoint", object!({})).unwrap()["next_ciphertext_offset"],
            "0"
        );
    }
    #[test]
    fn subscription_startup_replay_is_only_the_firmware_held_reset_receipt() {
        assert_eq!(call("subscriptionStartupPolicy",object!({"command":{"ResumeFactoryReset":{"device":"C8SU2XXWHI","command_id":"reset","expected_result":null}}})).unwrap(),object!({"replayBeforeSubscribed":true}));
        assert_eq!(
            call(
                "subscriptionStartupPolicy",
                object!({"command":{"Provision":{"device":"C8SU2XXWHI","material_id":"material"}}})
            )
            .unwrap(),
            object!({"replayBeforeSubscribed":false})
        );
        assert!(call("subscriptionStartupPolicy",object!({"command":{"ResumeFactoryReset":{"device":"","command_id":"reset","expected_result":null}}})).is_err());
    }
}
