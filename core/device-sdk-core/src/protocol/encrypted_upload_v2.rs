use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
};
use sha2::{Digest, Sha256};

use super::cursor::Cursor;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EncryptedUploadV2Capabilities {
    pub flags: u32,
    pub maximum_signed_blob_bytes: u16,
    pub maximum_manifest_bytes: u16,
    pub maximum_data_payload_bytes: u16,
    pub maximum_window_packets: u16,
    pub durable_checkpoint_interval_blocks: u32,
    pub maximum_missing_sequences: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommonHeaderV2 {
    pub message_type: u8,
    pub flags: u16,
    pub transport_session_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2SignedBlob<'a> {
    Begin {
        kind: u8,
        write_id: u32,
        total_length: u16,
        sha256: [u8; 32],
    },
    Data {
        kind: u8,
        write_id: u32,
        offset: u16,
        data: &'a [u8],
    },
    Commit {
        kind: u8,
        write_id: u32,
    },
    Abort {
        kind: u8,
        write_id: u32,
    },
    Result {
        kind: u8,
        write_id: u32,
        result: u16,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordingEntryV2 {
    pub common: CommonHeaderV2,
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub storage_format: u8,
    pub completion_state: u8,
    pub started_at: u64,
    pub duration_seconds: u32,
    pub plaintext_length: u64,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartV2 {
    pub common: CommonHeaderV2,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub authorization_sha256: [u8; 32],
    pub checkpoint_revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub window_packets: u16,
    pub data_payload_bytes: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartAckV2 {
    pub common: CommonHeaderV2,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
    pub window_packets: u16,
    pub data_payload_bytes: u16,
    pub checkpoint_interval_blocks: u32,
    pub checkpoint_revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowEndV2 {
    pub common: CommonHeaderV2,
    pub window_index: u32,
    pub first_sequence: u32,
    pub last_sequence: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub checkpoint_revision: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowAckV2 {
    pub common: CommonHeaderV2,
    pub window_index: u32,
    pub highest_contiguous_sequence: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub checkpoint_revision: u32,
    pub missing_sequences: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ManifestChunkV2<'a> {
    pub common: CommonHeaderV2,
    pub total_manifest_length: u16,
    pub chunk_offset: u16,
    pub manifest_sha256: [u8; 32],
    pub chunk: &'a [u8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EofV2 {
    pub common: CommonHeaderV2,
    pub final_sequence: u32,
    pub block_count: u32,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
    pub manifest_sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResumeV2 {
    pub common: CommonHeaderV2,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub checkpoint_revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub window_packets: u16,
    pub data_payload_bytes: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResumeRejectV2 {
    pub common: CommonHeaderV2,
    pub reason: u16,
    pub checkpoint_revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConfirmV2 {
    pub common: CommonHeaderV2,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub owner_revision: u32,
    pub receipt_sha256: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2Transfer<'a> {
    List(CommonHeaderV2),
    RecordingEntry(RecordingEntryV2),
    RecordingListEnd {
        common: CommonHeaderV2,
        count: u32,
        list_revision: u32,
        list_sha256: [u8; 32],
    },
    Start(StartV2),
    StartAck(StartAckV2),
    Data {
        common: CommonHeaderV2,
        sequence: u32,
        offset: u64,
        data: &'a [u8],
    },
    WindowEnd(WindowEndV2),
    WindowAck(WindowAckV2),
    ManifestChunk(ManifestChunkV2<'a>),
    Eof(EofV2),
    ResumeRequest(ResumeV2),
    ResumeAccept(ResumeV2),
    ResumeReject(ResumeRejectV2),
    Confirm(ConfirmV2),
    Abort {
        common: CommonHeaderV2,
        reason: u16,
    },
    Error {
        common: CommonHeaderV2,
        result: u16,
        failed_message_type: u8,
        checkpoint_revision: u32,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EncryptedUploadV2Status {
    pub phase: u8,
    pub result: u16,
    pub transport_session_id: u64,
    pub durable_ciphertext_bytes: u64,
    pub progress_percent: u8,
    pub transport_profile: u8,
}

pub fn decode_encrypted_upload_v2_capabilities(
    bytes: &[u8],
) -> Result<EncryptedUploadV2Capabilities, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_FIXED_LENGTH)?;
    require_version(
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_ENCODING_VERSION_OFFSET)?,
        protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_ENCODING_VERSION,
        "capability encoding version",
    )?;
    require_version(
        cursor
            .u8(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_HIGHEST_TRANSFER_PROFILE_VERSION_OFFSET)?,
        protocol::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION,
        "highest transfer profile version",
    )?;
    require_declared_length(
        usize::from(cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_VALUE_LENGTH_OFFSET)?),
        protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_FIXED_LENGTH,
        "capability value length",
    )?;
    let flags = cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_FLAGS_OFFSET)?;
    let known_flags = protocol::ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_STORAGE
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_FULL_RECORDING_IDENTITY
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_DURABLE_RESUME
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_MANIFEST
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_RECEIPT
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_BATCH
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_STREAMING;
    require_known_bits(flags, known_flags, "capability flags")?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_RESERVED_WIDTH,
        )?,
        "capability reserved bytes",
    )?;

    let value = EncryptedUploadV2Capabilities {
        flags,
        maximum_signed_blob_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_MAXIMUM_SIGNED_BLOB_BYTES_OFFSET)?,
        maximum_manifest_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_MAXIMUM_MANIFEST_BYTES_OFFSET)?,
        maximum_data_payload_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_MAXIMUM_DATA_PAYLOAD_BYTES_OFFSET)?,
        maximum_window_packets: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_MAXIMUM_WINDOW_PACKETS_OFFSET)?,
        durable_checkpoint_interval_blocks: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_CHECKPOINT_INTERVAL_BLOCKS_OFFSET)?,
        maximum_missing_sequences: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_CAPABILITY_MAXIMUM_MISSING_SEQUENCES_OFFSET)?,
    };
    if usize::from(value.maximum_signed_blob_bytes) < protocol::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH
        || usize::from(value.maximum_manifest_bytes) < protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH
        || value.maximum_data_payload_bytes == 0
        || value.maximum_window_packets == 0
        || value.durable_checkpoint_interval_blocks == 0
        || value.maximum_missing_sequences == 0
    {
        return Err(invalid_decode("capability bounds are not usable"));
    }
    Ok(value)
}

