use crate::{
    engine::{
        CancellationId, Effect, EffectRequest, EncryptedUploadV2HostEffect,
        EncryptedUploadV2HostEvent, HostEvent, HostEventKind, ProgressEffect, RequestId,
        WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::{
        DeviceSerialNumber, HostMaterialId, RecordingSinkId, RecordingUploadProfile, RecordingUuid,
        UploadProfileSelection, UploadProfileSelectionEvidence, validate_upload_profile_selection,
    },
    protocol::EncryptedUploadV2Capabilities,
    workflow::{WorkflowContext, WorkflowReducer},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2BatchRequest {
    pub device: DeviceSerialNumber,
    pub recording: RecordingUuid,
    pub recording_generation: u32,
    pub storage_format: u8,
    pub upload_session_uuid: [u8; 16],
    pub owner_revision: u32,
    pub transport_session_id: u64,
    pub material_id: HostMaterialId,
    pub sink_id: RecordingSinkId,
    pub selection: UploadProfileSelection,
    pub capabilities: EncryptedUploadV2Capabilities,
    pub window_packets: u16,
    pub data_payload_bytes: u16,
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2Checkpoint {
    pub device: DeviceSerialNumber,
    pub recording: RecordingUuid,
    pub recording_generation: u32,
    pub upload_session_uuid: [u8; 16],
    pub owner_revision: u32,
    pub transport_session_id: u64,
    pub checkpoint_revision: u32,
    pub next_ciphertext_offset: u64,
    pub prefix_sha256: [u8; 32],
    pub window_packets: u16,
    pub data_payload_bytes: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedUploadV2TransferEvidence {
    pub ciphertext_length: u64,
    pub ciphertext_sha256: [u8; 32],
    pub manifest_length: u16,
    pub manifest_sha256: [u8; 32],
    pub block_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2BatchEvent {
    CheckpointLoaded(Option<EncryptedUploadV2Checkpoint>),
    SinkTruncated,
    SessionPrepared {
        authorization_sha256: [u8; 32],
    },
    TransferStarted,
    ResumeRejected,
    WindowStaged {
        checkpoint: EncryptedUploadV2Checkpoint,
        missing_sequences: Vec<u32>,
    },
    CheckpointSaved,
    WindowAcknowledged {
        checkpoint: EncryptedUploadV2Checkpoint,
    },
    TransferCompleted(EncryptedUploadV2TransferEvidence),
    ArtifactsStaged,
    CompletionReceiptAccepted {
        receipt_sha256: [u8; 32],
    },
    RecordingConfirmed,
    MixedProfile,
    Failed(DeviceSdkError),
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2Action {
    LoadCheckpoint,
    DeleteCheckpoint,
    TruncateSink {
        next_ciphertext_offset: u64,
    },
    PrepareSession,
    StartTransfer {
        checkpoint: Option<EncryptedUploadV2Checkpoint>,
        authorization_sha256: [u8; 32],
    },
    RepairWindow {
        missing_sequences: Vec<u32>,
    },
    SaveCheckpoint {
        checkpoint: EncryptedUploadV2Checkpoint,
    },
    AcknowledgeWindow {
        checkpoint: EncryptedUploadV2Checkpoint,
    },
    Progress {
        completed_units: u64,
        total_units: u64,
    },
    StageArtifacts {
        evidence: EncryptedUploadV2TransferEvidence,
    },
    ReportStaged {
        evidence: EncryptedUploadV2TransferEvidence,
    },
    AwaitCompletionReceipt,
    ConfirmWithReceipt {
        receipt_sha256: [u8; 32],
    },
    AbortV2,
    RetainRecording,
    Complete,
    Cancelled,
    Failed(DeviceSdkError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2BatchStatus {
    Ready,
    Running,
    WaitingForReceipt,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Ready,
    LoadingCheckpoint,
    Truncating,
    RestartTruncating,
    Preparing,
    Starting,
    Transferring,
    SavingCheckpoint,
    AcknowledgingWindow,
    Staging,
    WaitingForReceipt,
    Confirming,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug)]
pub struct EncryptedUploadV2BatchCoordinator {
    request: EncryptedUploadV2BatchRequest,
    phase: Phase,
    selected_checkpoint: Option<EncryptedUploadV2Checkpoint>,
    pending_checkpoint: Option<EncryptedUploadV2Checkpoint>,
    authorization_sha256: Option<[u8; 32]>,
    transfer_evidence: Option<EncryptedUploadV2TransferEvidence>,
}

pub(crate) struct EncryptedUploadV2Workflow {
    coordinator: EncryptedUploadV2BatchCoordinator,
    cancellation_id: CancellationId,
    expected_request_id: Option<RequestId>,
    transfer_request_id: Option<RequestId>,
    terminal_error: Option<DeviceSdkError>,
}

impl EncryptedUploadV2Workflow {
    pub(crate) fn new(
        request: EncryptedUploadV2BatchRequest,
        cancellation_id: CancellationId,
    ) -> Result<Self, DeviceSdkError> {
        Ok(Self {
            coordinator: EncryptedUploadV2BatchCoordinator::new(request)?,
            cancellation_id,
            expected_request_id: None,
            transfer_request_id: None,
            terminal_error: None,
        })
    }

    fn translate(
        &mut self,
        actions: Vec<EncryptedUploadV2Action>,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        let mut effects = Vec::new();
        for action in actions {
            let effect = match action {
                EncryptedUploadV2Action::LoadCheckpoint => {
                    let request = self.coordinator.request();
                    Some(Effect::EncryptedUploadV2(
                        EncryptedUploadV2HostEffect::LoadCheckpoint {
                            device: request.device.clone(),
                            recording: request.recording,
                            recording_generation: request.recording_generation,
                            upload_session_uuid: request.upload_session_uuid,
                            owner_revision: request.owner_revision,
                        },
                    ))
                }
                EncryptedUploadV2Action::DeleteCheckpoint => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::DeleteCheckpoint {
                        upload_session_uuid: self.coordinator.request().upload_session_uuid,
                    },
                )),
                EncryptedUploadV2Action::TruncateSink {
                    next_ciphertext_offset,
                } => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::TruncateSink {
                        sink_id: self.coordinator.request().sink_id.clone(),
                        next_ciphertext_offset,
                    },
                )),
                EncryptedUploadV2Action::PrepareSession => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::PrepareSession {
                        material_id: self.coordinator.request().material_id.clone(),
                    },
                )),
                EncryptedUploadV2Action::StartTransfer {
                    checkpoint,
                    authorization_sha256,
                } => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::StartTransfer {
                        request: Box::new(self.coordinator.request().clone()),
                        checkpoint,
                        authorization_sha256,
                    },
                )),
                EncryptedUploadV2Action::RepairWindow { missing_sequences } => {
                    Some(Effect::EncryptedUploadV2(
                        EncryptedUploadV2HostEffect::RepairWindow { missing_sequences },
                    ))
                }
                EncryptedUploadV2Action::SaveCheckpoint { checkpoint } => {
                    Some(Effect::EncryptedUploadV2(
                        EncryptedUploadV2HostEffect::SaveCheckpoint { checkpoint },
                    ))
                }
                EncryptedUploadV2Action::AcknowledgeWindow { checkpoint } => {
                    Some(Effect::EncryptedUploadV2(
                        EncryptedUploadV2HostEffect::AcknowledgeWindow { checkpoint },
                    ))
                }
                EncryptedUploadV2Action::Progress {
                    completed_units,
                    total_units,
                } => Some(Effect::Progress(ProgressEffect {
                    completed_units,
                    total_units,
                })),
                EncryptedUploadV2Action::StageArtifacts { evidence } => Some(
                    Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StageArtifacts {
                        sink_id: self.coordinator.request().sink_id.clone(),
                        material_id: self.coordinator.request().material_id.clone(),
                        evidence,
                    }),
                ),
                EncryptedUploadV2Action::ReportStaged { evidence } => {
                    let request = self.coordinator.request();
                    Some(Effect::Notify(
                        WorkflowNotification::EncryptedUploadV2Staged {
                            upload_session_uuid: request.upload_session_uuid,
                            owner_revision: request.owner_revision,
                            ciphertext_length: evidence.ciphertext_length,
                            ciphertext_sha256: evidence.ciphertext_sha256,
                            manifest_length: evidence.manifest_length,
                            manifest_sha256: evidence.manifest_sha256,
                        },
                    ))
                }
                EncryptedUploadV2Action::AwaitCompletionReceipt => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::AwaitCompletionReceipt {
                        material_id: self.coordinator.request().material_id.clone(),
                        evidence: self
                            .coordinator
                            .transfer_evidence
                            .expect("receipt wait owns transfer evidence"),
                    },
                )),
                EncryptedUploadV2Action::ConfirmWithReceipt { receipt_sha256 } => Some(
                    Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt {
                        material_id: self.coordinator.request().material_id.clone(),
                        receipt_sha256,
                    }),
                ),
                EncryptedUploadV2Action::AbortV2 => Some(Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::AbortV2 {
                        material_id: self.coordinator.request().material_id.clone(),
                    },
                )),
                EncryptedUploadV2Action::RetainRecording => None,
                EncryptedUploadV2Action::Complete => {
                    Some(Effect::Notify(WorkflowNotification::Completed {
                        operation: Operation::TransferRecording,
                    }))
                }
                EncryptedUploadV2Action::Cancelled => {
                    Some(Effect::Notify(WorkflowNotification::Cancelled {
                        operation: Operation::TransferRecording,
                    }))
                }
                EncryptedUploadV2Action::Failed(error) => {
                    self.terminal_error = Some(error.clone());
                    Some(Effect::Notify(WorkflowNotification::Failed { error }))
                }
            };
            let Some(effect) = effect else { continue };
            let expects_response = matches!(
                &effect,
                Effect::EncryptedUploadV2(
                    EncryptedUploadV2HostEffect::LoadCheckpoint { .. }
                        | EncryptedUploadV2HostEffect::TruncateSink { .. }
                        | EncryptedUploadV2HostEffect::PrepareSession { .. }
                        | EncryptedUploadV2HostEffect::StartTransfer { .. }
                        | EncryptedUploadV2HostEffect::RepairWindow { .. }
                        | EncryptedUploadV2HostEffect::SaveCheckpoint { .. }
                        | EncryptedUploadV2HostEffect::AcknowledgeWindow { .. }
                        | EncryptedUploadV2HostEffect::StageArtifacts { .. }
                        | EncryptedUploadV2HostEffect::AwaitCompletionReceipt { .. }
                        | EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. }
                )
            );
            let is_transfer = matches!(
                &effect,
                Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StartTransfer { .. })
            );
            let request = context.request(effect);
            if expects_response {
                self.expected_request_id = Some(request.request_id);
            }
            if is_transfer {
                self.transfer_request_id = Some(request.request_id);
            }
            effects.push(request);
        }
        effects
    }

    fn coordinator_event(event: EncryptedUploadV2HostEvent) -> EncryptedUploadV2BatchEvent {
        match event {
            EncryptedUploadV2HostEvent::CheckpointLoaded(checkpoint) => {
                EncryptedUploadV2BatchEvent::CheckpointLoaded(checkpoint)
            }
            EncryptedUploadV2HostEvent::SinkTruncated => EncryptedUploadV2BatchEvent::SinkTruncated,
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256,
            } => EncryptedUploadV2BatchEvent::SessionPrepared {
                authorization_sha256,
            },
            EncryptedUploadV2HostEvent::TransferStarted => {
                EncryptedUploadV2BatchEvent::TransferStarted
            }
            EncryptedUploadV2HostEvent::ResumeRejected => {
                EncryptedUploadV2BatchEvent::ResumeRejected
            }
            EncryptedUploadV2HostEvent::WindowStaged {
                checkpoint,
                missing_sequences,
            } => EncryptedUploadV2BatchEvent::WindowStaged {
                checkpoint,
                missing_sequences,
            },
            EncryptedUploadV2HostEvent::CheckpointSaved => {
                EncryptedUploadV2BatchEvent::CheckpointSaved
            }
            EncryptedUploadV2HostEvent::WindowAcknowledged { checkpoint } => {
                EncryptedUploadV2BatchEvent::WindowAcknowledged { checkpoint }
            }
            EncryptedUploadV2HostEvent::TransferCompleted(evidence) => {
                EncryptedUploadV2BatchEvent::TransferCompleted(evidence)
            }
            EncryptedUploadV2HostEvent::ArtifactsStaged => {
                EncryptedUploadV2BatchEvent::ArtifactsStaged
            }
            EncryptedUploadV2HostEvent::CompletionReceiptAccepted { receipt_sha256 } => {
                EncryptedUploadV2BatchEvent::CompletionReceiptAccepted { receipt_sha256 }
            }
            EncryptedUploadV2HostEvent::RecordingConfirmed => {
                EncryptedUploadV2BatchEvent::RecordingConfirmed
            }
            EncryptedUploadV2HostEvent::MixedProfile => EncryptedUploadV2BatchEvent::MixedProfile,
            EncryptedUploadV2HostEvent::Failed { error } => {
                EncryptedUploadV2BatchEvent::Failed(error)
            }
        }
    }
}

