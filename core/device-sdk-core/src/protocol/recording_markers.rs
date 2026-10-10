//! Candidate inner-document codecs. No GATT assignment or persistence claim.
use sha2::{Digest, Sha256};

use super::cursor::Cursor;
use crate::error::{DeviceSdkError, ErrorCode, Operation};
use crate::generated::protocol::*;

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false)
        .with_detail("invalid recording marker document")
}
fn require(valid: bool) -> Result<(), DeviceSdkError> {
    if valid { Ok(()) } else { Err(invalid()) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingMarkerV1 {
    pub id: [u8; 16],
    pub sequence: u32,
    pub media_offset_ms: u64,
    pub segment_index: u32,
    pub segment_offset_ms: u64,
    pub created_at_utc_ms: Option<i64>,
    pub digest: [u8; 32],
}

pub fn decode_marker_body(bytes: &[u8]) -> Result<RecordingMarkerV1, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require_exact(RECORDING_MARKER_BODY_LENGTH)?;
    let id: [u8; 16] = cursor
        .slice(
            RECORDING_MARKER_BODY_UUID_OFFSET,
            RECORDING_MARKER_BODY_UUID_WIDTH,
        )?
        .try_into()
        .map_err(|_| invalid())?;
    let sequence = cursor.u32_le(RECORDING_MARKER_BODY_SEQUENCE_OFFSET)?;
    let media_offset_ms = cursor.u64_le(RECORDING_MARKER_BODY_MEDIA_OFFSET_MS_OFFSET)?;
    let segment_offset_ms = cursor.u64_le(RECORDING_MARKER_BODY_SEGMENT_OFFSET_MS_OFFSET)?;
    let utc = i64::from_le_bytes(
        cursor
            .slice(
                RECORDING_MARKER_BODY_CREATED_AT_UTC_MS_OFFSET,
                RECORDING_MARKER_BODY_CREATED_AT_UTC_MS_WIDTH,
            )?
            .try_into()
            .map_err(|_| invalid())?,
    );
    let flags = cursor.u8(RECORDING_MARKER_BODY_FLAGS_OFFSET)?;
    require(
        id != [0; 16]
            && sequence != 0
            && media_offset_ms <= i64::MAX as u64
            && segment_offset_ms <= media_offset_ms
            && cursor.u8(RECORDING_MARKER_BODY_SOURCE_OFFSET)? == 1
            && flags <= 1
            && cursor.u16_le(RECORDING_MARKER_BODY_RESERVED_OFFSET)? == 0
            && (flags == 1 || utc == 0),
    )?;
    let mut hash = Sha256::new();
    hash.update(RECORDING_MARKER_EVENT_DOMAIN);
    hash.update([0]);
    hash.update(bytes);
    Ok(RecordingMarkerV1 {
        id,
        sequence,
        media_offset_ms,
        segment_index: cursor.u32_le(RECORDING_MARKER_BODY_SEGMENT_INDEX_OFFSET)?,
        segment_offset_ms,
        created_at_utc_ms: if flags == 1 { Some(utc) } else { None },
        digest: hash.finalize().into(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerDocumentHeader {
    pub kind: u16,
    pub total_length: u32,
    pub request_uuid: [u8; 16],
    pub context_digest: [u8; 32],
}

/// This validates only visible framing. The App cannot decrypt HPKE contents.
pub fn decode_marker_document_header(
    bytes: &[u8],
    local_max_frame: u32,
) -> Result<MarkerDocumentHeader, DeviceSdkError> {
    require(bytes.len() <= local_max_frame as usize)?;
    let cursor = Cursor::new(bytes);
    cursor.require(RECORDING_MARKER_HEADER_LENGTH)?;
    require(
        cursor.slice(
            RECORDING_MARKER_HEADER_MAGIC_OFFSET,
            RECORDING_MARKER_HEADER_MAGIC_WIDTH,
        )? == RECORDING_MARKER_MAGIC
            && cursor.u16_le(RECORDING_MARKER_HEADER_VERSION_OFFSET)? == 1,
    )?;
    let kind = cursor.u16_le(RECORDING_MARKER_HEADER_KIND_OFFSET)?;
    let total_length = cursor.u32_le(RECORDING_MARKER_HEADER_TOTAL_LENGTH_OFFSET)?;
    require(total_length as usize == bytes.len())?;
    let required = match kind {
        RECORDING_MARKER_REQUEST => RECORDING_MARKER_REQUEST_LENGTH,
        RECORDING_MARKER_SEAL => RECORDING_MARKER_SEAL_LENGTH,
        RECORDING_MARKER_PAGE if bytes.len() > RECORDING_MARKER_PAGE_OVERHEAD => bytes.len(),
        RECORDING_MARKER_ACK => RECORDING_MARKER_ACK_LENGTH,
        RECORDING_MARKER_COMPLETION => RECORDING_MARKER_COMPLETION_LENGTH,
        RECORDING_MARKER_AUTHORIZATION => RECORDING_MARKER_AUTHORIZATION_LENGTH,
        _ => return Err(invalid()),
    };
    require(bytes.len() == required)?;
    let request_uuid = cursor
        .slice(
            RECORDING_MARKER_HEADER_REQUEST_UUID_OFFSET,
            RECORDING_MARKER_HEADER_REQUEST_UUID_WIDTH,
        )?
        .try_into()
        .map_err(|_| invalid())?;
    require(request_uuid != [0; 16])?;
    Ok(MarkerDocumentHeader {
        kind,
        total_length,
        request_uuid,
        context_digest: cursor
            .slice(
                RECORDING_MARKER_HEADER_CONTEXT_DIGEST_OFFSET,
                RECORDING_MARKER_HEADER_CONTEXT_DIGEST_WIDTH,
            )?
            .try_into()
            .map_err(|_| invalid())?,
    })
}

/// One object belongs to one authorized connection generation and transfer.
/// Callers destroy it on disconnect. Reassembly never verifies a signature,
/// decrypts data, emits "saved", or authorizes cleanup.
pub struct MarkerDocumentAssembler {
    connection_generation: u64,
    transfer_id: u32,
    expected_kind: u16,
    expected_length: usize,
    local_max_frame: u32,
    request_uuid: [u8; 16],
    context_digest: [u8; 32],
    bytes: Vec<u8>,
    complete: bool,
    failed: bool,
}
impl MarkerDocumentAssembler {
    pub fn new(
        connection_generation: u64,
        transfer_id: u32,
        expected_kind: u16,
        expected_length: u32,
        local_max_frame: u32,
        request_uuid: [u8; 16],
        context_digest: [u8; 32],
    ) -> Result<Self, DeviceSdkError> {
        require(
            connection_generation != 0
                && transfer_id != 0
                && request_uuid != [0; 16]
                && matches!(
                    expected_kind,
                    RECORDING_MARKER_REQUEST
                        | RECORDING_MARKER_SEAL
                        | RECORDING_MARKER_PAGE
                        | RECORDING_MARKER_ACK
                        | RECORDING_MARKER_COMPLETION
                        | RECORDING_MARKER_AUTHORIZATION
                )
                && expected_length as usize >= RECORDING_MARKER_HEADER_LENGTH
                && expected_length <= local_max_frame,
        )?;
        Ok(Self {
            connection_generation,
            transfer_id,
            expected_kind,
            expected_length: expected_length as usize,
            local_max_frame,
            request_uuid,
            context_digest,
            bytes: Vec::new(),
            complete: false,
            failed: false,
        })
    }

    pub fn push(
        &mut self,
        connection_generation: u64,
        transfer_id: u32,
        offset: u32,
        fragment: &[u8],
    ) -> Result<bool, DeviceSdkError> {
        require(
            !self.failed
                && connection_generation == self.connection_generation
                && transfer_id == self.transfer_id
                && !fragment.is_empty(),
        )?;
        let start = offset as usize;
        let end = start.checked_add(fragment.len()).ok_or_else(invalid)?;
        require(end <= self.expected_length)?;
        if start < self.bytes.len() {
            require(end <= self.bytes.len() && self.bytes[start..end] == *fragment)?;
            return Ok(self.complete);
        }
        require(start == self.bytes.len() && !self.complete)?;
        self.bytes
            .try_reserve_exact(fragment.len())
            .map_err(|_| invalid())?;
        self.bytes.extend_from_slice(fragment);
        if self.bytes.len() == self.expected_length {
            let result = decode_marker_document_header(&self.bytes, self.local_max_frame).and_then(
                |header| {
                    require(
                        header.kind == self.expected_kind
                            && header.request_uuid == self.request_uuid
                            && header.context_digest == self.context_digest,
                    )
                },
            );
            if let Err(error) = result {
                self.failed = true;
                self.bytes.clear();
                return Err(error);
            }
            self.complete = true;
        }
        Ok(self.complete)
    }
    pub fn document(&self) -> Option<&[u8]> {
        if self.complete && !self.failed {
            Some(&self.bytes)
        } else {
            None
        }
    }
}
