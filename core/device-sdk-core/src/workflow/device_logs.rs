use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, Effect, EffectRequest, HostEvent, HostEventKind,
        RequestId, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{
        CHAR_DEVICE_LOG_CONTROL, CHAR_DEVICE_LOG_DATA, DEVICE_LOG_CMD_START, DEVICE_LOG_CMD_STOP,
        SERVICE_BOTA_DIAGNOSTICS,
    },
    model::DeviceSerialNumber,
    protocol::DeviceLogDecoder,
    workflow::{WorkflowContext, WorkflowReducer},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Subscribing,
    Starting,
    Active,
    Failed,
}

pub(crate) struct DeviceLogsWorkflow {
    _device: DeviceSerialNumber,
    cancellation_id: CancellationId,
    phase: Phase,
    subscription_request_id: Option<RequestId>,
    start_request_id: Option<RequestId>,
    decoder: DeviceLogDecoder,
    terminal_error: Option<DeviceSdkError>,
}

impl DeviceLogsWorkflow {
    pub(crate) fn new(device: DeviceSerialNumber, cancellation_id: CancellationId) -> Self {
        Self {
            _device: device,
            cancellation_id,
            phase: Phase::Subscribing,
            subscription_request_id: None,
            start_request_id: None,
            decoder: DeviceLogDecoder::default(),
            terminal_error: None,
        }
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        let request = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_DIAGNOSTICS.into(),
            characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
        }));
        self.subscription_request_id = Some(request.request_id);
        request
    }

    fn start_logging(&mut self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        self.phase = Phase::Starting;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_DIAGNOSTICS.into(),
            characteristic_uuid: CHAR_DEVICE_LOG_CONTROL.into(),
            payload: vec![DEVICE_LOG_CMD_START],
            with_response: true,
        }));
        self.start_request_id = Some(request.request_id);
        request
    }

    fn stop_logging(&self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_DIAGNOSTICS.into(),
            characteristic_uuid: CHAR_DEVICE_LOG_CONTROL.into(),
            payload: vec![DEVICE_LOG_CMD_STOP],
            with_response: true,
        }))
    }

    fn unsubscribe(&mut self, context: &mut WorkflowContext<'_>) -> Option<EffectRequest> {
        self.subscription_request_id.take()?;
        Some(context.request(Effect::Ble(BleEffect::Unsubscribe {
            service_uuid: SERVICE_BOTA_DIAGNOSTICS.into(),
            characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
        })))
    }

    fn cleanup(
        &mut self,
        stop_device: bool,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        let mut effects = Vec::new();
        if stop_device {
            effects.push(self.stop_logging(context));
        }
        if let Some(unsubscribe) = self.unsubscribe(context) {
            effects.push(unsubscribe);
        }
        self.start_request_id = None;
        self.decoder.reset();
        effects
    }

    fn fail(
        &mut self,
        error: DeviceSdkError,
        stop_device: bool,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Failed;
        self.terminal_error = Some(error.clone());
        let mut effects = self.cleanup(stop_device, context);
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn emit_logs(
        &mut self,
        packet: &[u8],
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.decoder
            .push(packet)
            .into_iter()
            .map(|event| context.request(Effect::Notify(WorkflowNotification::DeviceLog { event })))
            .collect()
    }
}

impl WorkflowReducer for DeviceLogsWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        vec![
            context.request(Effect::Notify(WorkflowNotification::Started {
                operation: Operation::ReadDeviceLogs,
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
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_DEVICE_LOG_DATA =>
            {
                Ok(vec![self.start_logging(context)])
            }
            (Phase::Starting, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.start_request_id =>
            {
                self.start_request_id = None;
                self.phase = Phase::Active;
                Ok(Vec::new())
            }
            (
                Phase::Starting | Phase::Active,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid,
                    value,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_DEVICE_LOG_DATA =>
            {
                Ok(self.emit_logs(&value, context))
            }
            (Phase::Starting, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.start_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::FeatureUnavailable,
                        Operation::ReadDeviceLogs,
                        false,
                    )
                    .with_detail(format!(
                        "device logging start was rejected with code {platform_code:?}"
                    )),
                    false,
                    context,
                ))
            }
            (Phase::Subscribing, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.subscription_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::ConnectionFailed,
                        Operation::ReadDeviceLogs,
                        true,
                    )
                    .with_detail(format!(
                        "device log subscription failed with code {platform_code:?}"
                    )),
                    false,
                    context,
                ))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. })) => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::NotConnected, Operation::ReadDeviceLogs, true)
                    .with_detail("device disconnected while streaming logs"),
                false,
                context,
            )),
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.subscription_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::ConnectionFailed,
                        Operation::ReadDeviceLogs,
                        true,
                    )
                    .with_detail(format!(
                        "device log stream ended with code {platform_code:?}"
                    )),
                    matches!(self.phase, Phase::Active),
                    context,
                ))
            }
            _ => Err(DeviceSdkError::new(
                ErrorCode::UnexpectedEvent,
                Operation::ReadDeviceLogs,
                false,
            )
            .with_detail("event does not belong to the active device-log phase")),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let stop_device = matches!(self.phase, Phase::Starting | Phase::Active);
        let mut effects = self.cleanup(stop_device, context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::ReadDeviceLogs,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed device-log workflow records its terminal error"),
            }),
            _ => None,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}
