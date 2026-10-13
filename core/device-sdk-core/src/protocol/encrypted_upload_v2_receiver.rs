//! Shared batch-v2 receive policy. Ports perform only bounded file I/O and
//! hashing; this state machine decides repair, durability, ACK and completion.
//! The session coordinator still owns admission, ownership and receipt/CONFIRM.
//! Marker header/context checks prove consistent reassembly, not device origin
//! or cryptographic authority; the admitted backend verifies those separately.

use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    CommonHeaderV2, EncryptedUploadV2Transfer, EofV2, ManifestChunkV2, MarkerChunkV2,
    MarkerDocumentAssembler, WindowAckV2, WindowEndV2, decode_encrypted_upload_v2_transfer,
    encode_encrypted_upload_v2_transfer,
};
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    workflow::EncryptedUploadV2TransferEvidence,
};

const MAXIMUM_BUFFERED_BYTES: usize = 1024 * 1024;
const PACKET_METADATA_BYTES: usize = 80;
// Decimal byte arrays in the private JSON bridge must fit its 1 MiB limit.
const MAXIMUM_APPEND_BYTES: usize = 64 * 1024;
const MAXIMUM_MARKER_DOCUMENT_BYTES: u32 = 402;

/// The packet sequence is historical durable evidence, never the baseline of a
/// newly admitted transport attempt. Every receiver starts its DATA count at 1.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2ReceiverCheckpoint {
    pub revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub highest_contiguous_sequence: Option<u32>,
}