impl EncryptedUploadV2BatchCoordinator {
    pub fn new(request: EncryptedUploadV2BatchRequest) -> Result<Self, DeviceSdkError> {
        if request.selection.profile != RecordingUploadProfile::EncryptedUploadV2 {
            return Err(invalid("encrypted_upload_v2_required_selection"));
        }
        validate_upload_profile_selection(
            request.selection,
            UploadProfileSelectionEvidence {
                encrypted_upload_v2_capabilities: Some(request.capabilities),
                recording_generation: Some(request.recording_generation),
                recording_storage_format: Some(request.storage_format),
                historical_p10_header_observed: false,
            },
        )?;
        if request.upload_session_uuid == [0; 16]
            || request.transport_session_id == 0
            || request.owner_revision == 0
            || request.window_packets == 0
            || request.window_packets > request.capabilities.maximum_window_packets
            || request.data_payload_bytes == 0
            || request.data_payload_bytes > request.capabilities.maximum_data_payload_bytes
            || request.ciphertext_length
                < (protocol::ENCRYPTED_UPLOAD_V2_STORAGE_HEADER_FIXED_LENGTH
                    + protocol::ENCRYPTED_UPLOAD_V2_STORAGE_TRAILER_FIXED_LENGTH)
                    as u64
        {
            return Err(invalid(
                "encrypted upload v2 request parameters are not usable",
            ));
        }

        Ok(Self {
            request,
            phase: Phase::Ready,
            selected_checkpoint: None,
            pending_checkpoint: None,
            authorization_sha256: None,
            transfer_evidence: None,
        })
    }

