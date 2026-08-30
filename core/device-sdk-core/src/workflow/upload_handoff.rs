use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, Effect, EffectRequest, HostEvent, HostEventKind,
        ProgressEffect, RequestId, TimerEffect, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{
        CHAR_DEVICE_STATUS, CHAR_TRANSFER_CONTROL, CHAR_TRANSFER_STATUS, SERVICE_BOTA_CONTROL,
        SERVICE_BOTA_STORAGE, TRIGGER_UPLOAD_BUSY,
    },
    model::{
        DeviceSerialNumber, DeviceStatus, RecordingUuid, UploadDestinationId, UploadSessionId,
    },
    protocol::{
        TransferCommand, encode_transfer_command, parse_device_status,
        parse_trigger_upload_response,
    },
    workflow::{WorkflowContext, WorkflowReducer},
};

const TRIGGER_TIMEOUT_ID: u64 = 1;
const TRIGGER_TIMEOUT_MS: u64 = 5_000;
const MONITOR_TIMER_ID: u64 = 2;
const MONITOR_INTERVAL_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StatusPurpose {
    Initial,
    Busy,
    TriggerFailure,
    Monitor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    ReadingStatus,
    Subscribing,
    Triggering,
    AwaitingTrigger,
    WaitingToMonitor,
    Completed,
    Failed,
}

pub(crate) struct UploadHandoffWorkflow {
    _device: DeviceSerialNumber,
    recording: RecordingUuid,
    upload_id: UploadSessionId,
    destination_id: UploadDestinationId,
    cancellation_id: CancellationId,
    phase: Phase,
    status_purpose: StatusPurpose,
    initial_pending: u8,
    status_request_id: Option<RequestId>,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    timer_request_id: Option<RequestId>,
    timer_id: Option<u64>,
    terminal_error: Option<DeviceSdkError>,
}

impl UploadHandoffWorkflow {
    pub(crate) fn new(
        device: DeviceSerialNumber,
        recording: RecordingUuid,
        upload_id: UploadSessionId,
        destination_id: UploadDestinationId,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            _device: device,
            recording,
            upload_id,
            destination_id,
            cancellation_id,
            phase: Phase::ReadingStatus,
            status_purpose: StatusPurpose::Initial,
            initial_pending: 0,
            status_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            timer_request_id: None,
            timer_id: None,
            terminal_error: None,
        }
    }

    fn read_status(
        &mut self,
        purpose: StatusPurpose,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::ReadingStatus;
        self.status_purpose = purpose;
        let request = context.request(Effect::Ble(BleEffect::Read {
            service_uuid: SERVICE_BOTA_CONTROL.into(),
            characteristic_uuid: CHAR_DEVICE_STATUS.into(),
        }));
        self.status_request_id = Some(request.request_id);
        vec![request]
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Subscribing;
        let request = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
        }));
        self.subscription_request_id = Some(request.request_id);
        vec![request]
    }

    fn trigger(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Triggering;
        let payload = encode_transfer_command(TransferCommand::TriggerDeviceUpload)
            .expect("fixed trigger command always fits its wire format");
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload,
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn schedule_timer(
        &mut self,
        timer_id: u64,
        delay_ms: u64,
        phase: Phase,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = phase;
        self.timer_id = Some(timer_id);
        let request = context.request(Effect::Timer(TimerEffect::Schedule { timer_id, delay_ms }));
        self.timer_request_id = Some(request.request_id);
        vec![request]
    }

    fn monitor(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.schedule_timer(
            MONITOR_TIMER_ID,
            MONITOR_INTERVAL_MS,
            Phase::WaitingToMonitor,
            context,
        )
    }

    fn cancel_timer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.timer_request_id = None;
        let Some(timer_id) = self.timer_id.take() else {
            return Vec::new();
        };
        vec![context.request(Effect::Timer(TimerEffect::Cancel { timer_id }))]
    }

    fn unsubscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if self.subscription_request_id.take().is_none() {
            return Vec::new();
        }
        vec![context.request(Effect::Ble(BleEffect::Unsubscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
        }))]
    }

    fn cleanup(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = self.cancel_timer(context);
        effects.extend(self.unsubscribe(context));
        effects
    }

    fn complete_direct(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        let mut effects = self.cleanup(context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::Upload,
            })),
        );
        effects
    }

    fn complete_with_fallback(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        let mut effects = self.cleanup(context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::BleFallbackReady {
                recording: self.recording,
                upload_id: self.upload_id.clone(),
                destination_id: self.destination_id.clone(),
            })),
        );
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::Upload,
            })),
        );
        effects
    }

    fn complete_preserved(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        let mut effects = self.cleanup(context);
        effects.push(context.request(Effect::Notify(
            WorkflowNotification::DeviceUploadPreserved {
                upload_id: self.upload_id.clone(),
            },
        )));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::Upload,
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
        let mut effects = self.cleanup(context);
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn ownership_unknown(platform_code: Option<i64>) -> DeviceSdkError {
        DeviceSdkError::new(ErrorCode::UploadOwnershipUnknown, Operation::Upload, true).with_detail(
            format!("fresh device upload status is unavailable with code {platform_code:?}"),
        )
    }

    fn handle_status(
        &mut self,
        status: DeviceStatus,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        match self.status_purpose {
            StatusPurpose::Initial => {
                self.initial_pending = status.pending_recordings;
                if status.pending_recordings == 0 {
                    self.complete_direct(context)
                } else if status.flags.sync_active {
                    self.monitor(context)
                } else if status.flags.wifi_connected || status.flags.lte_connected {
                    self.subscribe(context)
                } else {
                    self.complete_with_fallback(context)
                }
            }
            StatusPurpose::Busy => {
                if status.flags.sync_active {
                    self.monitor(context)
                } else {
                    self.complete_preserved(context)
                }
            }
            StatusPurpose::TriggerFailure => {
                if status.flags.sync_active {
                    self.monitor(context)
                } else {
                    self.complete_with_fallback(context)
                }
            }
            StatusPurpose::Monitor => {
                if status.flags.sync_active {
                    let completed = self
                        .initial_pending
                        .saturating_sub(status.pending_recordings);
                    let progress = context.request(Effect::Progress(ProgressEffect {
                        completed_units: u64::from(completed),
                        total_units: u64::from(self.initial_pending),
                    }));
                    let mut effects = vec![progress];
                    effects.extend(self.monitor(context));
                    effects
                } else if status.pending_recordings == 0 {
                    self.complete_direct(context)
                } else {
                    self.complete_with_fallback(context)
                }
            }
        }
    }
}

