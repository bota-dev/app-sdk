use super::{
    EncryptedUploadV2Capabilities, cursor::Cursor, decode_encrypted_upload_v2_capabilities,
};
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
};

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct UploadContextSnapshot<'a> {
    pub attempt_id: u32,
    pub state: u8,
    pub result: u16,
    pub payload: &'a [u8],
}

pub fn encode_upload_context_begin(attempt_id: u32) -> Result<Vec<u8>, DeviceSdkError> {
    if attempt_id == 0 {
        return Err(
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false)
                .with_detail("context attempt must be nonzero"),
        );
    }
    let mut bytes = vec![0; wire::UPLOAD_CONTEXT_BEGIN_FIXED_LENGTH];
    bytes[wire::UPLOAD_CONTEXT_BEGIN_OPCODE_OFFSET] = wire::ENCRYPTED_UPLOAD_V2_CONTEXT_BEGIN;
    bytes[wire::UPLOAD_CONTEXT_BEGIN_VERSION_OFFSET] =
        wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION;
    let offset = wire::UPLOAD_CONTEXT_BEGIN_ATTEMPT_ID_OFFSET;
    bytes[offset..offset + 4].copy_from_slice(&attempt_id.to_le_bytes());
    Ok(bytes)
}

pub fn decode_upload_context_snapshot(
    bytes: &[u8],
) -> Result<UploadContextSnapshot<'_>, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(wire::UPLOAD_CONTEXT_SNAPSHOT_MINIMUM_LENGTH)?;
    let state = cursor.u8(wire::UPLOAD_CONTEXT_SNAPSHOT_STATE_OFFSET)?;
    let attempt_id = cursor.u32_le(wire::UPLOAD_CONTEXT_SNAPSHOT_ATTEMPT_ID_OFFSET)?;
    let result = cursor.u16_le(wire::UPLOAD_CONTEXT_SNAPSHOT_RESULT_OFFSET)?;
    let length = usize::from(cursor.u16_le(wire::UPLOAD_CONTEXT_SNAPSHOT_PAYLOAD_LENGTH_OFFSET)?);
    let expected_length = match state {
        1 => length == wire::UPLOAD_CONTEXT_NONCE_LENGTH,
        2 => (wire::UPLOAD_CONTEXT_PROOF_MIN_LENGTH..=wire::UPLOAD_CONTEXT_PROOF_MAX_LENGTH)
            .contains(&length),
        0 | 3 | 4 => length == 0,
        _ => false,
    };
    if cursor.u8(wire::UPLOAD_CONTEXT_SNAPSHOT_OPCODE_OFFSET)?
        != wire::ENCRYPTED_UPLOAD_V2_CONTEXT_SNAPSHOT
        || cursor.u8(wire::UPLOAD_CONTEXT_SNAPSHOT_VERSION_OFFSET)?
            != wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION
        || cursor.u8(wire::UPLOAD_CONTEXT_SNAPSHOT_RESERVED_OFFSET)? != 0
        || attempt_id == 0
        || !expected_length
        || (state == 4) != (result != 0)
    {
        return Err(invalid("invalid upload context snapshot"));
    }
    cursor.require_exact(wire::UPLOAD_CONTEXT_SNAPSHOT_MINIMUM_LENGTH + length)?;
    let payload = cursor.tail(wire::UPLOAD_CONTEXT_SNAPSHOT_MINIMUM_LENGTH)?;
    if state == 1 && payload.iter().all(|byte| *byte == 0) {
        return Err(invalid("zero context nonce"));
    }
    Ok(UploadContextSnapshot {
        attempt_id,
        state,
        result,
        payload,
    })
}