pub fn decode_encrypted_upload_v2_signed_blob(
    bytes: &[u8],
) -> Result<EncryptedUploadV2SignedBlob<'_>, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(1)?;
    match cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_CODE_OFFSET)? {
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN => {
            cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_FIXED_LENGTH)?;
            let (kind, write_id) = decode_blob_prefix(&cursor)?;
            let total_length =
                cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_TOTAL_LENGTH_OFFSET)?;
            let expected = signed_document_length(kind, Operation::Decode)?;
            require_declared_length(
                usize::from(total_length),
                expected,
                "signed blob total length",
            )?;
            Ok(EncryptedUploadV2SignedBlob::Begin {
                kind,
                write_id,
                total_length,
                sha256: fixed::<32>(
                    &cursor,
                    protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_SHA256_OFFSET,
                )?,
            })
        }
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA => {
            cursor.require(protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_MINIMUM_LENGTH)?;
            ensure_frame_limit(cursor.len(), Operation::Decode)?;
            let (kind, write_id) = decode_blob_prefix(&cursor)?;
            let offset = cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_OFFSET_OFFSET)?;
            let length = usize::from(
                cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_CHUNK_LENGTH_OFFSET)?,
            );
            if length == 0 {
                return Err(invalid_decode("signed blob DATA chunk must not be empty"));
            }
            let expected = checked_frame_length(
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_MINIMUM_LENGTH,
                length,
                1,
            )?;
            require_dynamic_exact(&cursor, expected)?;
            let document_length = signed_document_length(kind, Operation::Decode)?;
            let end = usize::from(offset)
                .checked_add(length)
                .ok_or_else(|| payload_too_large(Operation::Decode, "signed blob DATA range"))?;
            if end > document_length {
                return Err(payload_too_large(
                    Operation::Decode,
                    "signed blob DATA exceeds its document",
                ));
            }
            Ok(EncryptedUploadV2SignedBlob::Data {
                kind,
                write_id,
                offset,
                data: cursor.tail(protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_CHUNK_OFFSET)?,
            })
        }
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_COMMIT => {
            cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_BLOB_COMMIT_FIXED_LENGTH)?;
            let (kind, write_id) = decode_blob_prefix(&cursor)?;
            Ok(EncryptedUploadV2SignedBlob::Commit { kind, write_id })
        }
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_ABORT => {
            cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_BLOB_ABORT_FIXED_LENGTH)?;
            let (kind, write_id) = decode_blob_prefix(&cursor)?;
            Ok(EncryptedUploadV2SignedBlob::Abort { kind, write_id })
        }
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT => {
            cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT_FIXED_LENGTH)?;
            let (kind, write_id) = decode_blob_prefix(&cursor)?;
            Ok(EncryptedUploadV2SignedBlob::Result {
                kind,
                write_id,
                result: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT_RESULT_OFFSET)?,
            })
        }
        code => Err(unknown_decode(code, "signed blob message")),
    }
}

pub fn encode_encrypted_upload_v2_signed_blob(
    value: &EncryptedUploadV2SignedBlob<'_>,
) -> Result<Vec<u8>, DeviceSdkError> {
    let (code, kind, write_id, length) = match value {
        EncryptedUploadV2SignedBlob::Begin {
            kind,
            write_id,
            total_length,
            ..
        } => {
            let expected = signed_document_length(*kind, Operation::Encode)?;
            if usize::from(*total_length) != expected {
                return Err(invalid_encode("signed blob total length is not canonical"));
            }
            (
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN,
                *kind,
                *write_id,
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_FIXED_LENGTH,
            )
        }
        EncryptedUploadV2SignedBlob::Data {
            kind,
            write_id,
            offset,
            data,
        } => {
            let document_length = signed_document_length(*kind, Operation::Encode)?;
            if data.is_empty() {
                return Err(invalid_encode("signed blob DATA chunk must not be empty"));
            }
            let data_length = u16::try_from(data.len()).map_err(|_| {
                payload_too_large(Operation::Encode, "signed blob DATA chunk length")
            })?;
            let end = usize::from(*offset)
                .checked_add(usize::from(data_length))
                .ok_or_else(|| payload_too_large(Operation::Encode, "signed blob DATA range"))?;
            if end > document_length {
                return Err(payload_too_large(
                    Operation::Encode,
                    "signed blob DATA exceeds its document",
                ));
            }
            let length = checked_encode_frame_length(
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_MINIMUM_LENGTH,
                data.len(),
                1,
            )?;
            ensure_frame_limit(length, Operation::Encode)?;
            (
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA,
                *kind,
                *write_id,
                length,
            )
        }
        EncryptedUploadV2SignedBlob::Commit { kind, write_id } => (
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_COMMIT,
            *kind,
            *write_id,
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_COMMIT_FIXED_LENGTH,
        ),
        EncryptedUploadV2SignedBlob::Abort { kind, write_id } => (
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_ABORT,
            *kind,
            *write_id,
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_ABORT_FIXED_LENGTH,
        ),
        EncryptedUploadV2SignedBlob::Result { kind, write_id, .. } => (
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT,
            *kind,
            *write_id,
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT_FIXED_LENGTH,
        ),
    };
    signed_document_length(kind, Operation::Encode)?;
    let mut bytes = vec![0_u8; length];
    bytes[protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_CODE_OFFSET] = code;
    bytes[protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_VERSION_OFFSET] =
        protocol::ENCRYPTED_UPLOAD_V2_DOCUMENT_VERSION;
    bytes[protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_KIND_OFFSET] = kind;
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_WRITE_ID_OFFSET,
        write_id,
    );

    match value {
        EncryptedUploadV2SignedBlob::Begin {
            total_length,
            sha256,
            ..
        } => {
            put_u16(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_TOTAL_LENGTH_OFFSET,
                *total_length,
            );
            put_fixed(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_SHA256_OFFSET,
                sha256,
            );
        }
        EncryptedUploadV2SignedBlob::Data { offset, data, .. } => {
            put_u16(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_OFFSET_OFFSET,
                *offset,
            );
            put_u16(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_CHUNK_LENGTH_OFFSET,
                u16::try_from(data.len()).expect("validated signed blob DATA length"),
            );
            bytes[protocol::ENCRYPTED_UPLOAD_V2_BLOB_DATA_CHUNK_OFFSET..].copy_from_slice(data);
        }
        EncryptedUploadV2SignedBlob::Result { result, .. } => put_u16(
            &mut bytes,
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_RESULT_RESULT_OFFSET,
            *result,
        ),
        EncryptedUploadV2SignedBlob::Commit { .. } | EncryptedUploadV2SignedBlob::Abort { .. } => {}
    }
    Ok(bytes)
}

pub struct SignedBlobAssemblerV2 {
    kind: u8,
    write_id: u32,
    total_length: usize,
    sha256: [u8; 32],
    bytes: Vec<u8>,
    active: bool,
}

