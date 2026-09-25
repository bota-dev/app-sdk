use super::{EncryptedUploadV2Transfer, RecordingEntryV2, decode_encrypted_upload_v2_transfer};
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const ENCRYPTED_UPLOAD_V2_CATALOG_MAX_ENTRIES: usize = 4096;

#[derive(Debug, Eq, PartialEq)]
pub struct EncryptedUploadV2Catalog {
    pub transport_session_id: u64,
    pub list_revision: u32,
    pub list_sha256: [u8; 32],
    pub entries: Vec<RecordingEntryV2>,
}

#[derive(Default)]
pub struct EncryptedUploadV2CatalogDecoder {
    session: Option<u64>,
    entries: Vec<RecordingEntryV2>,
    identities: BTreeSet<([u8; 16], u32)>,
    digest: Sha256,
}

impl EncryptedUploadV2CatalogDecoder {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Empty bytes replace the pending read with an explicitly owned session.
    /// END and every failure consume it. Native code fences late callbacks.
    pub fn push(
        &mut self,
        session: u64,
        bytes: &[u8],
    ) -> Result<Option<EncryptedUploadV2Catalog>, DeviceSdkError> {
        let result = self.push_inner(session, bytes);
        if result.is_err() || matches!(result, Ok(Some(_))) {
            self.reset();
        }
        result
    }

    fn push_inner(
        &mut self,
        session: u64,
        bytes: &[u8],
    ) -> Result<Option<EncryptedUploadV2Catalog>, DeviceSdkError> {
        if session == 0 {
            return Err(invalid("catalog session must be nonzero"));
        }
        if bytes.is_empty() {
            self.reset();
            self.session = Some(session);
            return Ok(None);
        }
        if self.session != Some(session) {
            return Err(invalid("catalog is not owned by this session"));
        }
        if bytes.len() > protocol::ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH {
            return Err(invalid("catalog packet exceeds bound"));
        }
        match decode_encrypted_upload_v2_transfer(bytes)? {
            EncryptedUploadV2Transfer::RecordingEntry(entry) => {
                if entry.common.transport_session_id != session
                    || self.entries.len() == ENCRYPTED_UPLOAD_V2_CATALOG_MAX_ENTRIES
                    || !self
                        .identities
                        .insert((entry.recording_uuid, entry.recording_generation))
                {
                    return Err(invalid(
                        "catalog entry session, capacity or identity conflict",
                    ));
                }
                self.digest
                    .update(&bytes[protocol::ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FIXED_LENGTH..]);
                self.entries.push(entry);
                Ok(None)
            }
            EncryptedUploadV2Transfer::RecordingListEnd {
                common,
                count,
                list_revision,
                list_sha256,
            } => {
                let digest: [u8; 32] = self.digest.clone().finalize().into();
                if common.transport_session_id != session
                    || count as usize != self.entries.len()
                    || digest != list_sha256
                {
                    return Err(invalid("catalog END session, count or digest mismatch"));
                }
                Ok(Some(EncryptedUploadV2Catalog {
                    transport_session_id: session,
                    list_revision,
                    list_sha256,
                    entries: std::mem::take(&mut self.entries),
                }))
            }
            _ => Err(invalid("unexpected catalog message")),
        }
    }
}
fn invalid(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::ProtocolRejected, Operation::Decode, false).with_detail(detail)
}