    pub fn status(&self) -> EncryptedUploadV2BatchStatus {
        match self.phase {
            Phase::Ready => EncryptedUploadV2BatchStatus::Ready,
            Phase::WaitingForReceipt => EncryptedUploadV2BatchStatus::WaitingForReceipt,
            Phase::Completed => EncryptedUploadV2BatchStatus::Completed,
            Phase::Cancelled => EncryptedUploadV2BatchStatus::Cancelled,
            Phase::Failed => EncryptedUploadV2BatchStatus::Failed,
            _ => EncryptedUploadV2BatchStatus::Running,
        }
    }

    pub const fn request(&self) -> &EncryptedUploadV2BatchRequest {
        &self.request
    }

    pub fn start(&mut self) -> Result<Vec<EncryptedUploadV2Action>, DeviceSdkError> {
        if self.phase != Phase::Ready {
            return Err(unexpected(
                "encrypted upload v2 coordinator already started",
            ));
        }
        self.phase = Phase::LoadingCheckpoint;
        Ok(vec![EncryptedUploadV2Action::LoadCheckpoint])
    }

    pub fn dispatch(
        &mut self,
        event: EncryptedUploadV2BatchEvent,
    ) -> Result<Vec<EncryptedUploadV2Action>, DeviceSdkError> {
        match event {
            EncryptedUploadV2BatchEvent::Failed(error) if !self.is_terminal() => {
                Ok(self.fail(error))
            }
            EncryptedUploadV2BatchEvent::MixedProfile if !self.is_terminal() => Ok(self.fail(
                DeviceSdkError::new(
                    ErrorCode::ProtocolRejected,
                    Operation::TransferRecording,
                    false,
                )
                .with_detail("encrypted_upload_v2_mixed_profile"),
            )),
            EncryptedUploadV2BatchEvent::Cancelled if !self.is_terminal() => {
                self.phase = Phase::Cancelled;
                Ok(vec![
                    EncryptedUploadV2Action::AbortV2,
                    EncryptedUploadV2Action::RetainRecording,
                    EncryptedUploadV2Action::Cancelled,
                ])
            }
            EncryptedUploadV2BatchEvent::CheckpointLoaded(checkpoint)
                if self.phase == Phase::LoadingCheckpoint =>
            {
                let mut actions = Vec::new();
                let had_checkpoint = checkpoint.is_some();
                self.selected_checkpoint =
                    checkpoint.filter(|value| self.checkpoint_is_usable(value));
                if had_checkpoint && self.selected_checkpoint.is_none() {
                    actions.push(EncryptedUploadV2Action::DeleteCheckpoint);
                }
                let next_ciphertext_offset = self
                    .selected_checkpoint
                    .as_ref()
                    .map_or(0, |value| value.next_ciphertext_offset);
                self.phase = Phase::Truncating;
                actions.push(EncryptedUploadV2Action::TruncateSink {
                    next_ciphertext_offset,
                });
                Ok(actions)
            }
            EncryptedUploadV2BatchEvent::SinkTruncated if self.phase == Phase::Truncating => {
                self.phase = Phase::Preparing;
                Ok(vec![EncryptedUploadV2Action::PrepareSession])
            }
            EncryptedUploadV2BatchEvent::SinkTruncated
                if self.phase == Phase::RestartTruncating =>
            {
                self.phase = Phase::Starting;
                Ok(vec![EncryptedUploadV2Action::StartTransfer {
                    checkpoint: None,
                    authorization_sha256: self
                        .authorization_sha256
                        .expect("restart retains prepared authorization digest"),
                }])
            }
            EncryptedUploadV2BatchEvent::SessionPrepared {
                authorization_sha256,
            } if self.phase == Phase::Preparing => {
                self.authorization_sha256 = Some(authorization_sha256);
                self.phase = Phase::Starting;
                Ok(vec![EncryptedUploadV2Action::StartTransfer {
                    checkpoint: self.selected_checkpoint.clone(),
                    authorization_sha256,
                }])
            }
            EncryptedUploadV2BatchEvent::TransferStarted if self.phase == Phase::Starting => {
                self.phase = Phase::Transferring;
                Ok(Vec::new())
            }
            EncryptedUploadV2BatchEvent::ResumeRejected
                if self.phase == Phase::Starting && self.selected_checkpoint.is_some() =>
            {
                self.selected_checkpoint = None;
                self.pending_checkpoint = None;
                self.phase = Phase::RestartTruncating;
                Ok(vec![
                    EncryptedUploadV2Action::DeleteCheckpoint,
                    EncryptedUploadV2Action::TruncateSink {
                        next_ciphertext_offset: 0,
                    },
                ])
            }
            EncryptedUploadV2BatchEvent::WindowStaged {
                checkpoint,
                missing_sequences,
            } if self.phase == Phase::Transferring => {
                if !self.checkpoint_is_usable(&checkpoint)
                    || !self.checkpoint_is_monotonic(&checkpoint)
                    || missing_sequences.len()
                        > usize::from(self.request.capabilities.maximum_missing_sequences)
                    || !strictly_increasing(&missing_sequences)
                {
                    return Ok(
                        self.fail(protocol_failure("encrypted_upload_v2_checkpoint_mismatch"))
                    );
                }
                if !missing_sequences.is_empty() {
                    return Ok(vec![EncryptedUploadV2Action::RepairWindow {
                        missing_sequences,
                    }]);
                }
                self.pending_checkpoint = Some(checkpoint.clone());
                self.phase = Phase::SavingCheckpoint;
                Ok(vec![EncryptedUploadV2Action::SaveCheckpoint { checkpoint }])
            }
            EncryptedUploadV2BatchEvent::CheckpointSaved
                if self.phase == Phase::SavingCheckpoint =>
            {
                self.phase = Phase::AcknowledgingWindow;
                Ok(vec![EncryptedUploadV2Action::AcknowledgeWindow {
                    checkpoint: self
                        .pending_checkpoint
                        .clone()
                        .expect("saving phase owns a pending checkpoint"),
                }])
            }
            EncryptedUploadV2BatchEvent::WindowAcknowledged { checkpoint }
                if self.phase == Phase::AcknowledgingWindow =>
            {
                if self.pending_checkpoint.as_ref() != Some(&checkpoint) {
                    return Ok(
                        self.fail(protocol_failure("encrypted_upload_v2_checkpoint_mismatch"))
                    );
                }
                let completed_units = checkpoint.next_ciphertext_offset;
                self.selected_checkpoint = Some(checkpoint);
                self.pending_checkpoint = None;
                self.phase = Phase::Transferring;
                Ok(vec![EncryptedUploadV2Action::Progress {
                    completed_units,
                    total_units: self.request.ciphertext_length,
                }])
            }
            EncryptedUploadV2BatchEvent::TransferCompleted(evidence)
                if self.phase == Phase::Transferring =>
            {
                if evidence.ciphertext_length != self.request.ciphertext_length
                    || evidence.ciphertext_sha256 != self.request.ciphertext_sha256
                    || usize::from(evidence.manifest_length)
                        != protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH
                    || evidence.block_count == 0
                {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::IntegrityFailed,
                            Operation::TransferRecording,
                            false,
                        )
                        .with_detail("encrypted_upload_v2_transfer_evidence_mismatch"),
                    ));
                }
                self.transfer_evidence = Some(evidence);
                self.phase = Phase::Staging;
                Ok(vec![EncryptedUploadV2Action::StageArtifacts { evidence }])
            }
            EncryptedUploadV2BatchEvent::ArtifactsStaged if self.phase == Phase::Staging => {
                let evidence = self
                    .transfer_evidence
                    .expect("staging phase owns transfer evidence");
                self.phase = Phase::WaitingForReceipt;
                Ok(vec![
                    EncryptedUploadV2Action::ReportStaged { evidence },
                    EncryptedUploadV2Action::AwaitCompletionReceipt,
                ])
            }
            EncryptedUploadV2BatchEvent::CompletionReceiptAccepted { receipt_sha256 }
                if self.phase == Phase::WaitingForReceipt =>
            {
                self.phase = Phase::Confirming;
                Ok(vec![EncryptedUploadV2Action::ConfirmWithReceipt {
                    receipt_sha256,
                }])
            }
            EncryptedUploadV2BatchEvent::RecordingConfirmed if self.phase == Phase::Confirming => {
                self.phase = Phase::Completed;
                Ok(vec![
                    EncryptedUploadV2Action::DeleteCheckpoint,
                    EncryptedUploadV2Action::Complete,
                ])
            }
            _ => Err(unexpected(
                "event does not belong to the active encrypted upload v2 phase",
            )),
        }
    }

    fn checkpoint_is_usable(&self, checkpoint: &EncryptedUploadV2Checkpoint) -> bool {
        checkpoint.device == self.request.device
            && checkpoint.recording == self.request.recording
            && checkpoint.recording_generation == self.request.recording_generation
            && checkpoint.upload_session_uuid == self.request.upload_session_uuid
            && checkpoint.owner_revision == self.request.owner_revision
            && checkpoint.transport_session_id == self.request.transport_session_id
            && checkpoint.next_ciphertext_offset <= self.request.ciphertext_length
            && checkpoint.window_packets == self.request.window_packets
            && checkpoint.data_payload_bytes == self.request.data_payload_bytes
    }

    fn checkpoint_is_monotonic(&self, checkpoint: &EncryptedUploadV2Checkpoint) -> bool {
        self.selected_checkpoint.as_ref().is_none_or(|current| {
            checkpoint.checkpoint_revision > current.checkpoint_revision
                && checkpoint.next_ciphertext_offset >= current.next_ciphertext_offset
        })
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self.phase,
            Phase::Completed | Phase::Cancelled | Phase::Failed
        )
    }

    fn fail(&mut self, error: DeviceSdkError) -> Vec<EncryptedUploadV2Action> {
        self.phase = Phase::Failed;
        vec![
            EncryptedUploadV2Action::AbortV2,
            EncryptedUploadV2Action::RetainRecording,
            EncryptedUploadV2Action::Failed(error),
        ]
    }
}