impl SignedBlobAssemblerV2 {
    pub fn from_begin(value: &EncryptedUploadV2SignedBlob<'_>) -> Result<Self, DeviceSdkError> {
        let EncryptedUploadV2SignedBlob::Begin {
            kind,
            write_id,
            total_length,
            sha256,
        } = value
        else {
            return Err(invalid_decode("signed blob assembly requires BEGIN"));
        };
        let expected = signed_document_length(*kind, Operation::Decode)?;
        if usize::from(*total_length) != expected {
            return Err(invalid_decode("signed blob total length is not canonical"));
        }
        Ok(Self {
            kind: *kind,
            write_id: *write_id,
            total_length: expected,
            sha256: *sha256,
            bytes: Vec::with_capacity(expected),
            active: true,
        })
    }

    pub fn buffered_length(&self) -> usize {
        self.bytes.len()
    }

    pub fn push(&mut self, value: &EncryptedUploadV2SignedBlob<'_>) -> Result<(), DeviceSdkError> {
        if !self.active {
            return Err(invalid_decode("signed blob assembly is not active"));
        }
        let EncryptedUploadV2SignedBlob::Data {
            kind,
            write_id,
            offset,
            data,
        } = value
        else {
            return self.fail(invalid_decode("signed blob assembly requires DATA"));
        };
        if *kind != self.kind || *write_id != self.write_id {
            return self.fail(invalid_decode("signed blob assembly owner mismatch"));
        }
        if data.is_empty() {
            return self.fail(invalid_decode("signed blob DATA chunk must not be empty"));
        }
        let offset = usize::from(*offset);
        let end = offset
            .checked_add(data.len())
            .ok_or_else(|| payload_too_large(Operation::Decode, "signed blob DATA range"));
        let end = match end {
            Ok(end) => end,
            Err(error) => return self.fail(error),
        };
        if end > self.total_length {
            return self.fail(payload_too_large(
                Operation::Decode,
                "signed blob DATA exceeds its document",
            ));
        }
        if offset == self.bytes.len() {
            self.bytes.extend_from_slice(data);
            return Ok(());
        }
        if end <= self.bytes.len() && constant_time_eq(&self.bytes[offset..end], data) {
            return Ok(());
        }
        self.fail(invalid_decode(
            "signed blob DATA gap or conflicting overlap",
        ))
    }

    pub fn finish(
        &mut self,
        value: &EncryptedUploadV2SignedBlob<'_>,
    ) -> Result<Vec<u8>, DeviceSdkError> {
        if !self.active {
            return Err(invalid_decode("signed blob assembly is not active"));
        }
        let EncryptedUploadV2SignedBlob::Commit { kind, write_id } = value else {
            return self.fail(invalid_decode("signed blob assembly requires COMMIT"));
        };
        if *kind != self.kind || *write_id != self.write_id {
            return self.fail(invalid_decode("signed blob assembly owner mismatch"));
        }
        if self.bytes.len() != self.total_length {
            return self.fail(invalid_decode("signed blob assembly is incomplete"));
        }
        let digest: [u8; 32] = Sha256::digest(&self.bytes).into();
        if !constant_time_eq(&digest, &self.sha256) {
            return self.fail(
                DeviceSdkError::new(ErrorCode::IntegrityFailed, Operation::Decode, false)
                    .with_detail("signed blob SHA-256 mismatch"),
            );
        }
        self.active = false;
        Ok(std::mem::take(&mut self.bytes))
    }

    pub fn abort(&mut self, value: &EncryptedUploadV2SignedBlob<'_>) -> Result<(), DeviceSdkError> {
        if !self.active {
            return Err(invalid_decode("signed blob assembly is not active"));
        }
        let EncryptedUploadV2SignedBlob::Abort { kind, write_id } = value else {
            return self.fail(invalid_decode("signed blob assembly requires ABORT"));
        };
        if *kind != self.kind || *write_id != self.write_id {
            return self.fail(invalid_decode("signed blob assembly owner mismatch"));
        }
        self.clear();
        self.active = false;
        Ok(())
    }

    fn fail<T>(&mut self, error: DeviceSdkError) -> Result<T, DeviceSdkError> {
        self.clear();
        self.active = false;
        Err(error)
    }

    fn clear(&mut self) {
        self.bytes.fill(0);
        self.bytes.clear();
    }
}

