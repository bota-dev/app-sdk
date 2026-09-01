use std::collections::BTreeSet;

use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, CheckpointPhase, Effect, EffectRequest, HostEvent,
        HostEventKind, PersistenceEffect, ProgressEffect, RecordingSinkEffect, RequestId,
        WorkflowCheckpoint, WorkflowKind, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{CHAR_RECORDING_TRANSFER, CHAR_TRANSFER_CONTROL, SERVICE_BOTA_STORAGE},
    model::{DeviceSerialNumber, RecordingSinkId, RecordingUuid},
    protocol::{
        AckType, TransferCommand, TransferPacket, encode_ack, encode_transfer_command,
        parse_transfer_packet,
    },
    workflow::{WorkflowContext, WorkflowReducer},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    LoadingCheckpoint,
    TruncatingSink,
    Subscribing,
    Starting,
    Transferring,
    Appending,
    Finalizing,
    Acknowledging,
    Confirming,
    Completed,
    Failed,
}

pub(crate) struct RecordingTransferWorkflow {
    device: DeviceSerialNumber,
    recording: RecordingUuid,
    sink_id: RecordingSinkId,
    total_units: u64,
    cancellation_id: CancellationId,
    phase: Phase,
    completed_units: u64,
    retry_count: u16,
    last_sequence: Option<u16>,
    pending_sequence: Option<u16>,
    pending_payload_units: u64,
    eof_sequence: Option<u16>,
    load_request_id: Option<RequestId>,
    sink_request_id: Option<RequestId>,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    checkpoint_request_ids: BTreeSet<RequestId>,
    encrypted: Option<bool>,
    e2e_header_received: bool,
    terminal_error: Option<DeviceSdkError>,
}