impl WorkflowReducer for UploadHandoffWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::Upload,
        }));
        let mut effects = vec![started];
        effects.extend(self.read_status(StatusPurpose::Initial, context));
        effects
    }

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let request_id = event.request_id;
        match (self.phase, event.kind) {
            (Phase::ReadingStatus, HostEventKind::Ble(BleEvent::ReadCompleted { value }))
                if Some(request_id) == self.status_request_id =>
            {
                self.status_request_id = None;
                let status = match parse_device_status(&value) {
                    Ok(status) => status,
                    Err(_) => return Ok(self.fail(Self::ownership_unknown(None), context)),
                };
                Ok(self.handle_status(status, context))
            }
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_TRANSFER_STATUS =>
            {
                Ok(self.trigger(context))
            }
            (Phase::Triggering, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.schedule_timer(
                    TRIGGER_TIMEOUT_ID,
                    TRIGGER_TIMEOUT_MS,
                    Phase::AwaitingTrigger,
                    context,
                ))
            }
            (
                Phase::AwaitingTrigger,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid,
                    value,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_TRANSFER_STATUS =>
            {
                let Some(response) = parse_trigger_upload_response(&value)? else {
                    return Ok(Vec::new());
                };
                let mut effects = self.cancel_timer(context);
                effects.extend(self.unsubscribe(context));
                if response.accepted {
                    effects.extend(self.monitor(context));
                } else if response.error_code == Some(TRIGGER_UPLOAD_BUSY) {
                    effects.extend(self.read_status(StatusPurpose::Busy, context));
                } else {
                    effects.extend(self.read_status(StatusPurpose::TriggerFailure, context));
                }
                Ok(effects)
            }
            (
                Phase::AwaitingTrigger,
                HostEventKind::TimerFired {
                    timer_id: TRIGGER_TIMEOUT_ID,
                },
            ) if Some(request_id) == self.timer_request_id => {
                self.timer_request_id = None;
                self.timer_id = None;
                let mut effects = self.unsubscribe(context);
                effects.extend(self.read_status(StatusPurpose::TriggerFailure, context));
                Ok(effects)
            }
            (
                Phase::WaitingToMonitor,
                HostEventKind::TimerFired {
                    timer_id: MONITOR_TIMER_ID,
                },
            ) if Some(request_id) == self.timer_request_id => {
                self.timer_request_id = None;
                self.timer_id = None;
                Ok(self.read_status(StatusPurpose::Monitor, context))
            }
            (Phase::ReadingStatus, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.status_request_id =>
            {
                self.status_request_id = None;
                Ok(self.fail(Self::ownership_unknown(platform_code), context))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. })) => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::NotConnected, Operation::Upload, true)
                    .with_detail("BLE observation detached during device upload"),
                context,
            )),
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [self.subscription_request_id, self.write_request_id]
                    .contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, Operation::Upload, true)
                        .with_detail(format!(
                            "device upload trigger failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            _ => Err(
                DeviceSdkError::new(ErrorCode::UnexpectedEvent, Operation::Upload, false)
                    .with_detail("event does not belong to the active upload-handoff phase"),
            ),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = self.cleanup(context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::Upload,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::Upload,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed upload handoff records its terminal error"),
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
            Phase::ReadingStatus,
            Phase::Subscribing,
            Phase::Triggering,
            Phase::AwaitingTrigger,
            Phase::WaitingToMonitor,
        ] {
            let mut workflow = UploadHandoffWorkflow::new(
                DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
                RecordingUuid::from_bytes([1; 16]),
                UploadSessionId::new("upload-1").unwrap(),
                UploadDestinationId::new("destination-1").unwrap(),
                CancellationId::from_bytes([1; 16]),
            );
            workflow.phase = phase;
            assert_phase_cancels(&mut workflow, Operation::Upload);
        }
    }
}