impl Drop for SignedBlobAssemblerV2 {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

pub fn decode_encrypted_upload_v2_transfer(
    bytes: &[u8],
) -> Result<EncryptedUploadV2Transfer<'_>, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(1)?;
    match cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_MESSAGE_TYPE_OFFSET)? {
        protocol::ENCRYPTED_UPLOAD_V2_LIST => decode_list(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY => decode_recording_entry(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END => decode_recording_list_end(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_START => decode_start(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK => decode_start_ack(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_DATA => decode_data(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END => decode_window_end(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK => decode_window_ack(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK => decode_manifest_chunk(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_EOF => decode_eof(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST => decode_resume(&cursor, false),
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_ACCEPT => decode_resume(&cursor, true),
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT => decode_resume_reject(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM => decode_confirm(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_ABORT => decode_abort(&cursor),
        protocol::ENCRYPTED_UPLOAD_V2_ERROR => decode_error(&cursor),
        code => Err(unknown_decode(code, "transfer message")),
    }
}

pub fn encode_encrypted_upload_v2_transfer(
    value: &EncryptedUploadV2Transfer<'_>,
) -> Result<Vec<u8>, DeviceSdkError> {
    match value {
        EncryptedUploadV2Transfer::List(common) => {
            encode_common_fixed(common, protocol::ENCRYPTED_UPLOAD_V2_LIST, 16)
        }
        EncryptedUploadV2Transfer::RecordingEntry(value) => {
            if value.storage_format != protocol::STORAGE_FORMAT_BOTA_ENC_V2
                || value.completion_state != protocol::ENCRYPTED_UPLOAD_V2_COMPLETION_COMPLETE
            {
                return Err(invalid_encode(
                    "recording entry is not committed bota_enc_v2",
                ));
            }
            let mut bytes = encode_common_fixed(
                &value.common,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH,
            )?;
            put_fixed(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RECORDING_UUID_OFFSET,
                &value.recording_uuid,
            );
            put_u32(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RECORDING_GENERATION_OFFSET,
                value.recording_generation,
            );
            bytes[protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_STORAGE_FORMAT_OFFSET] =
                value.storage_format;
            bytes[protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_COMPLETION_STATE_OFFSET] =
                value.completion_state;
            put_u64(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_STARTED_AT_OFFSET,
                value.started_at,
            );
            put_u32(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_DURATION_SECONDS_OFFSET,
                value.duration_seconds,
            );
            put_u64(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_PLAINTEXT_LENGTH_OFFSET,
                value.plaintext_length,
            );
            put_u64(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_CIPHERTEXT_LENGTH_OFFSET,
                value.ciphertext_length,
            );
            put_fixed(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_CIPHERTEXT_SHA256_OFFSET,
                &value.ciphertext_sha256,
            );
            Ok(bytes)
        }
        EncryptedUploadV2Transfer::RecordingListEnd {
            common,
            count,
            list_revision,
            list_sha256,
        } => {
            let mut bytes = encode_common_fixed(
                common,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_FIXED_LENGTH,
            )?;
            put_u32(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_ENTRY_COUNT_OFFSET,
                *count,
            );
            put_u32(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_LIST_REVISION_OFFSET,
                *list_revision,
            );
            put_fixed(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_LIST_SHA256_OFFSET,
                list_sha256,
            );
            Ok(bytes)
        }
        EncryptedUploadV2Transfer::Start(value) => encode_start(value),
        EncryptedUploadV2Transfer::StartAck(value) => encode_start_ack(value),
        EncryptedUploadV2Transfer::Data {
            common,
            sequence,
            offset,
            data,
        } => encode_data(common, *sequence, *offset, data),
        EncryptedUploadV2Transfer::WindowEnd(value) => encode_window_end(value),
        EncryptedUploadV2Transfer::WindowAck(value) => encode_window_ack(value),
        EncryptedUploadV2Transfer::ManifestChunk(value) => encode_manifest_chunk(value),
        EncryptedUploadV2Transfer::Eof(value) => encode_eof(value),
        EncryptedUploadV2Transfer::ResumeRequest(value) => encode_resume(value, false),
        EncryptedUploadV2Transfer::ResumeAccept(value) => encode_resume(value, true),
        EncryptedUploadV2Transfer::ResumeReject(value) => encode_resume_reject(value),
        EncryptedUploadV2Transfer::Confirm(value) => encode_confirm(value),
        EncryptedUploadV2Transfer::Abort { common, reason } => {
            let mut bytes = encode_common_fixed(
                common,
                protocol::ENCRYPTED_UPLOAD_V2_ABORT,
                protocol::ENCRYPTED_UPLOAD_V2_ABORT_FIXED_LENGTH,
            )?;
            put_u16(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_ABORT_REASON_OFFSET,
                *reason,
            );
            Ok(bytes)
        }
        EncryptedUploadV2Transfer::Error {
            common,
            result,
            failed_message_type,
            checkpoint_revision,
        } => {
            let mut bytes = encode_common_fixed(
                common,
                protocol::ENCRYPTED_UPLOAD_V2_ERROR,
                protocol::ENCRYPTED_UPLOAD_V2_ERROR_FIXED_LENGTH,
            )?;
            put_u16(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_ERROR_ERROR_OFFSET,
                *result,
            );
            bytes[protocol::ENCRYPTED_UPLOAD_V2_ERROR_FAILED_MESSAGE_TYPE_OFFSET] =
                *failed_message_type;
            put_u32(
                &mut bytes,
                protocol::ENCRYPTED_UPLOAD_V2_ERROR_CHECKPOINT_REVISION_OFFSET,
                *checkpoint_revision,
            );
            Ok(bytes)
        }
    }
}

pub fn decode_encrypted_upload_v2_status(
    bytes: &[u8],
) -> Result<EncryptedUploadV2Status, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_STATUS_FIXED_LENGTH)?;
    require_version(
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_STATUS_VERSION_OFFSET)?,
        protocol::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION,
        "transfer status version",
    )?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_STATUS_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_STATUS_RESERVED_WIDTH,
        )?,
        "transfer status reserved bytes",
    )?;
    let value = EncryptedUploadV2Status {
        phase: cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_STATUS_PHASE_OFFSET)?,
        result: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_STATUS_RESULT_OFFSET)?,
        transport_session_id: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_STATUS_SESSION_ID_OFFSET)?,
        durable_ciphertext_bytes: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_STATUS_DURABLE_CIPHERTEXT_BYTES_OFFSET)?,
        progress_percent: cursor
            .u8(protocol::ENCRYPTED_UPLOAD_V2_STATUS_PROGRESS_PERCENT_OFFSET)?,
        transport_profile: cursor
            .u8(protocol::ENCRYPTED_UPLOAD_V2_STATUS_TRANSPORT_PROFILE_OFFSET)?,
    };
    if value.progress_percent > 100 {
        return Err(invalid_decode("transfer status progress exceeds 100"));
    }
    if value.phase == protocol::ENCRYPTED_UPLOAD_V2_PHASE_IDLE {
        if value.transport_session_id != 0 || value.transport_profile != 0 {
            return Err(invalid_decode(
                "idle transfer status has an active session or profile",
            ));
        }
    } else if value.transport_session_id == 0
        || value.transport_profile != protocol::UPLOAD_PROFILE_ENCRYPTED_UPLOAD_V2
    {
        return Err(invalid_decode(
            "active transfer status requires a v2 session and profile",
        ));
    }
    Ok(value)
}

fn decode_list<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_LIST_FIXED_LENGTH)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_LIST)?;
    let request_flags = cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_LIST_REQUEST_FLAGS_OFFSET)?;
    require_known_bits(request_flags, 0, "LIST request flags")?;
    Ok(EncryptedUploadV2Transfer::List(common))
}

fn decode_recording_entry<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RESERVED_WIDTH,
        )?,
        "RECORDING_ENTRY reserved bytes",
    )?;
    let storage_format =
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_STORAGE_FORMAT_OFFSET)?;
    let completion_state =
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_COMPLETION_STATE_OFFSET)?;
    if storage_format != protocol::STORAGE_FORMAT_BOTA_ENC_V2
        || completion_state != protocol::ENCRYPTED_UPLOAD_V2_COMPLETION_COMPLETE
    {
        return Err(invalid_decode(
            "RECORDING_ENTRY is not committed bota_enc_v2",
        ));
    }
    Ok(EncryptedUploadV2Transfer::RecordingEntry(
        RecordingEntryV2 {
            common,
            recording_uuid: fixed::<16>(
                cursor,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RECORDING_UUID_OFFSET,
            )?,
            recording_generation: cursor.u32_le(
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_RECORDING_GENERATION_OFFSET,
            )?,
            storage_format,
            completion_state,
            started_at: cursor
                .u64_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_STARTED_AT_OFFSET)?,
            duration_seconds: cursor
                .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_DURATION_SECONDS_OFFSET)?,
            plaintext_length: cursor
                .u64_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_PLAINTEXT_LENGTH_OFFSET)?,
            ciphertext_length: cursor
                .u64_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_CIPHERTEXT_LENGTH_OFFSET)?,
            ciphertext_sha256: fixed::<32>(
                cursor,
                protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_CIPHERTEXT_SHA256_OFFSET,
            )?,
        },
    ))
}

