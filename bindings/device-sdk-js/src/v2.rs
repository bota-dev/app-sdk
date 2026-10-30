//! Reuse the canonical coordinator's checkpoint acceptance, without a second policy.
use crate::engine::{invalid, validate_command};
use bota_device_sdk_core::{
    engine::{Command, EncryptedUploadV2HostEffect},
    error::DeviceSdkError,
    workflow::{
        EncryptedUploadV2Action, EncryptedUploadV2BatchCoordinator, EncryptedUploadV2BatchEvent,
        EncryptedUploadV2BatchRequest, EncryptedUploadV2Checkpoint,
        EncryptedUploadV2TransferEvidence,
    },
};
use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct CheckpointInput {
    pub(crate) request: EncryptedUploadV2BatchRequest,
    pub(crate) checkpoint: Option<EncryptedUploadV2Checkpoint>,
}
#[derive(Deserialize)]
pub(crate) struct IdentityInput {
    request: EncryptedUploadV2BatchRequest,
    effect: EncryptedUploadV2HostEffect,
}

pub(crate) fn normalize_checkpoint(
    input: CheckpointInput,
) -> Result<Option<EncryptedUploadV2Checkpoint>, DeviceSdkError> {
    validate_request(&input.request)?;
    if input.request.local_wifi {
        return Ok(None);
    }
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(input.request)?;
    coordinator.start()?;
    let checkpoint = input.checkpoint;
    let actions = coordinator.dispatch(EncryptedUploadV2BatchEvent::CheckpointLoaded(
        checkpoint.clone(),
    ))?;
    Ok(
        if actions
            .iter()
            .any(|action| matches!(action, EncryptedUploadV2Action::DeleteCheckpoint))
        {
            None
        } else {
            checkpoint
        },
    )
}

pub(crate) fn validate_request(
    request: &EncryptedUploadV2BatchRequest,
) -> Result<(), DeviceSdkError> {
    validate_command(&Command::TransferEncryptedRecording {
        request: request.clone(),
    })?;
    EncryptedUploadV2BatchCoordinator::new(request.clone()).map(|_| ())
}
fn checkpoint_matches(
    request: &EncryptedUploadV2BatchRequest,
    checkpoint: &EncryptedUploadV2Checkpoint,
) -> Result<bool, DeviceSdkError> {
    Ok(normalize_checkpoint(CheckpointInput {
        request: request.clone(),
        checkpoint: Some(checkpoint.clone()),
    })?
    .is_some())
}
fn evidence_matches(
    request: &EncryptedUploadV2BatchRequest,
    evidence: &EncryptedUploadV2TransferEvidence,
) -> bool {
    request.ciphertext_length == evidence.ciphertext_length
        && request.ciphertext_sha256 == evidence.ciphertext_sha256
}

pub(crate) fn validate_identity(input: IdentityInput) -> Result<(), DeviceSdkError> {
    let request = &input.request;
    validate_request(request)?;
    let valid = match &input.effect {
        EncryptedUploadV2HostEffect::LoadCheckpoint {
            device,
            recording,
            recording_generation,
            upload_session_uuid,
            owner_revision,
        } => {
            device == &request.device
                && recording == &request.recording
                && recording_generation == &request.recording_generation
                && upload_session_uuid == &request.upload_session_uuid
                && owner_revision == &request.owner_revision
        }
        EncryptedUploadV2HostEffect::DeleteCheckpoint {
            upload_session_uuid,
        } => upload_session_uuid == &request.upload_session_uuid,
        EncryptedUploadV2HostEffect::TruncateSink {
            sink_id,
            next_ciphertext_offset,
        } => sink_id == &request.sink_id && *next_ciphertext_offset <= request.ciphertext_length,
        EncryptedUploadV2HostEffect::PrepareSession { material_id }
        | EncryptedUploadV2HostEffect::ConfirmWithReceipt { material_id, .. }
        | EncryptedUploadV2HostEffect::AbortV2 { material_id } => {
            material_id == &request.material_id
        }
        EncryptedUploadV2HostEffect::StartTransfer {
            request: effect_request,
            checkpoint,
            ..
        } => {
            effect_request.as_ref() == request
                && match checkpoint {
                    Some(checkpoint) => checkpoint_matches(request, checkpoint)?,
                    None => true,
                }
        }
        EncryptedUploadV2HostEffect::SaveCheckpoint { checkpoint }
        | EncryptedUploadV2HostEffect::AcknowledgeWindow { checkpoint } => {
            checkpoint_matches(request, checkpoint)?
        }
        EncryptedUploadV2HostEffect::StageArtifacts {
            sink_id,
            material_id,
            evidence,
        } => {
            sink_id == &request.sink_id
                && material_id == &request.material_id
                && evidence_matches(request, evidence)
        }
        EncryptedUploadV2HostEffect::AwaitCompletionReceipt {
            material_id,
            evidence,
        } => material_id == &request.material_id && evidence_matches(request, evidence),
        EncryptedUploadV2HostEffect::RepairWindow { missing_sequences } => {
            missing_sequences.len() <= usize::from(request.capabilities.maximum_missing_sequences)
                && missing_sequences.windows(2).all(|pair| pair[0] < pair[1])
        }
    };
    if valid {
        Ok(())
    } else {
        Err(invalid(
            "encrypted v2 host effect does not match its registered request",
        ))
    }
}