impl RecordingTransferWorkflow {
    pub(crate) fn new(
        device: DeviceSerialNumber,
        recording: RecordingUuid,
        sink_id: RecordingSinkId,
        total_units: u64,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            device,
            recording,
            sink_id,
            total_units,
            cancellation_id,
            phase: Phase::LoadingCheckpoint,
            completed_units: 0,
            retry_count: 0,
            last_sequence: None,
            pending_sequence: None,
            pending_payload_units: 0,
            eof_sequence: None,
            load_request_id: None,
            sink_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            encrypted: None,
            e2e_header_received: false,
            terminal_error: None,
        }
    }

    fn checkpoint_matches(&self, checkpoint: &WorkflowCheckpoint) -> bool {
        checkpoint.workflow == WorkflowKind::RecordingTransfer
            && checkpoint.operation == Operation::TransferRecording
            && checkpoint.device == self.device
            && checkpoint.recording == Some(self.recording)
    }

    fn truncate_sink(
        &mut self,
        completed_units: u64,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::TruncatingSink;
        let request = context.request(Effect::RecordingSink(RecordingSinkEffect::Truncate {
            sink_id: self.sink_id.clone(),
            completed_units,
        }));
        self.sink_request_id = Some(request.request_id);
        vec![request]
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Subscribing;
        let request = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
        }));
        self.subscription_request_id = Some(request.request_id);
        vec![request]
    }

    fn start_transfer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Starting;
        let payload = encode_transfer_command(TransferCommand::Start(self.recording))
            .expect("recording UUID always fits the transfer command");
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload,
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn append(
        &mut self,
        sequence: Option<u16>,
        payload: Vec<u8>,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Appending;
        self.pending_sequence = sequence;
        self.pending_payload_units = payload.len() as u64;
        let request = context.request(Effect::RecordingSink(RecordingSinkEffect::Append {
            sink_id: self.sink_id.clone(),
            sequence: sequence.unwrap_or(0),
            payload,
        }));
        self.sink_request_id = Some(request.request_id);
        vec![request]
    }

    fn save_checkpoint(&mut self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        let request = context.request(Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: WorkflowCheckpoint {
                workflow: WorkflowKind::RecordingTransfer,
                operation: Operation::TransferRecording,
                device: self.device.clone(),
                recording: Some(self.recording),
                phase: CheckpointPhase::Transferring,
                completed_units: self.completed_units,
                retry_count: self.retry_count,
                last_sequence: self.last_sequence,
                firmware_version: None,
            },
        }));
        self.checkpoint_request_ids.insert(request.request_id);
        request
    }

    fn finalize(
        &mut self,
        sequence: u16,
        checksum: Option<u32>,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Finalizing;
        self.eof_sequence = Some(sequence);
        let request = context.request(Effect::RecordingSink(RecordingSinkEffect::Finalize {
            sink_id: self.sink_id.clone(),
            expected_crc32: checksum,
        }));
        self.sink_request_id = Some(request.request_id);
        vec![request]
    }

    fn write_ack(
        &mut self,
        ack_type: AckType,
        sequence: u16,
        context: &mut WorkflowContext<'_>,
    ) -> EffectRequest {
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            payload: encode_ack(ack_type, sequence)
                .expect("fixed acknowledgement always fits the wire format"),
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        request
    }

    fn confirm(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Confirming;
        let payload = encode_transfer_command(TransferCommand::Confirm(self.recording))
            .expect("recording UUID always fits the transfer command");
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload,
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn unsubscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if self.subscription_request_id.take().is_none() {
            return Vec::new();
        }
        vec![context.request(Effect::Ble(BleEffect::Unsubscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
        }))]
    }

    fn complete(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        let mut effects = self.unsubscribe(context);
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::TransferRecording,
            })),
        );
        effects
    }

    fn fail(
        &mut self,
        error: DeviceSdkError,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Failed;
        self.terminal_error = Some(error.clone());
        let mut effects = self.unsubscribe(context);
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn fail_integrity(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let sequence = self.eof_sequence.unwrap_or(0);
        let error = DeviceSdkError::new(
            ErrorCode::IntegrityFailed,
            Operation::TransferRecording,
            true,
        )
        .with_detail("recording sink rejected the transfer integrity check");
        let mut effects = vec![self.write_ack(AckType::Nack, sequence, context)];
        effects.push(
            context.request(Effect::RecordingSink(RecordingSinkEffect::Discard {
                sink_id: self.sink_id.clone(),
            })),
        );
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.extend(self.fail(error, context));
        effects
    }

    fn fail_mixed_transfer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.fail(
            DeviceSdkError::new(
                ErrorCode::ProtocolRejected,
                Operation::TransferRecording,
                false,
            )
            .with_detail("recording transfer mixed plaintext and encrypted packets"),
            context,
        )
    }

    fn fail_malformed_encrypted_transfer(
        &mut self,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.fail(
            DeviceSdkError::new(
                ErrorCode::IntegrityFailed,
                Operation::TransferRecording,
                false,
            )
            .with_detail("encrypted recording transfer is missing its session header"),
            context,
        )
    }

    fn sink_failure(platform_code: Option<i64>) -> DeviceSdkError {
        DeviceSdkError::new(
            ErrorCode::PersistenceFailed,
            Operation::TransferRecording,
            true,
        )
        .with_detail(format!(
            "recording sink operation failed with code {platform_code:?}"
        ))
    }
}