fn decode_recording_list_end<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_FIXED_LENGTH)?;
    Ok(EncryptedUploadV2Transfer::RecordingListEnd {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END)?,
        count: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_ENTRY_COUNT_OFFSET)?,
        list_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_LIST_REVISION_OFFSET)?,
        list_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_LIST_SHA256_OFFSET,
        )?,
    })
}

fn decode_start<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_START_FIXED_LENGTH)?;
    let value = StartV2 {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_START)?,
        upload_session_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_UPLOAD_SESSION_UUID_OFFSET,
        )?,
        recording_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_RECORDING_UUID_OFFSET,
        )?,
        recording_generation: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_START_RECORDING_GENERATION_OFFSET)?,
        authorization_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_AUTHORIZATION_SHA256_OFFSET,
        )?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_START_CHECKPOINT_REVISION_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_START_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_PREFIX_SHA256_OFFSET,
        )?,
        window_packets: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_START_WINDOW_PACKETS_OFFSET)?,
        data_payload_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_START_DATA_PAYLOAD_BYTES_OFFSET)?,
    };
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Decode,
    )?;
    Ok(EncryptedUploadV2Transfer::Start(value))
}

fn decode_start_ack<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_FIXED_LENGTH)?;
    let value = StartAckV2 {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_START_ACK)?,
        upload_session_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_ACK_UPLOAD_SESSION_UUID_OFFSET,
        )?,
        recording_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_ACK_RECORDING_UUID_OFFSET,
        )?,
        recording_generation: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_RECORDING_GENERATION_OFFSET)?,
        ciphertext_length: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CIPHERTEXT_LENGTH_OFFSET)?,
        ciphertext_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CIPHERTEXT_SHA256_OFFSET,
        )?,
        window_packets: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_WINDOW_PACKETS_OFFSET)?,
        data_payload_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_DATA_PAYLOAD_BYTES_OFFSET)?,
        checkpoint_interval_blocks: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CHECKPOINT_INTERVAL_BLOCKS_OFFSET)?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CHECKPOINT_REVISION_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_START_ACK_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_START_ACK_PREFIX_SHA256_OFFSET,
        )?,
    };
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Decode,
    )?;
    if value.checkpoint_interval_blocks == 0 {
        return Err(invalid_decode(
            "START_ACK checkpoint interval must be nonzero",
        ));
    }
    Ok(EncryptedUploadV2Transfer::StartAck(value))
}

fn decode_data<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require(protocol::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH)?;
    ensure_frame_limit(cursor.len(), Operation::Decode)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_DATA)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_DATA_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_DATA_RESERVED_WIDTH,
        )?,
        "DATA reserved bytes",
    )?;
    let payload_length =
        usize::from(cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_DATA_PAYLOAD_LENGTH_OFFSET)?);
    if payload_length == 0 {
        return Err(invalid_decode("DATA payload must not be empty"));
    }
    let expected = checked_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH,
        payload_length,
        1,
    )?;
    require_dynamic_exact(cursor, expected)?;
    let offset = cursor.u64_le(protocol::ENCRYPTED_UPLOAD_V2_DATA_CIPHERTEXT_OFFSET_OFFSET)?;
    offset
        .checked_add(payload_length as u64)
        .ok_or_else(|| payload_too_large(Operation::Decode, "DATA ciphertext range"))?;
    Ok(EncryptedUploadV2Transfer::Data {
        common,
        sequence: cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_DATA_SEQUENCE_OFFSET)?,
        offset,
        data: cursor.tail(protocol::ENCRYPTED_UPLOAD_V2_DATA_PAYLOAD_OFFSET)?,
    })
}

fn decode_window_end<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_FIXED_LENGTH)?;
    let value = WindowEndV2 {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END)?,
        window_index: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_WINDOW_INDEX_OFFSET)?,
        first_sequence: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_FIRST_SEQUENCE_OFFSET)?,
        last_sequence: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_LAST_SEQUENCE_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_PREFIX_SHA256_OFFSET,
        )?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_CHECKPOINT_REVISION_OFFSET)?,
    };
    if value.first_sequence > value.last_sequence {
        return Err(invalid_decode(
            "WINDOW_END first sequence exceeds last sequence",
        ));
    }
    Ok(EncryptedUploadV2Transfer::WindowEnd(value))
}

fn decode_window_ack<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH)?;
    ensure_frame_limit(cursor.len(), Operation::Decode)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_RESERVED_WIDTH,
        )?,
        "WINDOW_ACK reserved bytes",
    )?;
    let count =
        usize::from(cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MISSING_COUNT_OFFSET)?);
    let expected = checked_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH,
        count,
        4,
    )?;
    require_dynamic_exact(cursor, expected)?;
    let mut missing_sequences = Vec::with_capacity(count);
    for index in 0..count {
        let offset = protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MISSING_SEQUENCES_OFFSET
            .checked_add(index.checked_mul(4).ok_or_else(|| {
                payload_too_large(Operation::Decode, "WINDOW_ACK missing sequence offset")
            })?)
            .ok_or_else(|| {
                payload_too_large(Operation::Decode, "WINDOW_ACK missing sequence offset")
            })?;
        missing_sequences.push(cursor.u32_le(offset)?);
    }
    Ok(EncryptedUploadV2Transfer::WindowAck(WindowAckV2 {
        common,
        window_index: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_WINDOW_INDEX_OFFSET)?,
        highest_contiguous_sequence: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_HIGHEST_CONTIGUOUS_SEQUENCE_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_PREFIX_SHA256_OFFSET,
        )?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_CHECKPOINT_REVISION_OFFSET)?,
        missing_sequences,
    }))
}

fn decode_manifest_chunk<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MINIMUM_LENGTH)?;
    ensure_frame_limit(cursor.len(), Operation::Decode)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_RESERVED_WIDTH,
        )?,
        "MANIFEST_CHUNK reserved bytes",
    )?;
    let total_manifest_length =
        cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_TOTAL_MANIFEST_LENGTH_OFFSET)?;
    require_declared_length(
        usize::from(total_manifest_length),
        protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH,
        "manifest total length",
    )?;
    let chunk_offset =
        cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_OFFSET_OFFSET)?;
    let chunk_length = usize::from(
        cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_LENGTH_OFFSET)?,
    );
    if chunk_length == 0 {
        return Err(invalid_decode("MANIFEST_CHUNK must not be empty"));
    }
    let expected = checked_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MINIMUM_LENGTH,
        chunk_length,
        1,
    )?;
    require_dynamic_exact(cursor, expected)?;
    let chunk_end = usize::from(chunk_offset)
        .checked_add(chunk_length)
        .ok_or_else(|| payload_too_large(Operation::Decode, "MANIFEST_CHUNK range"))?;
    if chunk_end > usize::from(total_manifest_length) {
        return Err(payload_too_large(
            Operation::Decode,
            "MANIFEST_CHUNK exceeds manifest length",
        ));
    }
    Ok(EncryptedUploadV2Transfer::ManifestChunk(ManifestChunkV2 {
        common,
        total_manifest_length,
        chunk_offset,
        manifest_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MANIFEST_SHA256_OFFSET,
        )?,
        chunk: cursor.tail(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_OFFSET)?,
    }))
}

