use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, Effect, EffectRequest, HostEvent, HostEventKind,
        RecordingSinkEffect, RequestId, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{CHAR_RECORDING_TRANSFER, CHAR_TRANSFER_CONTROL, SERVICE_BOTA_STORAGE},
    model::{DeviceSerialNumber, RecordingSinkId, RecordingUuid},
    protocol::{AckType, TransferCommand, TransferPacket, encode_ack, encode_transfer_command,
        parse_transfer_packet},
    workflow::{WorkflowContext, WorkflowReducer},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Subscribing,
    Starting,
    Transferring,
    Accepting,
    Finalizing,
    Acknowledging,
    Confirming,
    Completed,
    Failed,
}

pub(crate) struct StreamingTransferWorkflow {
    recording: RecordingUuid,
    sink_id: RecordingSinkId,
    cancellation_id: CancellationId,
    phase: Phase,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    sink_request_id: Option<RequestId>,
    last_sequence: Option<u16>,
    pending_sequence: Option<u16>,
    pending_units: u64,
    completed_units: u64,
    eof_sequence: u16,
    encrypted: Option<bool>,
    e2e_header_received: bool,
    paused: bool,
    uploaded_chunks: u32,
    terminal_error: Option<DeviceSdkError>,
}

impl StreamingTransferWorkflow {
    pub(crate) fn new(
        _device: DeviceSerialNumber,
        recording: RecordingUuid,
        sink_id: RecordingSinkId,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            recording,
            sink_id,
            cancellation_id,
            phase: Phase::Subscribing,
            subscription_request_id: None,
            write_request_id: None,
            sink_request_id: None,
            last_sequence: None,
            pending_sequence: None,
            pending_units: 0,
            completed_units: 0,
            eof_sequence: 0,
            encrypted: None,
            e2e_header_received: false,
            paused: false,
            uploaded_chunks: 0,
            terminal_error: None,
        }
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        let request = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
        }));
        self.subscription_request_id = Some(request.request_id);
        request
    }

    fn start_transfer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Starting;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload: encode_transfer_command(TransferCommand::Start(self.recording))
                .expect("recording UUID always fits the transfer command"),
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn accept(
        &mut self,
        sequence: Option<u16>,
        units: u64,
        effect: RecordingSinkEffect,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Accepting;
        self.pending_sequence = sequence;
        self.pending_units = units;
        let request = context.request(Effect::RecordingSink(effect));
        self.sink_request_id = Some(request.request_id);
        vec![request]
    }

    fn resume_if_needed(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if !self.paused {
            return Vec::new();
        }
        self.paused = false;
        vec![context.request(Effect::Notify(WorkflowNotification::StreamingResumed))]
    }

    fn finalize(
        &mut self,
        sequence: u16,
        encrypted: bool,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Finalizing;
        self.eof_sequence = sequence;
        let expected_chunks = if encrypted { u32::from(sequence) } else { 0 };
        let request = context.request(Effect::RecordingSink(
            RecordingSinkEffect::FinalizeStreaming {
                sink_id: self.sink_id.clone(),
                encrypted,
                expected_chunks,
                total_units: self.completed_units,
            },
        ));
        self.sink_request_id = Some(request.request_id);
        vec![request]
    }

    fn acknowledge(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Acknowledging;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            payload: encode_ack(AckType::Ack, self.eof_sequence)
                .expect("fixed acknowledgement always fits the wire format"),
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn confirm(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Confirming;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload: encode_transfer_command(TransferCommand::Confirm(self.recording))
                .expect("recording UUID always fits the transfer command"),
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
        effects.push(context.request(Effect::Notify(WorkflowNotification::StreamingCompleted {
            total_units: self.completed_units,
            uploaded_chunks: self.uploaded_chunks,
            encrypted: self.encrypted.unwrap_or(false),
        })));
        effects
    }

    fn fail(&mut self, error: DeviceSdkError, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Failed;
        self.terminal_error = Some(error.clone());
        let mut effects = self.unsubscribe(context);
        effects.push(context.request(Effect::RecordingSink(
            RecordingSinkEffect::DiscardStreaming {
                sink_id: self.sink_id.clone(),
            },
        )));
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn protocol_failure(&mut self, detail: &str, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.fail(
            DeviceSdkError::new(
                ErrorCode::ProtocolRejected,
                Operation::TransferRecording,
                false,
            )
            .with_detail(detail),
            context,
        )
    }
}

impl WorkflowReducer for StreamingTransferWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        vec![
            context.request(Effect::Notify(WorkflowNotification::Started {
                operation: Operation::TransferRecording,
            })),
            self.subscribe(context),
        ]
    }

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let request_id = event.request_id;
        match (self.phase, event.kind) {
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed { characteristic_uuid }),
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
                HostEventKind::Ble(BleEvent::Notification { characteristic_uuid, value }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_RECORDING_TRANSFER =>
            {
                let packet = match parse_transfer_packet(&value) {
                    Ok(packet) => packet,
                    Err(error) => return Ok(self.fail(error, context)),
                };
                match packet {
                    TransferPacket::Data { sequence, data } => {
                        if self.encrypted == Some(true) {
                            return Ok(self.protocol_failure("live transfer mixed plaintext and encrypted packets", context));
                        }
                        let expected = self.last_sequence.map_or(0, |value| value.wrapping_add(1));
                        if self.last_sequence.is_some_and(|value| sequence <= value) {
                            return Ok(Vec::new());
                        }
                        if sequence != expected {
                            return Ok(self.protocol_failure("live plaintext transfer has a sequence gap", context));
                        }
                        self.encrypted = Some(false);
                        let mut effects = self.resume_if_needed(context);
                        effects.extend(self.accept(
                            Some(sequence),
                            data.len() as u64,
                            RecordingSinkEffect::AppendStreamingPlaintext {
                                sink_id: self.sink_id.clone(),
                                sequence,
                                payload: data,
                            },
                            context,
                        ));
                        Ok(effects)
                    }
                    TransferPacket::Paused { bytes_sent, .. } => {
                        self.paused = true;
                        Ok(vec![context.request(Effect::Notify(
                            WorkflowNotification::StreamingPaused {
                                completed_units: bytes_sent
                                    .map(u64::from)
                                    .unwrap_or(self.completed_units),
                            },
                        ))])
                    }
                    TransferPacket::Eof { sequence, .. } => {
                        if self.encrypted == Some(true) {
                            return Ok(self.protocol_failure("live transfer mixed plaintext and encrypted packets", context));
                        }
                        self.encrypted = Some(false);
                        Ok(self.finalize(sequence, false, context))
                    }
                    TransferPacket::E2eStart { ephemeral_public_key, salt } => {
                        if self.encrypted == Some(false) {
                            return Ok(self.protocol_failure("live transfer mixed plaintext and encrypted packets", context));
                        }
                        self.encrypted = Some(true);
                        if self.e2e_header_received {
                            return Ok(Vec::new());
                        }
                        self.e2e_header_received = true;
                        Ok(self.accept(
                            None,
                            0,
                            RecordingSinkEffect::BeginStreamingEncrypted {
                                sink_id: self.sink_id.clone(),
                                ephemeral_public_key,
                                salt,
                            },
                            context,
                        ))
                    }
                    TransferPacket::EncryptedData { sequence, chunk } => {
                        if self.encrypted != Some(true) || !self.e2e_header_received || chunk.len() < 16 {
                            return Ok(self.protocol_failure("live encrypted transfer is malformed", context));
                        }
                        if self.last_sequence.is_some_and(|value| sequence <= value) {
                            return Ok(Vec::new());
                        }
                        let mut effects = self.resume_if_needed(context);
                        effects.extend(self.accept(
                            Some(sequence),
                            (chunk.len() - 16) as u64,
                            RecordingSinkEffect::AppendStreamingEncrypted {
                                sink_id: self.sink_id.clone(),
                                sequence,
                                payload: chunk,
                            },
                            context,
                        ));
                        Ok(effects)
                    }
                    TransferPacket::EncryptedEof { sequence } => {
                        if self.encrypted != Some(true) || !self.e2e_header_received {
                            return Ok(self.protocol_failure("live encrypted transfer is missing its session header", context));
                        }
                        Ok(self.finalize(sequence, true, context))
                    }
                    TransferPacket::Sha256(_) => Ok(Vec::new()),
                    TransferPacket::Error { code, .. } => Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::TransferRecording,
                            code != 0x14,
                        )
                        .with_protocol_status(u16::from(code))
                        .with_detail("device rejected live recording transfer"),
                        context,
                    )),
                }
            }
            (Phase::Accepting, HostEventKind::StreamingSinkAccepted { received_units })
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                let expected = self.completed_units.saturating_add(self.pending_units);
                if received_units != expected {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::PersistenceFailed,
                            Operation::TransferRecording,
                            true,
                        )
                        .with_detail("streaming sink reported inconsistent accepted units"),
                        context,
                    ));
                }
                self.completed_units = received_units;
                if let Some(sequence) = self.pending_sequence.take() {
                    self.last_sequence = Some(sequence);
                }
                self.pending_units = 0;
                self.phase = Phase::Transferring;
                Ok(Vec::new())
            }
            (
                Phase::Finalizing,
                HostEventKind::StreamingSinkFinalized { uploaded_chunks, total_units },
            ) if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                if total_units != self.completed_units {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::PersistenceFailed,
                            Operation::TransferRecording,
                            false,
                        )
                        .with_detail("streaming sink finalized a different byte count"),
                        context,
                    ));
                }
                self.uploaded_chunks = uploaded_chunks;
                Ok(self.acknowledge(context))
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
            (_, HostEventKind::StreamingSinkFailed { platform_code })
                if Some(request_id) == self.sink_request_id =>
            {
                self.sink_request_id = None;
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::PersistenceFailed,
                        Operation::TransferRecording,
                        true,
                    )
                    .with_detail(format!("streaming sink failed with code {platform_code:?}")),
                    context,
                ))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. })) => Ok(self.fail(
                DeviceSdkError::new(
                    ErrorCode::NotConnected,
                    Operation::TransferRecording,
                    true,
                )
                .with_detail("device disconnected during live recording transfer"),
                context,
            )),
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [self.subscription_request_id, self.write_request_id].contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::ConnectionFailed,
                        Operation::TransferRecording,
                        true,
                    )
                    .with_detail(format!("BLE live transfer failed with code {platform_code:?}")),
                    context,
                ))
            }
            _ => Err(DeviceSdkError::new(
                ErrorCode::UnexpectedEvent,
                Operation::TransferRecording,
                false,
            )
            .with_detail("event does not belong to the active streaming-transfer phase")),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let sequence = self.last_sequence.map_or(0, |value| value.wrapping_add(1));
        let mut effects = vec![context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            payload: encode_ack(AckType::Abort, sequence)
                .expect("fixed acknowledgement always fits the wire format"),
            with_response: true,
        }))];
        effects.extend(self.unsubscribe(context));
        effects.push(context.request(Effect::RecordingSink(
            RecordingSinkEffect::DiscardStreaming {
                sink_id: self.sink_id.clone(),
            },
        )));
        effects.push(context.request(Effect::Notify(WorkflowNotification::Cancelled {
            operation: Operation::TransferRecording,
        })));
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::TransferRecording,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self.terminal_error.clone().expect("failed workflow has an error"),
            }),
            _ => None,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}