impl EncryptedUploadV2ReceiverCheckpoint {
    pub fn initial() -> Self {
        Self {
            revision: 0,
            next_ciphertext_offset: 0,
            prefix_sha256: Sha256::digest([]).into(),
            highest_contiguous_sequence: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2ReceiverConfig {
    pub transport_session_id: u64,
    pub expected_ciphertext_length: u64,
    pub expected_ciphertext_sha256: [u8; 32],
    pub maximum_data_payload_bytes: u16,
    pub maximum_window_packets: u16,
    pub maximum_missing_sequences: u16,
    pub checkpoint: EncryptedUploadV2ReceiverCheckpoint,
    #[serde(default)]
    pub markers_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2ReceiverMarkerEvidence {
    pub document_count: u32,
    /// SHA-256 of the exact documents concatenated in transfer order.
    pub documents_sha256: [u8; 32],
}

/// Exactly one I/O request is outstanding. A port must echo its ID, and a
/// successful Applied means the exact requested write or durable journal save
/// completed. Cancellation retires the request before any late result is read.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EncryptedUploadV2ReceiverEvent {
    SinkProof {
        request_id: u64,
        byte_length: u64,
        prefix_sha256: [u8; 32],
    },
    Applied {
        request_id: u64,
    },
    Failed {
        request_id: u64,
        error: DeviceSdkError,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EncryptedUploadV2ReceiverAction {
    None,
    /// Hash exactly prefix_length bytes. When flush is true, synchronize all
    /// preceding ciphertext writes before returning the proof and file length.
    InspectSink {
        request_id: u64,
        prefix_length: u64,
        flush: bool,
    },
    /// Only emitted after the retained prefix was proved. Unacknowledged tails
    /// never authorize clearing or replacing a durable checkpoint.
    TruncateSink {
        request_id: u64,
        length: u64,
    },
    AppendCiphertext {
        request_id: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    PersistCheckpoint {
        request_id: u64,
        checkpoint: EncryptedUploadV2ReceiverCheckpoint,
    },
    /// Applied acknowledges durable retention of this exact opaque document.
    /// Ports retain by index/hash under the admitted scope and accept exact
    /// START/RESUME replay idempotently. Admission and both final receipts
    /// remain session-coordinator decisions.
    AppendMarkerDocument {
        request_id: u64,
        document_index: u32,
        document_count: u32,
        document_sha256: [u8; 32],
        document: Vec<u8>,
    },
    Control {
        frame: Vec<u8>,
    },
    /// Transport integrity evidence, not backend commitment or deletion proof.
    Complete {
        manifest: Vec<u8>,
        evidence: EncryptedUploadV2TransferEvidence,
        marker_evidence: Option<EncryptedUploadV2ReceiverMarkerEvidence>,
    },
}

#[derive(Debug)]
struct Packet {
    offset: u64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct PacketFingerprint {
    offset: u64,
    length: usize,
    sha256: [u8; 32],
}

#[derive(Debug)]
struct PendingWindow {
    boundary: WindowEndV2,
    missing: Vec<u32>,
    highest: u32,
    contiguous_offset: u64,
}

#[derive(Clone, Copy, Debug)]
enum IoPurpose {
    InitialProof,
    InitialTruncate,
    WindowAppend { next_offset: u64 },
    WindowProof,
    WindowPersist,
    MarkerPersist,
    FinalProof(EofV2),
}

#[derive(Debug)]
struct PendingIo {
    request_id: u64,
    purpose: IoPurpose,
}

struct MarkerSlot {
    index: u32,
    length: u16,
    sha256: [u8; 32],
    header: Vec<u8>,
    assembler: Option<MarkerDocumentAssembler>,
}

impl fmt::Debug for MarkerSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MarkerSlot")
            .field("index", &self.index)
            .field("length", &self.length)
            .finish_non_exhaustive()
    }
}

impl MarkerSlot {
    fn push(&mut self, session: u64, value: &MarkerChunkV2<'_>) -> Result<bool, DeviceSdkError> {
        if let Some(assembler) = &mut self.assembler {
            return assembler.push(
                session,
                self.index + 1,
                u32::from(value.chunk_offset),
                value.chunk,
            );
        }
        let start = usize::from(value.chunk_offset);
        let end = start + value.chunk.len();
        if start < self.header.len() {
            if end > self.header.len() || self.header[start..end] != *value.chunk {
                return Err(failure(
                    ErrorCode::IntegrityFailed,
                    "conflicting v2 marker header duplicate",
                ));
            }
            return Ok(false);
        }
        if start != self.header.len() {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "noncontiguous v2 marker header",
            ));
        }
        self.header.extend_from_slice(value.chunk);
        if self.header.len() < protocol::RECORDING_MARKER_HEADER_LENGTH {
            return Ok(false);
        }
        let request_offset = protocol::RECORDING_MARKER_HEADER_REQUEST_UUID_OFFSET;
        let context_offset = protocol::RECORDING_MARKER_HEADER_CONTEXT_DIGEST_OFFSET;
        let request_uuid = self.header[request_offset..request_offset + 16]
            .try_into()
            .expect("complete marker header");
        let context_digest = self.header[context_offset..context_offset + 32]
            .try_into()
            .expect("complete marker header");
        let expected_kind = if self.index == 0 {
            protocol::RECORDING_MARKER_SEAL
        } else {
            protocol::RECORDING_MARKER_PAGE
        };
        let mut assembler = MarkerDocumentAssembler::new(
            session,
            self.index + 1,
            expected_kind,
            u32::from(self.length),
            MAXIMUM_MARKER_DOCUMENT_BYTES,
            request_uuid,
            context_digest,
        )?;
        let complete = assembler.push(session, self.index + 1, 0, &self.header)?;
        self.header.clear();
        self.assembler = Some(assembler);
        Ok(complete)
    }

    fn document(&self) -> Option<&[u8]> {
        self.assembler
            .as_ref()
            .and_then(MarkerDocumentAssembler::document)
    }
}

#[derive(Debug)]
pub struct EncryptedUploadV2Receiver {
    config: EncryptedUploadV2ReceiverConfig,
    checkpoint: EncryptedUploadV2ReceiverCheckpoint,
    highest_sequence: Option<u32>,
    packets: BTreeMap<u32, Packet>,
    buffered_bytes: usize,
    staged_offset: u64,
    pending_window: Option<PendingWindow>,
    acknowledged_window: Option<WindowEndV2>,
    acknowledged_packets: BTreeMap<u32, PacketFingerprint>,
    manifest: Vec<u8>,
    manifest_present: Vec<bool>,
    manifest_sha256: Option<[u8; 32]>,
    marker_count: Option<u32>,
    marker_documents_persisted: u32,
    marker_slot: Option<MarkerSlot>,
    marker_documents_hash: Sha256,
    marker_context_digest: Option<[u8; 32]>,
    io: Option<PendingIo>,
    next_request_id: u64,
    started: bool,
    prepared: bool,
    terminal: bool,
    cancelled: bool,
}

impl EncryptedUploadV2Receiver {
    #[cfg_attr(target_arch = "wasm32", inline(never))]
    pub fn new(config: EncryptedUploadV2ReceiverConfig) -> Result<Self, DeviceSdkError> {
        let checkpoint = &config.checkpoint;
        let maximum_missing =
            (protocol::MAX_MTU - protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH) / 4;
        if config.transport_session_id == 0
            || config.expected_ciphertext_length == 0
            || config.maximum_data_payload_bytes == 0
            || usize::from(config.maximum_data_payload_bytes)
                > protocol::MAX_MTU - protocol::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH
            || config.maximum_window_packets == 0
            || config.maximum_missing_sequences == 0
            || usize::from(config.maximum_missing_sequences) > maximum_missing
            || checkpoint.next_ciphertext_offset > config.expected_ciphertext_length
            || ((checkpoint.next_ciphertext_offset == 0)
                != checkpoint.highest_contiguous_sequence.is_none())
            || ((checkpoint.next_ciphertext_offset == 0) != (checkpoint.revision == 0))
            || (checkpoint.next_ciphertext_offset == 0
                && checkpoint.prefix_sha256
                    != EncryptedUploadV2ReceiverCheckpoint::initial().prefix_sha256)
        {
            return Err(failure(
                ErrorCode::InvalidInput,
                "invalid v2 receiver configuration",
            ));
        }
        Ok(Self {
            checkpoint: config.checkpoint.clone(),
            staged_offset: config.checkpoint.next_ciphertext_offset,
            config,
            highest_sequence: None,
            packets: BTreeMap::new(),
            buffered_bytes: 0,
            pending_window: None,
            acknowledged_window: None,
            acknowledged_packets: BTreeMap::new(),
            manifest: vec![0; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH],
            manifest_present: vec![false; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH],
            manifest_sha256: None,
            marker_count: None,
            marker_documents_persisted: 0,
            marker_slot: None,
            marker_documents_hash: Sha256::new(),
            marker_context_digest: None,
            io: None,
            next_request_id: 1,
            started: false,
            prepared: false,
            terminal: false,
            cancelled: false,
        })
    }

    pub fn checkpoint(&self) -> &EncryptedUploadV2ReceiverCheckpoint {
        &self.checkpoint
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    #[cfg_attr(target_arch = "wasm32", inline(never))]
    pub fn start(&mut self) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        self.require_active()?;
        if self.started {
            return Err(failure(
                ErrorCode::UnexpectedEvent,
                "v2 receiver already started",
            ));
        }
        self.started = true;
        let request_id = self.request(IoPurpose::InitialProof)?;
        Ok(EncryptedUploadV2ReceiverAction::InspectSink {
            request_id,
            prefix_length: self.checkpoint.next_ciphertext_offset,
            flush: false,
        })
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.terminal = true;
        self.io = None;
        self.packets.clear();
        self.buffered_bytes = 0;
        self.pending_window = None;
        self.marker_slot = None;
    }

    #[cfg_attr(target_arch = "wasm32", inline(never))]
    pub fn receive(
        &mut self,
        bytes: &[u8],
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        self.require_active()?;
        if self.io.is_some() {
            return Err(failure(
                ErrorCode::OperationInProgress,
                "v2 receiver I/O is pending",
            ));
        }
        if !self.prepared {
            return Err(failure(
                ErrorCode::UnexpectedEvent,
                "v2 receiver is not prepared",
            ));
        }
        let result = self.receive_inner(bytes);
        self.finish_result(result)
    }

    #[cfg_attr(target_arch = "wasm32", inline(never))]
    pub fn apply(
        &mut self,
        event: EncryptedUploadV2ReceiverEvent,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        self.require_active()?;
        let request_id = match &event {
            EncryptedUploadV2ReceiverEvent::SinkProof { request_id, .. }
            | EncryptedUploadV2ReceiverEvent::Applied { request_id }
            | EncryptedUploadV2ReceiverEvent::Failed { request_id, .. } => *request_id,
        };
        if self.io.as_ref().map(|io| io.request_id) != Some(request_id) {
            // Stale callbacks must not consume a newer outstanding request.
            return Err(failure(
                ErrorCode::UnexpectedEvent,
                "v2 receiver I/O request mismatch",
            ));
        }
        let purpose = self.io.take().expect("matched outstanding request").purpose;
        let result = self.apply_inner(purpose, event);
        self.finish_result(result)
    }

    fn receive_inner(
        &mut self,
        bytes: &[u8],
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let frame = decode_encrypted_upload_v2_transfer(bytes)?;
        let common = match &frame {
            EncryptedUploadV2Transfer::Data { common, .. }
            | EncryptedUploadV2Transfer::Error { common, .. } => *common,
            EncryptedUploadV2Transfer::WindowEnd(value) => value.common,
            EncryptedUploadV2Transfer::ManifestChunk(value) => value.common,
            EncryptedUploadV2Transfer::MarkerChunk(value) => value.common,
            EncryptedUploadV2Transfer::Eof(value) => value.common,
            _ => {
                return Err(failure(
                    ErrorCode::ProtocolRejected,
                    "unexpected v2 receiver message",
                ));
            }
        };
        if common.transport_session_id != self.config.transport_session_id {
            return Err(failure(
                ErrorCode::IdentityMismatch,
                "v2 transport session mismatch",
            ));
        }
        match frame {
            EncryptedUploadV2Transfer::Data {
                sequence,
                offset,
                data,
                ..
            } => self.receive_data(sequence, offset, data),
            EncryptedUploadV2Transfer::WindowEnd(value) => self.receive_window(value),
            EncryptedUploadV2Transfer::ManifestChunk(value) => self.receive_manifest(value),
            EncryptedUploadV2Transfer::MarkerChunk(value) => self.receive_marker(value),
            EncryptedUploadV2Transfer::Eof(value) => self.receive_eof(value),
            EncryptedUploadV2Transfer::Error { result, .. } => Err(failure(
                ErrorCode::ProtocolRejected,
                "v2 device rejected transfer",
            )
            .with_protocol_status(result)),
            _ => unreachable!("only receiver variants passed admission"),
        }
    }

    fn receive_data(
        &mut self,
        sequence: u32,
        offset: u64,
        data: &[u8],
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if let Some(previous) = self.acknowledged_packets.get(&sequence) {
            if previous.offset == offset
                && previous.length == data.len()
                && equal_hash(&previous.sha256, &Sha256::digest(data).into())
            {
                return Ok(EncryptedUploadV2ReceiverAction::None);
            }
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "conflicting acknowledged v2 DATA duplicate",
            ));
        }
        let end = offset
            .checked_add(data.len() as u64)
            .ok_or_else(|| failure(ErrorCode::PayloadTooLarge, "v2 DATA offset overflow"))?;
        let first = self
            .highest_sequence
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| failure(ErrorCode::ProtocolRejected, "v2 sequence exhausted"))?;
        if data.is_empty()
            || data.len() > usize::from(self.config.maximum_data_payload_bytes)
            || offset < self.checkpoint.next_ciphertext_offset
            || end > self.config.expected_ciphertext_length
            || sequence < first
            || u64::from(sequence)
                >= u64::from(first) + u64::from(self.config.maximum_window_packets)
            || self.manifest_sha256.is_some()
        {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "v2 DATA exceeds admitted bounds",
            ));
        }
        if let Some(existing) = self.packets.get(&sequence) {
            if existing.offset != offset || existing.bytes != data {
                return Err(failure(
                    ErrorCode::IntegrityFailed,
                    "conflicting v2 DATA duplicate",
                ));
            }
            return Ok(EncryptedUploadV2ReceiverAction::None);
        }
        if let Some(pending) = &self.pending_window
            && (pending.missing.is_empty()
                || !pending.missing.contains(&sequence)
                || end > pending.boundary.next_ciphertext_offset)
        {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "v2 DATA is not requested repair",
            ));
        }
        if self.packets.len() >= usize::from(self.config.maximum_window_packets)
            || self.buffered_bytes + data.len() + PACKET_METADATA_BYTES > MAXIMUM_BUFFERED_BYTES
            || self.packets.values().any(|packet| {
                offset < packet.offset + packet.bytes.len() as u64 && packet.offset < end
            })
        {
            return Err(failure(
                ErrorCode::PayloadTooLarge,
                "v2 DATA window overlaps or exceeds buffer bound",
            ));
        }
        self.buffered_bytes += data.len() + PACKET_METADATA_BYTES;
        self.packets.insert(
            sequence,
            Packet {
                offset,
                bytes: data.to_vec(),
            },
        );
        Ok(EncryptedUploadV2ReceiverAction::None)
    }

    fn receive_window(
        &mut self,
        value: WindowEndV2,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if self.acknowledged_window == Some(value) {
            return self.ack(
                value,
                value.last_sequence,
                self.checkpoint.next_ciphertext_offset,
                self.checkpoint.prefix_sha256,
                self.checkpoint.revision,
                Vec::new(),
            );
        }
        let first = self.highest_sequence.unwrap_or(0).checked_add(1);
        let span = value
            .last_sequence
            .checked_sub(value.first_sequence)
            .map(|span| u64::from(span) + 1);
        if first != Some(value.first_sequence)
            || span.is_none_or(|span| span > u64::from(self.config.maximum_window_packets))
            || value.checkpoint_revision <= self.checkpoint.revision
            || value.next_ciphertext_offset <= self.checkpoint.next_ciphertext_offset
            || value.next_ciphertext_offset > self.config.expected_ciphertext_length
            || self.manifest_sha256.is_some()
            || self
                .pending_window
                .as_ref()
                .is_some_and(|pending| pending.boundary != value)
            || self.packets.iter().any(|(sequence, packet)| {
                *sequence < value.first_sequence
                    || *sequence > value.last_sequence
                    || packet.offset + packet.bytes.len() as u64 > value.next_ciphertext_offset
            })
        {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "malformed v2 window boundary",
            ));
        }
        let missing: Vec<_> = (value.first_sequence..=value.last_sequence)
            .filter(|sequence| !self.packets.contains_key(sequence))
            .collect();
        if missing.len() > usize::from(self.config.maximum_missing_sequences) {
            return Err(failure(
                ErrorCode::PayloadTooLarge,
                "v2 missing sequence count exceeds admitted bound",
            ));
        }
        let mut contiguous_offset = self.checkpoint.next_ciphertext_offset;
        let mut highest = value.first_sequence - 1;
        for sequence in value.first_sequence..=value.last_sequence {
            let Some(packet) = self.packets.get(&sequence) else {
                break;
            };
            if packet.offset != contiguous_offset {
                return Err(failure(
                    ErrorCode::IntegrityFailed,
                    "noncontiguous v2 DATA offsets",
                ));
            }
            contiguous_offset += packet.bytes.len() as u64;
            if packet.offset < self.staged_offset && contiguous_offset > self.staged_offset {
                return Err(failure(
                    ErrorCode::IntegrityFailed,
                    "v2 staged prefix splits DATA packet",
                ));
            }
            highest = sequence;
        }
        if contiguous_offset < self.staged_offset
            || (missing.is_empty() && contiguous_offset != value.next_ciphertext_offset)
        {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "v2 window prefix length mismatch",
            ));
        }
        self.pending_window = Some(PendingWindow {
            boundary: value,
            missing,
            highest,
            contiguous_offset,
        });
        self.advance_window_io()
    }

    fn receive_manifest(
        &mut self,
        value: ManifestChunkV2<'_>,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let end = usize::from(value.chunk_offset) + value.chunk.len();
        if self.pending_window.is_some()
            || !self.packets.is_empty()
            || self.checkpoint.next_ciphertext_offset != self.config.expected_ciphertext_length
            || usize::from(value.total_manifest_length) != self.manifest.len()
            || value.chunk.is_empty()
            || end > self.manifest.len()
            || self
                .manifest_sha256
                .is_some_and(|hash| !equal_hash(&hash, &value.manifest_sha256))
        {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "v2 manifest framing or phase conflict",
            ));
        }
        for (relative, byte) in value.chunk.iter().enumerate() {
            let index = usize::from(value.chunk_offset) + relative;
            if self.manifest_present[index] && self.manifest[index] != *byte {
                return Err(failure(
                    ErrorCode::IntegrityFailed,
                    "conflicting v2 manifest duplicate",
                ));
            }
            self.manifest[index] = *byte;
            self.manifest_present[index] = true;
        }
        self.manifest_sha256 = Some(value.manifest_sha256);
        Ok(EncryptedUploadV2ReceiverAction::None)
    }

    fn receive_marker(
        &mut self,
        value: MarkerChunkV2<'_>,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if !self.config.markers_required
            || self.pending_window.is_some()
            || !self.packets.is_empty()
            || self.checkpoint.next_ciphertext_offset != self.config.expected_ciphertext_length
            || self.manifest_present.iter().any(|present| !present)
            || self.manifest_sha256 != Some(Sha256::digest(&self.manifest).into())
            || !(2..=4097).contains(&value.document_count)
            || value.document_index != self.marker_documents_persisted
            || value.document_index >= value.document_count
            || self
                .marker_count
                .is_some_and(|count| count != value.document_count)
            || !(200..=MAXIMUM_MARKER_DOCUMENT_BYTES as u16).contains(&value.document_length)
            || value.chunk.is_empty()
            || usize::from(value.chunk_offset) + value.chunk.len()
                > usize::from(value.document_length)
        {
            return Err(failure(
                ErrorCode::ProtocolRejected,
                "v2 marker document bounds, order or phase mismatch",
            ));
        }
        self.marker_count = Some(value.document_count);
        let slot = self.marker_slot.get_or_insert_with(|| MarkerSlot {
            index: value.document_index,
            length: value.document_length,
            sha256: value.document_sha256,
            header: Vec::new(),
            assembler: None,
        });
        if slot.length != value.document_length || !equal_hash(&slot.sha256, &value.document_sha256)
        {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "conflicting v2 marker document metadata",
            ));
        }
        if !slot.push(self.config.transport_session_id, &value)? {
            return Ok(EncryptedUploadV2ReceiverAction::None);
        }
        let document = slot
            .document()
            .expect("shared marker assembler proved completion");
        if !equal_hash(&Sha256::digest(document).into(), &value.document_sha256) {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "v2 marker document hash mismatch",
            ));
        }
        let context_offset = protocol::RECORDING_MARKER_HEADER_CONTEXT_DIGEST_OFFSET;
        let context_digest: [u8; 32] = document[context_offset..context_offset + 32]
            .try_into()
            .expect("shared marker assembler proved header");
        if self
            .marker_context_digest
            .is_some_and(|context| !equal_hash(&context, &context_digest))
        {
            return Err(failure(
                ErrorCode::IdentityMismatch,
                "mixed v2 marker contexts",
            ));
        }
        self.marker_context_digest = Some(context_digest);
        let document = document.to_vec();
        let request_id = self.request(IoPurpose::MarkerPersist)?;
        Ok(EncryptedUploadV2ReceiverAction::AppendMarkerDocument {
            request_id,
            document_index: value.document_index,
            document_count: value.document_count,
            document_sha256: value.document_sha256,
            document,
        })
    }

    fn receive_eof(
        &mut self,
        value: EofV2,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if self.pending_window.is_some()
            || !self.packets.is_empty()
            || (self.config.markers_required
                && (self.marker_count != Some(self.marker_documents_persisted)
                    || self.marker_slot.is_some()))
            || self.highest_sequence.unwrap_or(0) != value.final_sequence
            || value.block_count == 0
            || self.checkpoint.next_ciphertext_offset != self.config.expected_ciphertext_length
            || value.ciphertext_length != self.config.expected_ciphertext_length
            || !equal_hash(
                &value.ciphertext_sha256,
                &self.config.expected_ciphertext_sha256,
            )
            || self.manifest_sha256 != Some(value.manifest_sha256)
            || self.manifest_present.iter().any(|present| !present)
            || !equal_hash(
                &Sha256::digest(&self.manifest).into(),
                &value.manifest_sha256,
            )
        {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "v2 EOF evidence mismatch",
            ));
        }
        let request_id = self.request(IoPurpose::FinalProof(value))?;
        Ok(EncryptedUploadV2ReceiverAction::InspectSink {
            request_id,
            prefix_length: value.ciphertext_length,
            flush: true,
        })
    }

    fn apply_inner(
        &mut self,
        purpose: IoPurpose,
        event: EncryptedUploadV2ReceiverEvent,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if let EncryptedUploadV2ReceiverEvent::Failed { error, .. } = event {
            return Err(error);
        }
        match (purpose, event) {
            (
                IoPurpose::InitialProof,
                EncryptedUploadV2ReceiverEvent::SinkProof {
                    byte_length,
                    prefix_sha256,
                    ..
                },
            ) => {
                if byte_length < self.checkpoint.next_ciphertext_offset
                    || !equal_hash(&prefix_sha256, &self.checkpoint.prefix_sha256)
                {
                    return Err(failure(
                        ErrorCode::IntegrityFailed,
                        "retained v2 ciphertext prefix mismatch",
                    ));
                }
                if byte_length > self.checkpoint.next_ciphertext_offset {
                    let request_id = self.request(IoPurpose::InitialTruncate)?;
                    Ok(EncryptedUploadV2ReceiverAction::TruncateSink {
                        request_id,
                        length: self.checkpoint.next_ciphertext_offset,
                    })
                } else {
                    self.prepared = true;
                    Ok(EncryptedUploadV2ReceiverAction::None)
                }
            }
            (IoPurpose::InitialTruncate, EncryptedUploadV2ReceiverEvent::Applied { .. }) => {
                self.prepared = true;
                Ok(EncryptedUploadV2ReceiverAction::None)
            }
            (
                IoPurpose::WindowAppend { next_offset },
                EncryptedUploadV2ReceiverEvent::Applied { .. },
            ) => {
                self.staged_offset = next_offset;
                self.advance_window_io()
            }
            (
                IoPurpose::WindowProof,
                EncryptedUploadV2ReceiverEvent::SinkProof {
                    byte_length,
                    prefix_sha256,
                    ..
                },
            ) => self.window_proved(byte_length, prefix_sha256),
            (IoPurpose::WindowPersist, EncryptedUploadV2ReceiverEvent::Applied { .. }) => {
                self.window_persisted()
            }
            (IoPurpose::MarkerPersist, EncryptedUploadV2ReceiverEvent::Applied { .. }) => {
                let slot = self
                    .marker_slot
                    .take()
                    .expect("marker persistence owns complete slot");
                self.marker_documents_hash
                    .update(slot.document().expect("proved complete document"));
                self.marker_documents_persisted += 1;
                Ok(EncryptedUploadV2ReceiverAction::None)
            }
            (
                IoPurpose::FinalProof(eof),
                EncryptedUploadV2ReceiverEvent::SinkProof {
                    byte_length,
                    prefix_sha256,
                    ..
                },
            ) => {
                if byte_length != self.config.expected_ciphertext_length
                    || !equal_hash(&prefix_sha256, &self.config.expected_ciphertext_sha256)
                {
                    return Err(failure(
                        ErrorCode::IntegrityFailed,
                        "final v2 ciphertext length or hash mismatch",
                    ));
                }
                self.terminal = true;
                Ok(EncryptedUploadV2ReceiverAction::Complete {
                    manifest: self.manifest.clone(),
                    evidence: EncryptedUploadV2TransferEvidence {
                        ciphertext_length: eof.ciphertext_length,
                        ciphertext_sha256: eof.ciphertext_sha256,
                        manifest_length: protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH as u16,
                        manifest_sha256: eof.manifest_sha256,
                        block_count: eof.block_count,
                    },
                    marker_evidence: self.config.markers_required.then(|| {
                        EncryptedUploadV2ReceiverMarkerEvidence {
                            document_count: self.marker_documents_persisted,
                            documents_sha256: self.marker_documents_hash.clone().finalize().into(),
                        }
                    }),
                })
            }
            _ => Err(failure(
                ErrorCode::UnexpectedEvent,
                "v2 receiver I/O result kind mismatch",
            )),
        }
    }

    fn advance_window_io(&mut self) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let pending = self
            .pending_window
            .as_ref()
            .expect("window I/O owns candidate");
        let mut bytes = Vec::new();
        if pending.highest >= pending.boundary.first_sequence {
            for (_, packet) in self
                .packets
                .range(pending.boundary.first_sequence..=pending.highest)
            {
                if packet.offset < self.staged_offset {
                    continue;
                }
                if bytes.len() + packet.bytes.len() > MAXIMUM_APPEND_BYTES {
                    break;
                }
                bytes.extend_from_slice(&packet.bytes);
            }
        }
        if !bytes.is_empty() {
            let next_offset = self.staged_offset + bytes.len() as u64;
            let request_id = self.request(IoPurpose::WindowAppend { next_offset })?;
            return Ok(EncryptedUploadV2ReceiverAction::AppendCiphertext {
                request_id,
                offset: self.staged_offset,
                bytes,
            });
        }
        self.inspect_window()
    }

    fn inspect_window(&mut self) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let prefix_length = self
            .pending_window
            .as_ref()
            .expect("window I/O owns candidate")
            .contiguous_offset;
        let request_id = self.request(IoPurpose::WindowProof)?;
        Ok(EncryptedUploadV2ReceiverAction::InspectSink {
            request_id,
            prefix_length,
            flush: true,
        })
    }

    fn window_proved(
        &mut self,
        byte_length: u64,
        prefix_sha256: [u8; 32],
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let pending = self
            .pending_window
            .as_ref()
            .expect("window I/O owns candidate");
        if byte_length != pending.contiguous_offset
            || (pending.contiguous_offset == self.checkpoint.next_ciphertext_offset
                && !equal_hash(&prefix_sha256, &self.checkpoint.prefix_sha256))
        {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "v2 synchronized window prefix mismatch",
            ));
        }
        if !pending.missing.is_empty() {
            return self.ack(
                pending.boundary,
                pending.highest,
                pending.contiguous_offset,
                prefix_sha256,
                self.checkpoint.revision,
                pending.missing.clone(),
            );
        }
        if !equal_hash(&prefix_sha256, &pending.boundary.prefix_sha256) {
            return Err(failure(
                ErrorCode::IntegrityFailed,
                "v2 window hash mismatch",
            ));
        }
        let checkpoint = candidate_checkpoint(pending.boundary);
        let request_id = self.request(IoPurpose::WindowPersist)?;
        Ok(EncryptedUploadV2ReceiverAction::PersistCheckpoint {
            request_id,
            checkpoint,
        })
    }

    fn window_persisted(&mut self) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let pending = self
            .pending_window
            .take()
            .expect("persistence owns clean candidate");
        let checkpoint = candidate_checkpoint(pending.boundary);
        let action = self.ack(
            pending.boundary,
            pending.boundary.last_sequence,
            checkpoint.next_ciphertext_offset,
            checkpoint.prefix_sha256,
            checkpoint.revision,
            Vec::new(),
        )?;
        self.checkpoint = checkpoint;
        self.highest_sequence = Some(pending.boundary.last_sequence);
        self.acknowledged_window = Some(pending.boundary);
        self.acknowledged_packets = std::mem::take(&mut self.packets)
            .into_iter()
            .map(|(sequence, packet)| {
                (
                    sequence,
                    PacketFingerprint {
                        offset: packet.offset,
                        length: packet.bytes.len(),
                        sha256: Sha256::digest(&packet.bytes).into(),
                    },
                )
            })
            .collect();
        self.buffered_bytes = 0;
        Ok(action)
    }

    fn ack(
        &self,
        boundary: WindowEndV2,
        highest_contiguous_sequence: u32,
        next_ciphertext_offset: u64,
        prefix_sha256: [u8; 32],
        checkpoint_revision: u32,
        missing_sequences: Vec<u32>,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        let frame = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::WindowAck(
            WindowAckV2 {
                common: CommonHeaderV2 {
                    message_type: protocol::ENCRYPTED_UPLOAD_V2_WINDOW_ACK,
                    flags: 0,
                    transport_session_id: self.config.transport_session_id,
                },
                window_index: boundary.window_index,
                highest_contiguous_sequence,
                next_ciphertext_offset,
                prefix_sha256,
                checkpoint_revision,
                missing_sequences,
            },
        ))?;
        Ok(EncryptedUploadV2ReceiverAction::Control { frame })
    }

    fn request(&mut self, purpose: IoPurpose) -> Result<u64, DeviceSdkError> {
        let request_id = self.next_request_id;
        self.next_request_id = request_id
            .checked_add(1)
            .ok_or_else(|| failure(ErrorCode::Internal, "v2 receiver I/O identifier exhausted"))?;
        self.io = Some(PendingIo {
            request_id,
            purpose,
        });
        Ok(request_id)
    }

    fn require_active(&self) -> Result<(), DeviceSdkError> {
        if self.cancelled {
            Err(failure(ErrorCode::Cancelled, "v2 receiver cancelled"))
        } else if self.terminal {
            Err(failure(
                ErrorCode::UnexpectedEvent,
                "v2 receiver is terminal",
            ))
        } else {
            Ok(())
        }
    }

    fn finish_result(
        &mut self,
        result: Result<EncryptedUploadV2ReceiverAction, DeviceSdkError>,
    ) -> Result<EncryptedUploadV2ReceiverAction, DeviceSdkError> {
        if result.is_err() {
            self.terminal = true;
            self.io = None;
        }
        result
    }
}

fn candidate_checkpoint(boundary: WindowEndV2) -> EncryptedUploadV2ReceiverCheckpoint {
    EncryptedUploadV2ReceiverCheckpoint {
        revision: boundary.checkpoint_revision,
        next_ciphertext_offset: boundary.next_ciphertext_offset,
        prefix_sha256: boundary.prefix_sha256,
        highest_contiguous_sequence: Some(boundary.last_sequence),
    }
}

fn equal_hash(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn failure(code: ErrorCode, detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(code, Operation::TransferRecording, false).with_detail(detail)
}
