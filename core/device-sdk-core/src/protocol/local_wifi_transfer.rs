//! Shared local-WiFi receive policy. The existing v2 coordinator owns cloud
//! staging and receipt/CONFIRM. This receiver owns only immutable ciphertext
//! download evidence; it never creates BLE sequence numbers or window ACKs.
use super::{
    CommonHeaderV2, EncryptedUploadV2Transfer, LocalWifiEvidence, LocalWifiPrepare,
    decode_encrypted_upload_v2_transfer, decode_local_wifi_evidence, encode_local_wifi_finish,
};
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as p,
    workflow::EncryptedUploadV2TransferEvidence,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiTransferConfig {
    pub prepare: LocalWifiPrepare,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
}
/// Scoped by the host's existing account/project/binding and logical file ID.
/// No transport-lifetime ID, credentials, BLE sequence or delivery status.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiCheckpoint {
    pub version: u8,
    pub upload_session_uuid: [u8; 16],
    pub recording_uuid: [u8; 16],
    pub recording_generation: u32,
    pub owner_revision: u32,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
    pub manifest_sha256: [u8; 32],
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
}
/// Produced by managed-upload recovery after validating its scoped durable lineage.
/// This authorizes checkpoint migration only; it is never device wire material.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalWifiRecovery {
    pub previous_upload_session_uuid: [u8; 16],
    pub previous_owner_revision: u32,
    pub upload_session_uuid: [u8; 16],
    pub owner_revision: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiFileProof {
    pub byte_length: u64,
    /// Hash exactly the selected checkpoint prefix, or zero bytes without one.
    pub prefix_sha256: [u8; 32],
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiResumePlan {
    pub offset: u64,
    pub truncate_to: Option<u64>,
    pub download: bool,
    pub path: String,
    pub etag: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalWifiHttpResponse {
    pub status: u16,
    pub content_length: u64,
    pub content_range: Option<String>,
    pub etag: String,
    pub content_encoding: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Prepared,
    Manifest,
    Resume,
    Response,
    Reading,
    Flushing,
    Saving,
    Ready,
    Finishing,
    Completed,
    Cancelled,
}

#[derive(Debug)]
pub struct LocalWifiTransferReceiver {
    config: LocalWifiTransferConfig,
    evidence: Option<LocalWifiEvidence>,
    manifest: Vec<u8>,
    phase: Phase,
    offset: u64,
    pending: Option<LocalWifiCheckpoint>,
}
fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(
        ErrorCode::IntegrityFailed,
        Operation::TransferRecording,
        false,
    )
    .with_detail("local WiFi transfer evidence or phase mismatch")
}
impl LocalWifiTransferReceiver {
    pub fn new(config: LocalWifiTransferConfig) -> Result<Self, DeviceSdkError> {
        super::encode_local_wifi_prepare(&config.prepare)?;
        if config.ciphertext_length
            < (p::ENCRYPTED_UPLOAD_V2_STORAGE_HEADER_FIXED_LENGTH
                + p::ENCRYPTED_UPLOAD_V2_STORAGE_TRAILER_FIXED_LENGTH) as u64
        {
            return Err(invalid());
        }
        Ok(Self {
            config,
            evidence: None,
            manifest: Vec::new(),
            phase: Phase::Prepared,
            offset: 0,
            pending: None,
        })
    }
    pub fn prepared(&mut self, bytes: &[u8]) -> Result<(), DeviceSdkError> {
        if self.phase != Phase::Prepared {
            return Err(invalid());
        }
        let e = decode_local_wifi_evidence(bytes)?;
        let r = &self.config.prepare;
        if e.common.message_type != p::LOCAL_WIFI_PREPARED
            || e.common.transport_session_id != r.transport_session_id
            || e.upload_session_uuid != r.upload_session_uuid
            || e.recording_uuid != r.recording_uuid
            || e.recording_generation != r.recording_generation
            || e.owner_revision != r.owner_revision
            || e.ciphertext_length != self.config.ciphertext_length
            || e.ciphertext_sha256 != self.config.ciphertext_sha256
        {
            return Err(invalid());
        }
        self.evidence = Some(e);
        self.phase = Phase::Manifest;
        Ok(())
    }
    /// Bounded original 0x43 frames, replayed from offset zero after PREPARE.
    pub fn manifest(&mut self, bytes: &[u8]) -> Result<bool, DeviceSdkError> {
        if self.phase != Phase::Manifest || bytes.len() > p::LOCAL_WIFI_EVENT_BYTES {
            return Err(invalid());
        }
        let EncryptedUploadV2Transfer::ManifestChunk(c) =
            decode_encrypted_upload_v2_transfer(bytes)?
        else {
            return Err(invalid());
        };
        let e = self.evidence.as_ref().ok_or_else(invalid)?;
        if c.common.transport_session_id != e.common.transport_session_id
            || usize::from(c.total_manifest_length) != p::UPLOAD_MANIFEST_V2_FIXED_LENGTH
            || usize::from(c.chunk_offset) != self.manifest.len()
            || c.manifest_sha256 != e.manifest_sha256
            || c.chunk.is_empty()
            || self.manifest.len() + c.chunk.len() > p::UPLOAD_MANIFEST_V2_FIXED_LENGTH
        {
            return Err(invalid());
        }
        self.manifest.extend_from_slice(c.chunk);
        let done = self.manifest.len() == p::UPLOAD_MANIFEST_V2_FIXED_LENGTH;
        if done {
            if <[u8; 32]>::from(Sha256::digest(&self.manifest)) != e.manifest_sha256 {
                return Err(invalid());
            }
            self.phase = Phase::Resume;
        }
        Ok(done)
    }
    pub fn rebase_checkpoint(
        &self,
        checkpoint: &LocalWifiCheckpoint,
        recovery: &LocalWifiRecovery,
    ) -> Result<LocalWifiCheckpoint, DeviceSdkError> {
        let current = &self.config.prepare;
        if self.phase != Phase::Resume
            || checkpoint.upload_session_uuid != recovery.previous_upload_session_uuid
            || checkpoint.owner_revision != recovery.previous_owner_revision
            || current.upload_session_uuid != recovery.upload_session_uuid
            || current.owner_revision != recovery.owner_revision
            || recovery.previous_upload_session_uuid == recovery.upload_session_uuid
            || recovery.previous_owner_revision >= recovery.owner_revision
            || checkpoint.next_ciphertext_offset > self.config.ciphertext_length
        {
            return Err(invalid());
        }
        let next = self.checkpoint(checkpoint.next_ciphertext_offset, checkpoint.prefix_sha256)?;
        let mut expected = next.clone();
        expected.upload_session_uuid = checkpoint.upload_session_uuid;
        expected.owner_revision = checkpoint.owner_revision;
        // The manifest is session-bound; new PREPARED and all manifest chunks
        // were authenticated before migration. Immutable ciphertext must match.
        expected.manifest_sha256 = checkpoint.manifest_sha256;
        if *checkpoint != expected {
            return Err(invalid());
        }
        Ok(next)
    }
    pub fn resume_prefix(
        &self,
        checkpoint: Option<&LocalWifiCheckpoint>,
    ) -> Result<u64, DeviceSdkError> {
        if self.phase != Phase::Resume {
            return Err(invalid());
        }
        if let Some(c) = checkpoint {
            if c.next_ciphertext_offset > self.config.ciphertext_length
                || *c != self.checkpoint(c.next_ciphertext_offset, c.prefix_sha256)?
            {
                return Err(invalid());
            }
            Ok(c.next_ciphertext_offset)
        } else {
            Ok(0)
        }
    }
    pub fn resume(
        &mut self,
        checkpoint: Option<LocalWifiCheckpoint>,
        proof: LocalWifiFileProof,
    ) -> Result<LocalWifiResumePlan, DeviceSdkError> {
        if self.phase != Phase::Resume {
            return Err(invalid());
        }
        let offset = checkpoint.as_ref().map_or(0, |c| c.next_ciphertext_offset);
        if let Some(c) = &checkpoint {
            if *c != self.checkpoint(offset, c.prefix_sha256)?
                || proof.byte_length < offset
                || proof.prefix_sha256 != c.prefix_sha256
            {
                return Err(invalid());
            }
        } else if proof.prefix_sha256 != <[u8; 32]>::from(Sha256::digest([])) {
            return Err(invalid());
        }
        if offset > self.config.ciphertext_length
            || (offset == self.config.ciphertext_length
                && proof.prefix_sha256 != self.config.ciphertext_sha256)
        {
            return Err(invalid());
        }
        self.offset = offset;
        // A complete retained file must already have its exact durable length.
        // Extra bytes require truncation and a fresh fsync/proof before FINISH.
        if offset == self.config.ciphertext_length && proof.byte_length != offset {
            return Err(invalid());
        }
        self.phase = if offset == self.config.ciphertext_length {
            Phase::Ready
        } else {
            Phase::Response
        };
        let uuid = crate::model::RecordingUuid::from_bytes(self.config.prepare.recording_uuid);
        Ok(LocalWifiResumePlan {
            offset,
            truncate_to: (proof.byte_length != offset).then_some(offset),
            download: offset != self.config.ciphertext_length,
            path: format!(
                "/recordings/{uuid}/{}",
                self.config.prepare.recording_generation
            ),
            etag: self.etag(),
        })
    }
    pub fn response(&mut self, response: LocalWifiHttpResponse) -> Result<(), DeviceSdkError> {
        if self.phase != Phase::Response {
            return Err(invalid());
        }
        let range = (self.offset != 0).then(|| {
            format!(
                "bytes {}-{}/{}",
                self.offset,
                self.config.ciphertext_length - 1,
                self.config.ciphertext_length
            )
        });
        if response.status != if self.offset == 0 { 200 } else { 206 }
            || response.content_length != self.config.ciphertext_length - self.offset
            || response.content_range != range
            || response.etag != self.etag()
            || response
                .content_encoding
                .as_deref()
                .is_some_and(|v| v != "identity")
        {
            return Err(invalid());
        }
        self.phase = Phase::Reading;
        Ok(())
    }
    /// Authorize one bounded append before the host writes bytes. Do not read
    /// another chunk until fsync, prefix proof and journal readback complete.
    pub fn chunk(&mut self, length: usize) -> Result<u64, DeviceSdkError> {
        if self.phase != Phase::Reading || length == 0 || length > 65536 {
            return Err(invalid());
        }
        let end = self.offset.checked_add(length as u64).ok_or_else(invalid)?;
        if end > self.config.ciphertext_length {
            return Err(invalid());
        }
        let start = self.offset;
        self.offset = end;
        self.phase = Phase::Flushing;
        Ok(start)
    }
    pub fn flushed(
        &mut self,
        proof: LocalWifiFileProof,
    ) -> Result<LocalWifiCheckpoint, DeviceSdkError> {
        if self.phase != Phase::Flushing
            || proof.byte_length != self.offset
            || (self.offset == self.config.ciphertext_length
                && proof.prefix_sha256 != self.config.ciphertext_sha256)
        {
            return Err(invalid());
        }
        let cp = self.checkpoint(self.offset, proof.prefix_sha256)?;
        self.pending = Some(cp.clone());
        self.phase = Phase::Saving;
        Ok(cp)
    }
    pub fn saved(&mut self, checkpoint: &LocalWifiCheckpoint) -> Result<(), DeviceSdkError> {
        if self.phase != Phase::Saving || self.pending.as_ref() != Some(checkpoint) {
            return Err(invalid());
        }
        self.pending = None;
        self.phase = Phase::Reading;
        Ok(())
    }
    pub fn reader_closed(&mut self) -> Result<(), DeviceSdkError> {
        if self.phase != Phase::Reading || self.offset != self.config.ciphertext_length {
            return Err(invalid());
        }
        self.phase = Phase::Ready;
        Ok(())
    }
    pub fn finish(&mut self) -> Result<Vec<u8>, DeviceSdkError> {
        if !matches!(self.phase, Phase::Ready | Phase::Finishing) {
            return Err(invalid());
        }
        let frame = encode_local_wifi_finish(
            self.config.prepare.transport_session_id,
            self.evidence.as_ref().ok_or_else(invalid)?,
        )?;
        self.phase = Phase::Finishing;
        Ok(frame)
    }
    pub fn eof(
        &mut self,
        bytes: &[u8],
    ) -> Result<EncryptedUploadV2TransferEvidence, DeviceSdkError> {
        if self.phase != Phase::Finishing {
            return Err(invalid());
        }
        let e = decode_local_wifi_evidence(bytes)?;
        let mut expected = self.evidence.clone().ok_or_else(invalid)?;
        expected.common = CommonHeaderV2 {
            message_type: p::LOCAL_WIFI_EOF,
            ..expected.common
        };
        if e != expected {
            return Err(invalid());
        }
        self.phase = Phase::Completed;
        Ok(EncryptedUploadV2TransferEvidence {
            ciphertext_length: e.ciphertext_length,
            ciphertext_sha256: e.ciphertext_sha256,
            manifest_length: p::UPLOAD_MANIFEST_V2_FIXED_LENGTH as u16,
            manifest_sha256: e.manifest_sha256,
            block_count: e.block_count,
        })
    }
    pub fn manifest_bytes(&self) -> &[u8] {
        &self.manifest
    }
    pub fn cancel(&mut self) {
        self.phase = Phase::Cancelled;
        self.pending = None;
    }
    fn etag(&self) -> String {
        format!(
            "\"{}\"",
            self.config
                .ciphertext_sha256
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>()
        )
    }
    fn checkpoint(
        &self,
        offset: u64,
        prefix: [u8; 32],
    ) -> Result<LocalWifiCheckpoint, DeviceSdkError> {
        let r = &self.config.prepare;
        let e = self.evidence.as_ref().ok_or_else(invalid)?;
        Ok(LocalWifiCheckpoint {
            version: 1,
            upload_session_uuid: r.upload_session_uuid,
            recording_uuid: r.recording_uuid,
            recording_generation: r.recording_generation,
            owner_revision: r.owner_revision,
            ciphertext_length: self.config.ciphertext_length,
            ciphertext_sha256: self.config.ciphertext_sha256,
            manifest_sha256: e.manifest_sha256,
            next_ciphertext_offset: offset,
            prefix_sha256: prefix,
        })
    }
}