/// Only shape validation. Returned bytes convey no verified identity or time.
pub fn decode_upload_context_document(kind: u8, bytes: &[u8]) -> Result<&[u8], DeviceSdkError> {
    let (length, magic) = match kind {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_CHALLENGE => (
            wire::UPLOAD_CONTEXT_CHALLENGE_FIXED_LENGTH,
            wire::UPLOAD_CONTEXT_CHALLENGE_MAGIC,
        ),
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_RESULT => (
            wire::UPLOAD_CONTEXT_RESULT_FIXED_LENGTH,
            wire::UPLOAD_CONTEXT_RESULT_MAGIC,
        ),
        _ => return Err(invalid("unsupported context document kind")),
    };
    validate_document(
        bytes,
        magic,
        u16::from(wire::ENCRYPTED_UPLOAD_V2_CONTEXT_DOCUMENT_VERSION),
        length,
    )?;
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EncryptedUploadV2AuthorizationIdentity {
    pub profile: u8,
    pub storage_format: u8,
    pub policy: u8,
    pub channels: u8,
    pub flags: u16,
    pub owner_revision: u32,
    pub recording_generation: u32,
    pub minimum_ciphertext_length: u64,
    pub maximum_ciphertext_length: u64,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub ciphertext_sha256: [u8; 32],
}

/// Structural extraction matches the maintenance codec, not device verification.
pub fn decode_encrypted_upload_v2_authorization_identity(
    bytes: &[u8],
) -> Result<EncryptedUploadV2AuthorizationIdentity, DeviceSdkError> {
    validate_document(
        bytes,
        wire::UPLOAD_AUTHORIZATION_V2_MAGIC,
        u16::from(wire::ENCRYPTED_UPLOAD_V2_DOCUMENT_VERSION),
        wire::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH,
    )?;
    let cursor = Cursor::new(bytes);
    Ok(EncryptedUploadV2AuthorizationIdentity {
        profile: cursor.u8(wire::UPLOAD_AUTHORIZATION_V2_REQUIRED_TRANSPORT_PROFILE_OFFSET)?,
        storage_format: cursor.u8(wire::UPLOAD_AUTHORIZATION_V2_MINIMUM_STORAGE_FORMAT_OFFSET)?,
        policy: cursor.u8(wire::UPLOAD_AUTHORIZATION_V2_EFFECTIVE_POLICY_OFFSET)?,
        channels: cursor.u8(wire::UPLOAD_AUTHORIZATION_V2_ALLOWED_CHANNEL_MASK_OFFSET)?,
        flags: cursor.u16_le(wire::UPLOAD_AUTHORIZATION_V2_FLAGS_OFFSET)?,
        owner_revision: cursor
            .u32_le(wire::UPLOAD_AUTHORIZATION_V2_UPLOAD_OWNER_REVISION_OFFSET)?,
        recording_generation: cursor
            .u32_le(wire::UPLOAD_AUTHORIZATION_V2_RECORDING_GENERATION_OFFSET)?,
        minimum_ciphertext_length: cursor
            .u64_le(wire::UPLOAD_AUTHORIZATION_V2_MINIMUM_CIPHERTEXT_LENGTH_OFFSET)?,
        maximum_ciphertext_length: cursor
            .u64_le(wire::UPLOAD_AUTHORIZATION_V2_MAXIMUM_CIPHERTEXT_LENGTH_OFFSET)?,
        upload_session_uuid: cursor
            .slice(wire::UPLOAD_AUTHORIZATION_V2_UPLOAD_SESSION_UUID_OFFSET, 16)?
            .try_into()
            .expect("checked slice"),
        recording_uuid: cursor
            .slice(wire::UPLOAD_AUTHORIZATION_V2_RECORDING_UUID_OFFSET, 16)?
            .try_into()
            .expect("checked slice"),
        ciphertext_sha256: cursor
            .slice(wire::UPLOAD_AUTHORIZATION_V2_CIPHERTEXT_SHA256_OFFSET, 32)?
            .try_into()
            .expect("checked slice"),
    })
}

pub fn validate_encrypted_upload_v2_admission(
    bytes: &[u8],
    require_recovery: bool,
) -> Result<EncryptedUploadV2Capabilities, DeviceSdkError> {
    let capabilities = decode_encrypted_upload_v2_capabilities(bytes)?;
    let required = if require_recovery {
        wire::ENCRYPTED_UPLOAD_V2_CAP_RECOVERY_REQUIRED_MASK
    } else {
        wire::ENCRYPTED_UPLOAD_V2_CAP_CONTEXT_REQUIRED_MASK
    };
    if capabilities.flags & required != required {
        return Err(DeviceSdkError::new(
            ErrorCode::UnsupportedCapability,
            Operation::Validate,
            false,
        )
        .with_detail("encrypted upload v2 admission capability missing"));
    }
    Ok(capabilities)
}

fn validate_document(
    bytes: &[u8],
    magic: &[u8],
    version: u16,
    length: usize,
) -> Result<(), DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require_exact(length)?;
    if cursor.slice(wire::UPLOAD_AUTHORIZATION_V2_MAGIC_OFFSET, magic.len())? != magic
        || cursor.u16_le(wire::UPLOAD_AUTHORIZATION_V2_VERSION_OFFSET)? != version
        || usize::from(cursor.u16_le(wire::UPLOAD_AUTHORIZATION_V2_TOTAL_LENGTH_OFFSET)?) != length
    {
        return Err(invalid("invalid encrypted upload document shape"));
    }
    Ok(())
}
fn invalid(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}