impl WorkflowReducer for EncryptedUploadV2Workflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = vec![
            context.request(Effect::Notify(WorkflowNotification::Started {
                operation: Operation::TransferRecording,
            })),
        ];
        let actions = self
            .coordinator
            .start()
            .expect("new encrypted upload v2 coordinator starts once");
        effects.extend(self.translate(actions, context));
        effects
    }

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        if Some(event.request_id) != self.expected_request_id {
            return Err(unexpected(
                "encrypted upload v2 callback does not own the pending request",
            ));
        }
        let HostEventKind::EncryptedUploadV2(host_event) = event.kind else {
            return Err(unexpected(
                "encrypted upload v2 workflow received another host event kind",
            ));
        };
        let keeps_transfer_open =
            matches!(&host_event, EncryptedUploadV2HostEvent::TransferStarted);
        let restores_transfer = matches!(
            &host_event,
            EncryptedUploadV2HostEvent::WindowAcknowledged { .. }
        );
        let ends_transfer = matches!(
            &host_event,
            EncryptedUploadV2HostEvent::TransferCompleted(_)
                | EncryptedUploadV2HostEvent::ResumeRejected
                | EncryptedUploadV2HostEvent::MixedProfile
                | EncryptedUploadV2HostEvent::Failed { .. }
        );
        if !keeps_transfer_open {
            self.expected_request_id = None;
        }
        if ends_transfer {
            self.transfer_request_id = None;
        }
        let actions = self
            .coordinator
            .dispatch(Self::coordinator_event(host_event))?;
        let effects = self.translate(actions, context);
        if keeps_transfer_open {
            self.expected_request_id = Some(event.request_id);
            self.transfer_request_id = Some(event.request_id);
        } else if restores_transfer && self.expected_request_id.is_none() {
            self.expected_request_id = self.transfer_request_id;
        }
        Ok(effects)
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.expected_request_id = None;
        self.transfer_request_id = None;
        let actions = self
            .coordinator
            .dispatch(EncryptedUploadV2BatchEvent::Cancelled)
            .expect("active encrypted upload v2 coordinator accepts cancellation");
        self.translate(actions, context)
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.coordinator.status() {
            EncryptedUploadV2BatchStatus::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::TransferRecording,
            }),
            EncryptedUploadV2BatchStatus::Cancelled => Some(WorkflowStatus::Cancelled {
                operation: Operation::TransferRecording,
            }),
            EncryptedUploadV2BatchStatus::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed encrypted upload v2 workflow records its error"),
            }),
            EncryptedUploadV2BatchStatus::Ready
            | EncryptedUploadV2BatchStatus::Running
            | EncryptedUploadV2BatchStatus::WaitingForReceipt => None,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}

fn strictly_increasing(values: &[u32]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn invalid(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false).with_detail(detail)
}

fn unexpected(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(
        ErrorCode::UnexpectedEvent,
        Operation::TransferRecording,
        false,
    )
    .with_detail(detail)
}

fn protocol_failure(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(
        ErrorCode::ProtocolRejected,
        Operation::TransferRecording,
        false,
    )
    .with_detail(detail)
}