fn decode_eof<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_EOF_FIXED_LENGTH)?;
    Ok(EncryptedUploadV2Transfer::Eof(EofV2 {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_EOF)?,
        final_sequence: cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_EOF_FINAL_SEQUENCE_OFFSET)?,
        block_count: cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_EOF_BLOCK_COUNT_OFFSET)?,
        ciphertext_length: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_EOF_CIPHERTEXT_LENGTH_OFFSET)?,
        ciphertext_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_EOF_CIPHERTEXT_SHA256_OFFSET,
        )?,
        manifest_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_EOF_MANIFEST_SHA256_OFFSET,
        )?,
    }))
}

fn decode_resume<'a>(
    cursor: &Cursor<'a>,
    accepted: bool,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_RESUME_FIXED_LENGTH)?;
    let expected = if accepted {
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_ACCEPT
    } else {
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST
    };
    let value = ResumeV2 {
        common: decode_common(cursor, expected)?,
        upload_session_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_UPLOAD_SESSION_UUID_OFFSET,
        )?,
        recording_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_RECORDING_UUID_OFFSET,
        )?,
        recording_generation: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_RECORDING_GENERATION_OFFSET)?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_CHECKPOINT_REVISION_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_PREFIX_SHA256_OFFSET,
        )?,
        window_packets: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_WINDOW_PACKETS_OFFSET)?,
        data_payload_bytes: cursor
            .u16_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_DATA_PAYLOAD_BYTES_OFFSET)?,
    };
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Decode,
    )?;
    Ok(if accepted {
        EncryptedUploadV2Transfer::ResumeAccept(value)
    } else {
        EncryptedUploadV2Transfer::ResumeRequest(value)
    })
}

fn decode_resume_reject<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_FIXED_LENGTH)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_RESERVED_WIDTH,
        )?,
        "RESUME_REJECT reserved bytes",
    )?;
    Ok(EncryptedUploadV2Transfer::ResumeReject(ResumeRejectV2 {
        common,
        reason: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_REASON_OFFSET)?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_CHECKPOINT_REVISION_OFFSET)?,
        next_ciphertext_offset: cursor
            .u64_le(protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_NEXT_CIPHERTEXT_OFFSET_OFFSET)?,
        prefix_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_PREFIX_SHA256_OFFSET,
        )?,
    }))
}

fn decode_confirm<'a>(
    cursor: &Cursor<'a>,
) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_FIXED_LENGTH)?;
    Ok(EncryptedUploadV2Transfer::Confirm(ConfirmV2 {
        common: decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_CONFIRM)?,
        upload_session_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_UPLOAD_SESSION_UUID_OFFSET,
        )?,
        recording_uuid: fixed::<16>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECORDING_UUID_OFFSET,
        )?,
        recording_generation: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECORDING_GENERATION_OFFSET)?,
        owner_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_OWNER_REVISION_OFFSET)?,
        receipt_sha256: fixed::<32>(
            cursor,
            protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECEIPT_SHA256_OFFSET,
        )?,
    }))
}

fn decode_abort<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_ABORT_FIXED_LENGTH)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_ABORT)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_ABORT_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_ABORT_RESERVED_WIDTH,
        )?,
        "ABORT reserved bytes",
    )?;
    Ok(EncryptedUploadV2Transfer::Abort {
        common,
        reason: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_ABORT_REASON_OFFSET)?,
    })
}

fn decode_error<'a>(cursor: &Cursor<'a>) -> Result<EncryptedUploadV2Transfer<'a>, DeviceSdkError> {
    cursor.require_exact(protocol::ENCRYPTED_UPLOAD_V2_ERROR_FIXED_LENGTH)?;
    let common = decode_common(cursor, protocol::ENCRYPTED_UPLOAD_V2_ERROR)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_ERROR_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_ERROR_RESERVED_WIDTH,
        )?,
        "ERROR reserved byte",
    )?;
    Ok(EncryptedUploadV2Transfer::Error {
        common,
        result: cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_ERROR_ERROR_OFFSET)?,
        failed_message_type: cursor
            .u8(protocol::ENCRYPTED_UPLOAD_V2_ERROR_FAILED_MESSAGE_TYPE_OFFSET)?,
        checkpoint_revision: cursor
            .u32_le(protocol::ENCRYPTED_UPLOAD_V2_ERROR_CHECKPOINT_REVISION_OFFSET)?,
    })
}

fn encode_start(value: &StartV2) -> Result<Vec<u8>, DeviceSdkError> {
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Encode,
    )?;
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_START,
        protocol::ENCRYPTED_UPLOAD_V2_START_FIXED_LENGTH,
    )?;
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_UPLOAD_SESSION_UUID_OFFSET,
        &value.upload_session_uuid,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_RECORDING_UUID_OFFSET,
        &value.recording_uuid,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_RECORDING_GENERATION_OFFSET,
        value.recording_generation,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_AUTHORIZATION_SHA256_OFFSET,
        &value.authorization_sha256,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_WINDOW_PACKETS_OFFSET,
        value.window_packets,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_DATA_PAYLOAD_BYTES_OFFSET,
        value.data_payload_bytes,
    );
    Ok(bytes)
}

fn encode_start_ack(value: &StartAckV2) -> Result<Vec<u8>, DeviceSdkError> {
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Encode,
    )?;
    if value.checkpoint_interval_blocks == 0 {
        return Err(invalid_encode(
            "START_ACK checkpoint interval must be nonzero",
        ));
    }
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_FIXED_LENGTH,
    )?;
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_UPLOAD_SESSION_UUID_OFFSET,
        &value.upload_session_uuid,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_RECORDING_UUID_OFFSET,
        &value.recording_uuid,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_RECORDING_GENERATION_OFFSET,
        value.recording_generation,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CIPHERTEXT_LENGTH_OFFSET,
        value.ciphertext_length,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CIPHERTEXT_SHA256_OFFSET,
        &value.ciphertext_sha256,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_WINDOW_PACKETS_OFFSET,
        value.window_packets,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_DATA_PAYLOAD_BYTES_OFFSET,
        value.data_payload_bytes,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CHECKPOINT_INTERVAL_BLOCKS_OFFSET,
        value.checkpoint_interval_blocks,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_START_ACK_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    Ok(bytes)
}

