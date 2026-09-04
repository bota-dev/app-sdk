use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    protocol::EncryptedUploadV2Capabilities,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RecordingUploadProfile {
    LegacyPlainV1,
    LegacyP10Relay,
    EncryptedUploadV2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum UploadSecurityPolicy {
    LegacyAllowed,
    V2Preferred,
    V2Required,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct UploadProfileSelection {
    pub policy: UploadSecurityPolicy,
    pub profile: RecordingUploadProfile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UploadProfileSelectionEvidence {
    pub encrypted_upload_v2_capabilities: Option<EncryptedUploadV2Capabilities>,
    pub recording_generation: Option<u32>,
    pub recording_storage_format: Option<u8>,
    pub historical_p10_header_observed: bool,
}

pub fn validate_upload_profile_selection(
    selection: UploadProfileSelection,
    evidence: UploadProfileSelectionEvidence,
) -> Result<UploadProfileSelection, DeviceSdkError> {
    if selection.policy == UploadSecurityPolicy::V2Required
        && selection.profile != RecordingUploadProfile::EncryptedUploadV2
    {
        return Err(selection_error(
            ErrorCode::ProtocolRejected,
            "encrypted_upload_v2_required",
        ));
    }

    match selection.profile {
        RecordingUploadProfile::LegacyPlainV1 => {
            if evidence.historical_p10_header_observed {
                return Err(selection_error(
                    ErrorCode::ProtocolRejected,
                    "legacy_p10_relay_required",
                ));
            }
        }
        RecordingUploadProfile::LegacyP10Relay => {
            if !evidence.historical_p10_header_observed {
                return Err(selection_error(
                    ErrorCode::ProtocolRejected,
                    "legacy_p10_relay_not_observed",
                ));
            }
        }
        RecordingUploadProfile::EncryptedUploadV2 => {
            if evidence.historical_p10_header_observed
                || evidence.recording_generation.is_none()
                || evidence.recording_storage_format != Some(protocol::STORAGE_FORMAT_BOTA_ENC_V2)
                || !evidence
                    .encrypted_upload_v2_capabilities
                    .is_some_and(supports_encrypted_upload_v2_batch)
            {
                return Err(selection_error(
                    ErrorCode::UnsupportedCapability,
                    "encrypted_upload_v2_unsupported",
                ));
            }
        }
    }

    Ok(selection)
}

fn supports_encrypted_upload_v2_batch(capabilities: EncryptedUploadV2Capabilities) -> bool {
    const REQUIRED_FLAGS: u32 = protocol::ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_STORAGE
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_FULL_RECORDING_IDENTITY
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_DURABLE_RESUME
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_MANIFEST
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_RECEIPT
        | protocol::ENCRYPTED_UPLOAD_V2_CAP_BATCH;

    capabilities.flags & REQUIRED_FLAGS == REQUIRED_FLAGS
        && usize::from(capabilities.maximum_signed_blob_bytes)
            >= protocol::UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH
        && usize::from(capabilities.maximum_manifest_bytes)
            >= protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH
        && capabilities.maximum_data_payload_bytes > 0
        && capabilities.maximum_window_packets > 0
        && capabilities.durable_checkpoint_interval_blocks > 0
        && capabilities.maximum_missing_sequences > 0
}

fn selection_error(code: ErrorCode, detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(code, Operation::Validate, false).with_detail(detail)
}
