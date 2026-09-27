//! Released nonce-bound upload-context envelope. Shape validation is not trust verification.
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UploadContextSnapshot {
    pub state: u8,
    pub attempt_id: u32,
    pub result: u16,
    pub payload: Vec<u8>,
}

fn invalid(operation: Operation) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, operation, false)
        .with_detail("invalid upload context envelope")
}

pub fn encode_upload_context_begin(attempt_id: u32) -> Result<Vec<u8>, DeviceSdkError> {
    if attempt_id == 0 {
        return Err(invalid(Operation::Encode));
    }
    let mut bytes = vec![0; usize::from(wire::UPLOAD_CONTEXT_BEGIN_LENGTH)];
    bytes[0] = wire::UPLOAD_CONTEXT_BEGIN;
    bytes[1] = wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION;
    bytes[4..8].copy_from_slice(&attempt_id.to_le_bytes());
    Ok(bytes)
}

pub fn decode_upload_context_snapshot(
    bytes: &[u8],
) -> Result<UploadContextSnapshot, DeviceSdkError> {
    let header = usize::from(wire::UPLOAD_CONTEXT_SNAPSHOT_HEADER_LENGTH);
    if bytes.len() < header
        || bytes[0] != wire::UPLOAD_CONTEXT_SNAPSHOT
        || bytes[1] != wire::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION
        || bytes[3] != 0
    {
        return Err(invalid(Operation::Decode));
    }
    let state = bytes[2];
    let attempt_id = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let result = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
    let length = usize::from(u16::from_le_bytes(bytes[10..12].try_into().unwrap()));
    let valid_length = match state {
        1 => length == 16,
        2 => (usize::from(wire::UPLOAD_CONTEXT_PROOF_MIN_LENGTH)
            ..=usize::from(wire::UPLOAD_CONTEXT_PROOF_MAX_LENGTH))
            .contains(&length),
        0 | 3 | 4 => length == 0,
        _ => false,
    };
    if attempt_id == 0
        || bytes.len() != header + length
        || !valid_length
        || (state == 4) == (result == 0)
        || (state == 1 && bytes[header..].iter().all(|byte| *byte == 0))
    {
        return Err(invalid(Operation::Decode));
    }
    Ok(UploadContextSnapshot {
        state,
        attempt_id,
        result,
        payload: bytes[header..].to_vec(),
    })
}

pub fn validate_upload_context_document(kind: u8, bytes: &[u8]) -> Result<(), DeviceSdkError> {
    let (length, magic) = match kind {
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_CHALLENGE => (
            usize::from(wire::UPLOAD_CONTEXT_CHALLENGE_LENGTH),
            wire::UPLOAD_CONTEXT_CHALLENGE_MAGIC,
        ),
        wire::ENCRYPTED_UPLOAD_V2_BLOB_KIND_CONTEXT_RESULT => (
            usize::from(wire::UPLOAD_CONTEXT_RESULT_LENGTH),
            wire::UPLOAD_CONTEXT_RESULT_MAGIC,
        ),
        _ => return Err(invalid(Operation::Decode)),
    };
    if bytes.len() != length
        || &bytes[..8] != magic
        || bytes[8..10] != [1, 0]
        || u16::from_le_bytes(bytes[10..12].try_into().unwrap()) as usize != length
    {
        return Err(invalid(Operation::Decode));
    }
    Ok(())
}