fn encode_data(
    common: &CommonHeaderV2,
    sequence: u32,
    offset: u64,
    data: &[u8],
) -> Result<Vec<u8>, DeviceSdkError> {
    if data.is_empty() {
        return Err(invalid_encode("DATA payload must not be empty"));
    }
    let payload_length = u16::try_from(data.len())
        .map_err(|_| payload_too_large(Operation::Encode, "DATA payload length"))?;
    offset
        .checked_add(u64::from(payload_length))
        .ok_or_else(|| payload_too_large(Operation::Encode, "DATA ciphertext range"))?;
    let length = checked_encode_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH,
        data.len(),
        1,
    )?;
    ensure_frame_limit(length, Operation::Encode)?;
    let mut bytes = encode_common_fixed(common, protocol::ENCRYPTED_UPLOAD_V2_DATA, length)?;
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_DATA_SEQUENCE_OFFSET,
        sequence,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_DATA_CIPHERTEXT_OFFSET_OFFSET,
        offset,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_DATA_PAYLOAD_LENGTH_OFFSET,
        payload_length,
    );
    bytes[protocol::ENCRYPTED_UPLOAD_V2_DATA_PAYLOAD_OFFSET..].copy_from_slice(data);
    Ok(bytes)
}

fn encode_window_end(value: &WindowEndV2) -> Result<Vec<u8>, DeviceSdkError> {
    if value.first_sequence > value.last_sequence {
        return Err(invalid_encode(
            "WINDOW_END first sequence exceeds last sequence",
        ));
    }
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_FIXED_LENGTH,
    )?;
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_WINDOW_INDEX_OFFSET,
        value.window_index,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_FIRST_SEQUENCE_OFFSET,
        value.first_sequence,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_LAST_SEQUENCE_OFFSET,
        value.last_sequence,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    Ok(bytes)
}

fn encode_window_ack(value: &WindowAckV2) -> Result<Vec<u8>, DeviceSdkError> {
    let count = u16::try_from(value.missing_sequences.len())
        .map_err(|_| payload_too_large(Operation::Encode, "WINDOW_ACK missing sequence count"))?;
    let length = checked_encode_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH,
        value.missing_sequences.len(),
        4,
    )?;
    ensure_frame_limit(length, Operation::Encode)?;
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK,
        length,
    )?;
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_WINDOW_INDEX_OFFSET,
        value.window_index,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_HIGHEST_CONTIGUOUS_SEQUENCE_OFFSET,
        value.highest_contiguous_sequence,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MISSING_COUNT_OFFSET,
        count,
    );
    for (index, sequence) in value.missing_sequences.iter().enumerate() {
        let offset = protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MISSING_SEQUENCES_OFFSET + index * 4;
        put_u32(&mut bytes, offset, *sequence);
    }
    Ok(bytes)
}

fn encode_manifest_chunk(value: &ManifestChunkV2<'_>) -> Result<Vec<u8>, DeviceSdkError> {
    if usize::from(value.total_manifest_length) != protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH {
        return Err(invalid_encode("manifest total length is not canonical"));
    }
    if value.chunk.is_empty() {
        return Err(invalid_encode("MANIFEST_CHUNK must not be empty"));
    }
    let chunk_length = u16::try_from(value.chunk.len())
        .map_err(|_| payload_too_large(Operation::Encode, "MANIFEST_CHUNK length"))?;
    let chunk_end = usize::from(value.chunk_offset)
        .checked_add(value.chunk.len())
        .ok_or_else(|| payload_too_large(Operation::Encode, "MANIFEST_CHUNK range"))?;
    if chunk_end > usize::from(value.total_manifest_length) {
        return Err(payload_too_large(
            Operation::Encode,
            "MANIFEST_CHUNK exceeds manifest length",
        ));
    }
    let length = checked_encode_frame_length(
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MINIMUM_LENGTH,
        value.chunk.len(),
        1,
    )?;
    ensure_frame_limit(length, Operation::Encode)?;
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK,
        length,
    )?;
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_TOTAL_MANIFEST_LENGTH_OFFSET,
        value.total_manifest_length,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_OFFSET_OFFSET,
        value.chunk_offset,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_LENGTH_OFFSET,
        chunk_length,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MANIFEST_SHA256_OFFSET,
        &value.manifest_sha256,
    );
    bytes[protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_CHUNK_OFFSET..].copy_from_slice(value.chunk);
    Ok(bytes)
}

fn encode_eof(value: &EofV2) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_EOF,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_FIXED_LENGTH,
    )?;
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_FINAL_SEQUENCE_OFFSET,
        value.final_sequence,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_BLOCK_COUNT_OFFSET,
        value.block_count,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_CIPHERTEXT_LENGTH_OFFSET,
        value.ciphertext_length,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_CIPHERTEXT_SHA256_OFFSET,
        &value.ciphertext_sha256,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_EOF_MANIFEST_SHA256_OFFSET,
        &value.manifest_sha256,
    );
    Ok(bytes)
}

fn encode_resume(value: &ResumeV2, accepted: bool) -> Result<Vec<u8>, DeviceSdkError> {
    require_window_bounds(
        value.window_packets,
        value.data_payload_bytes,
        Operation::Encode,
    )?;
    let message = if accepted {
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_ACCEPT
    } else {
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST
    };
    let mut bytes = encode_common_fixed(
        &value.common,
        message,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_FIXED_LENGTH,
    )?;
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_UPLOAD_SESSION_UUID_OFFSET,
        &value.upload_session_uuid,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_RECORDING_UUID_OFFSET,
        &value.recording_uuid,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_RECORDING_GENERATION_OFFSET,
        value.recording_generation,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_WINDOW_PACKETS_OFFSET,
        value.window_packets,
    );
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_DATA_PAYLOAD_BYTES_OFFSET,
        value.data_payload_bytes,
    );
    Ok(bytes)
}

fn encode_resume_reject(value: &ResumeRejectV2) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_FIXED_LENGTH,
    )?;
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_REASON_OFFSET,
        value.reason,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_CHECKPOINT_REVISION_OFFSET,
        value.checkpoint_revision,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_NEXT_CIPHERTEXT_OFFSET_OFFSET,
        value.next_ciphertext_offset,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_RESUME_REJECT_PREFIX_SHA256_OFFSET,
        &value.prefix_sha256,
    );
    Ok(bytes)
}

fn encode_confirm(value: &ConfirmV2) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = encode_common_fixed(
        &value.common,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_FIXED_LENGTH,
    )?;
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_UPLOAD_SESSION_UUID_OFFSET,
        &value.upload_session_uuid,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECORDING_UUID_OFFSET,
        &value.recording_uuid,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECORDING_GENERATION_OFFSET,
        value.recording_generation,
    );
    put_u32(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_OWNER_REVISION_OFFSET,
        value.owner_revision,
    );
    put_fixed(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_CONFIRM_RECEIPT_SHA256_OFFSET,
        &value.receipt_sha256,
    );
    Ok(bytes)
}