impl WorkflowReducer for RecordingTransferWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::TransferRecording,
        }));
        let load = context.request(Effect::Persistence(PersistenceEffect::LoadCheckpoint));
        self.load_request_id = Some(load.request_id);
        vec![started, load]
    }

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        if matches!(event.kind, HostEventKind::CheckpointSaved)
            && self.checkpoint_request_ids.remove(&event.request_id)
        {
            return Ok(Vec::new());
        }

        let request_id = event.request_id;
        match (self.phase, event.kind) {
            (Phase::LoadingCheckpoint, HostEventKind::CheckpointLoaded { checkpoint })
                if Some(request_id) == self.load_request_id =>
            {
                self.load_request_id = None;
                if let Some(checkpoint) = checkpoint.filter(|value| self.checkpoint_matches(value))
                {
                    self.completed_units = checkpoint.completed_units;
                    self.last_sequence = checkpoint.last_sequence;
                    self.retry_count = checkpoint.retry_count.saturating_add(1);
                }
                Ok(self.truncate_sink(self.completed_units, context))
            }
            (Phase::TruncatingSink, HostEventKind::RecordingSinkTruncated)
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                Ok(self.subscribe(context))
            }
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_RECORDING_TRANSFER =>
            {
                Ok(self.start_transfer(context))
            }
            (Phase::Starting, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                self.phase = Phase::Transferring;
                Ok(Vec::new())
            }
            (
                Phase::Transferring,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid,
                    value,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_RECORDING_TRANSFER =>
            {
                let packet = match parse_transfer_packet(&value) {
                    Ok(packet) => packet,
                    Err(error) => return Ok(self.fail(error, context)),
                };
                match packet {
                    TransferPacket::Data { sequence, data } => {
                        let expected = self.last_sequence.map_or(0, |last| last.wrapping_add(1));
                        if self.last_sequence.is_some_and(|last| sequence <= last) {
                            return Ok(Vec::new());
                        }
                        if sequence != expected {
                            self.eof_sequence = Some(expected);
                            return Ok(self.fail_integrity(context));
                        }
                        if self.encrypted == Some(true) {
                            return Ok(self.fail_mixed_transfer(context));
                        }
                        self.encrypted = Some(false);
                        Ok(self.append(Some(sequence), data, context))
                    }
                    TransferPacket::Eof { sequence, checksum } => {
                        if self.encrypted == Some(true) {
                            return Ok(self.fail_mixed_transfer(context));
                        }
                        self.encrypted = Some(false);
                        Ok(self.finalize(sequence, Some(checksum), context))
                    }
                    TransferPacket::E2eStart {
                        ephemeral_public_key,
                        salt,
                    } => {
                        if self.encrypted == Some(false) {
                            return Ok(self.fail_mixed_transfer(context));
                        }
                        self.encrypted = Some(true);
                        if self.e2e_header_received {
                            return Ok(Vec::new());
                        }
                        self.e2e_header_received = true;
                        if self.completed_units > 0 {
                            return Ok(Vec::new());
                        }
                        let mut header = ephemeral_public_key;
                        header.extend_from_slice(&salt);
                        Ok(self.append(None, header, context))
                    }
                    TransferPacket::EncryptedData { sequence, chunk } => {
                        if self.encrypted != Some(true) || !self.e2e_header_received {
                            return Ok(self.fail_malformed_encrypted_transfer(context));
                        }
                        let expected = self.last_sequence.map_or(0, |last| last.wrapping_add(1));
                        if self.last_sequence.is_some_and(|last| sequence <= last) {
                            return Ok(Vec::new());
                        }
                        if sequence != expected || chunk.len() < 16 {
                            self.eof_sequence = Some(expected);
                            return Ok(self.fail_integrity(context));
                        }
                        let plaintext_length = u16::try_from(chunk.len() - 16)
                            .expect("BLE encrypted chunk length fits in 16 bits");
                        let mut framed = Vec::with_capacity(chunk.len() + 2);
                        framed.extend_from_slice(&plaintext_length.to_be_bytes());
                        framed.extend_from_slice(&chunk);
                        Ok(self.append(Some(sequence), framed, context))
                    }
                    TransferPacket::EncryptedEof { sequence } => {
                        if self.encrypted != Some(true) || !self.e2e_header_received {
                            return Ok(self.fail_malformed_encrypted_transfer(context));
                        }
                        Ok(self.finalize(sequence, None, context))
                    }
                    TransferPacket::Sha256(_) => Ok(Vec::new()),
                    TransferPacket::Error { code, .. } => Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::TransferRecording,
                            code != 0x14,
                        )
                        .with_protocol_status(u16::from(code))
                        .with_detail("device rejected recording transfer"),
                        context,
                    )),
                    _ => Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::UnsupportedOperation,
                            Operation::TransferRecording,
                            false,
                        )
                        .with_detail("transfer packet type is not supported by batch sink"),
                        context,
                    )),
                }
            }
            (Phase::Appending, HostEventKind::RecordingSinkAppendCompleted { durable_units })
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                let minimum = self
                    .completed_units
                    .saturating_add(self.pending_payload_units);
                if durable_units < minimum {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::PersistenceFailed,
                            Operation::TransferRecording,
                            true,
                        )
                        .with_detail("recording sink reported a non-durable append"),
                        context,
                    ));
                }
                self.completed_units = durable_units;
                if let Some(sequence) = self.pending_sequence.take() {
                    self.last_sequence = Some(sequence);
                }
                self.pending_payload_units = 0;
                self.phase = Phase::Transferring;
                Ok(vec![
                    self.save_checkpoint(context),
                    context.request(Effect::Progress(ProgressEffect {
                        completed_units: self.completed_units,
                        total_units: self.total_units,
                    })),
                ])
            }
            (Phase::Finalizing, HostEventKind::RecordingSinkFinalized { durable_units })
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                self.completed_units = durable_units;
                self.phase = Phase::Acknowledging;
                Ok(vec![self.write_ack(
                    AckType::Ack,
                    self.eof_sequence.unwrap_or(0),
                    context,
                )])
            }
            (Phase::Finalizing, HostEventKind::RecordingSinkIntegrityFailed)
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                Ok(self.fail_integrity(context))
            }
            (Phase::Acknowledging, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.confirm(context))
            }
            (Phase::Confirming, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.complete(context))
            }
            (_, HostEventKind::RecordingSinkFailed { platform_code })
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                Ok(self.fail(Self::sink_failure(platform_code), context))
            }
            (_, HostEventKind::PersistenceFailed { platform_code })
                if self.checkpoint_request_ids.remove(&request_id)
                    || Some(request_id) == self.load_request_id =>
            {
                Ok(self.fail(Self::sink_failure(platform_code), context))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. })) => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::NotConnected, Operation::TransferRecording, true)
                    .with_detail("device disconnected during recording transfer"),
                context,
            )),
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [self.subscription_request_id, self.write_request_id]
                    .contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::ConnectionFailed,
                        Operation::TransferRecording,
                        true,
                    )
                    .with_detail(format!(
                        "BLE recording transfer failed with code {platform_code:?}"
                    )),
                    context,
                ))
            }
            _ => Err(DeviceSdkError::new(
                ErrorCode::UnexpectedEvent,
                Operation::TransferRecording,
                false,
            )
            .with_detail("event does not belong to the active recording-transfer phase")),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let sequence = self.last_sequence.map_or(0, |last| last.wrapping_add(1));
        let mut effects = vec![self.write_ack(AckType::Abort, sequence, context)];
        effects.extend(self.unsubscribe(context));
        effects.push(
            context.request(Effect::RecordingSink(RecordingSinkEffect::Discard {
                sink_id: self.sink_id.clone(),
            })),
        );
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::TransferRecording,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::TransferRecording,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed transfer records its terminal error"),
            }),
            _ => None,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::assert_phase_cancels;

    #[test]
    fn every_nonterminal_phase_cancels() {
        for phase in [
            Phase::LoadingCheckpoint,
            Phase::TruncatingSink,
            Phase::Subscribing,
            Phase::Starting,
            Phase::Transferring,
            Phase::Appending,
            Phase::Finalizing,
            Phase::Acknowledging,
            Phase::Confirming,
        ] {
            let mut workflow = RecordingTransferWorkflow::new(
                DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
                RecordingUuid::from_bytes([1; 16]),
                RecordingSinkId::new("sink-1").unwrap(),
                1_024,
                CancellationId::from_bytes([1; 16]),
            );
            workflow.phase = phase;
            assert_phase_cancels(&mut workflow, Operation::TransferRecording);
        }
    }
}