fn decode_blob_prefix(cursor: &Cursor<'_>) -> Result<(u8, u32), DeviceSdkError> {
    require_version(
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_VERSION_OFFSET)?,
        protocol::ENCRYPTED_UPLOAD_V2_DOCUMENT_VERSION,
        "signed blob version",
    )?;
    let kind = cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_KIND_OFFSET)?;
    signed_document_length(kind, Operation::Decode)?;
    require_zero(
        cursor.slice(
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_RESERVED_OFFSET,
            protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_RESERVED_WIDTH,
        )?,
        "signed blob reserved byte",
    )?;
    Ok((
        kind,
        cursor.u32_le(protocol::ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_WRITE_ID_OFFSET)?,
    ))
}

fn signed_document_length(kind: u8, operation: Operation) -> Result<usize, DeviceSdkError> {
    match kind {
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION => {
            Ok(protocol::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH)
        }
        protocol::ENCRYPTED_UPLOAD_V2_BLOB_KIND_RECEIPT => {
            Ok(protocol::COMPLETION_RECEIPT_V2_FIXED_LENGTH)
        }
        _ if operation == Operation::Decode => Err(unknown_decode(kind, "signed blob kind")),
        _ => Err(invalid_encode("unknown signed blob kind")),
    }
}

fn decode_common(
    cursor: &Cursor<'_>,
    expected_message: u8,
) -> Result<CommonHeaderV2, DeviceSdkError> {
    cursor.require(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FIXED_LENGTH)?;
    let message_type =
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_MESSAGE_TYPE_OFFSET)?;
    if message_type != expected_message {
        return Err(unknown_decode(message_type, "transfer message"));
    }
    require_version(
        cursor.u8(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_PROTOCOL_VERSION_OFFSET)?,
        protocol::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION,
        "transfer protocol version",
    )?;
    let flags = cursor.u16_le(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FLAGS_OFFSET)?;
    require_known_bits(u32::from(flags), 0, "transfer message flags")?;
    let transport_session_id =
        cursor.u64_le(protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_SESSION_ID_OFFSET)?;
    if transport_session_id == 0 {
        return Err(invalid_decode("transport session ID must be nonzero"));
    }
    Ok(CommonHeaderV2 {
        message_type,
        flags,
        transport_session_id,
    })
}

fn encode_common_fixed(
    common: &CommonHeaderV2,
    expected_message: u8,
    length: usize,
) -> Result<Vec<u8>, DeviceSdkError> {
    if common.message_type != expected_message {
        return Err(invalid_encode("transfer variant and message type disagree"));
    }
    if common.flags != 0 {
        return Err(invalid_encode("transfer message has unknown flags"));
    }
    if common.transport_session_id == 0 {
        return Err(invalid_encode("transport session ID must be nonzero"));
    }
    let mut bytes = vec![0_u8; length];
    bytes[protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_MESSAGE_TYPE_OFFSET] = expected_message;
    bytes[protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_PROTOCOL_VERSION_OFFSET] =
        protocol::ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION;
    put_u16(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FLAGS_OFFSET,
        common.flags,
    );
    put_u64(
        &mut bytes,
        protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_SESSION_ID_OFFSET,
        common.transport_session_id,
    );
    Ok(bytes)
}

fn require_window_bounds(
    window_packets: u16,
    data_payload_bytes: u16,
    operation: Operation,
) -> Result<(), DeviceSdkError> {
    if window_packets == 0 || data_payload_bytes == 0 {
        let detail = "window packets and DATA payload bytes must be nonzero";
        return Err(if operation == Operation::Encode {
            invalid_encode(detail)
        } else {
            invalid_decode(detail)
        });
    }
    Ok(())
}

fn require_zero(bytes: &[u8], field: &'static str) -> Result<(), DeviceSdkError> {
    if bytes.iter().any(|byte| *byte != 0) {
        return Err(invalid_decode(format!("{field} must be zero")));
    }
    Ok(())
}

fn require_known_bits(value: u32, known: u32, field: &'static str) -> Result<(), DeviceSdkError> {
    if value & !known != 0 {
        return Err(invalid_decode(format!("{field} contains unknown bits")));
    }
    Ok(())
}

fn fixed<const N: usize>(cursor: &Cursor<'_>, offset: usize) -> Result<[u8; N], DeviceSdkError> {
    Ok(cursor
        .slice(offset, N)?
        .try_into()
        .expect("slice length is checked"))
}

fn checked_frame_length(base: usize, count: usize, width: usize) -> Result<usize, DeviceSdkError> {
    count
        .checked_mul(width)
        .and_then(|tail| base.checked_add(tail))
        .ok_or_else(|| payload_too_large(Operation::Decode, "frame length arithmetic"))
}

fn checked_encode_frame_length(
    base: usize,
    count: usize,
    width: usize,
) -> Result<usize, DeviceSdkError> {
    count
        .checked_mul(width)
        .and_then(|tail| base.checked_add(tail))
        .ok_or_else(|| payload_too_large(Operation::Encode, "frame length arithmetic"))
}

fn require_dynamic_exact(cursor: &Cursor<'_>, expected: usize) -> Result<(), DeviceSdkError> {
    cursor.require(expected)?;
    if cursor.len() != expected {
        return Err(invalid_decode(format!(
            "packet declares {expected} bytes but has {}",
            cursor.len()
        )));
    }
    Ok(())
}

fn require_version(actual: u8, expected: u8, field: &'static str) -> Result<(), DeviceSdkError> {
    if actual != expected {
        return Err(unknown_decode(actual, field));
    }
    Ok(())
}

fn require_declared_length(
    actual: usize,
    expected: usize,
    field: &'static str,
) -> Result<(), DeviceSdkError> {
    if actual != expected {
        return Err(invalid_decode(format!(
            "{field} must be {expected} but is {actual}"
        )));
    }
    Ok(())
}

fn ensure_frame_limit(length: usize, operation: Operation) -> Result<(), DeviceSdkError> {
    if length > protocol::MAX_MTU {
        return Err(payload_too_large(operation, "frame exceeds maximum MTU"));
    }
    Ok(())
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn put_fixed<const N: usize>(bytes: &mut [u8], offset: usize, value: &[u8; N]) {
    bytes[offset..offset + N].copy_from_slice(value);
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn invalid_decode(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}

fn invalid_encode(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false).with_detail(detail)
}

fn unknown_decode(value: u8, field: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
        .with_protocol_status(u16::from(value))
        .with_detail(format!("unknown {field} {value}"))
}

fn payload_too_large(operation: Operation, detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::PayloadTooLarge, operation, false).with_detail(detail)
}
