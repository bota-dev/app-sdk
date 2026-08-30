use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, Effect, EffectRequest, HostEvent, HostEventKind,
        RequestId, TimerEffect, WorkflowNotification,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    workflow::{WorkflowContext, WorkflowReducer},
};

const DISCOVERY_TIMER_ID: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Scanning,
    Stopping,
    Completed,
    Cancelled,
}

pub(crate) struct DiscoveryWorkflow {
    cancellation_id: CancellationId,
    timeout_ms: u64,
    allow_duplicates: bool,
    scan_request_id: Option<RequestId>,
    timer_request_id: Option<RequestId>,
    stop_request_id: Option<RequestId>,
    phase: Phase,
}

impl DiscoveryWorkflow {
    pub(crate) fn new(
        cancellation_id: CancellationId,
        timeout_ms: u64,
        allow_duplicates: bool,
    ) -> Self {
        Self {
            cancellation_id,
            timeout_ms,
            allow_duplicates,
            scan_request_id: None,
            timer_request_id: None,
            stop_request_id: None,
            phase: Phase::Scanning,
        }
    }
}

impl WorkflowReducer for DiscoveryWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::Discover,
        }));
        let scan = context.request(Effect::Ble(BleEffect::StartScan {
            allow_duplicates: self.allow_duplicates,
        }));
        let timer = context.request(Effect::Timer(TimerEffect::Schedule {
            timer_id: DISCOVERY_TIMER_ID,
            delay_ms: self.timeout_ms,
        }));
        self.scan_request_id = Some(scan.request_id);
        self.timer_request_id = Some(timer.request_id);
        vec![started, scan, timer]
    }

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        match (&self.phase, event.request_id, event.kind) {
            (
                Phase::Scanning,
                request_id,
                HostEventKind::Ble(BleEvent::ScanResult { candidate }),
            ) if Some(request_id) == self.scan_request_id => Ok(vec![context.request(
                Effect::Notify(WorkflowNotification::DeviceDiscovered { candidate }),
            )]),
            (
                Phase::Scanning,
                request_id,
                HostEventKind::TimerFired {
                    timer_id: DISCOVERY_TIMER_ID,
                },
            ) if Some(request_id) == self.timer_request_id => {
                let stop = context.request(Effect::Ble(BleEffect::StopScan));
                self.stop_request_id = Some(stop.request_id);
                self.phase = Phase::Stopping;
                Ok(vec![stop])
            }
            (Phase::Stopping, request_id, HostEventKind::Ble(BleEvent::ScanStopped))
                if Some(request_id) == self.stop_request_id =>
            {
                self.phase = Phase::Completed;
                Ok(vec![context.request(Effect::Notify(
                    WorkflowNotification::Completed {
                        operation: Operation::Discover,
                    },
                ))])
            }
            _ => Err(unexpected_event()),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = Vec::new();
        if self.phase == Phase::Scanning {
            effects.push(context.request(Effect::Ble(BleEffect::StopScan)));
        }
        if matches!(self.phase, Phase::Scanning | Phase::Stopping) {
            effects.push(context.request(Effect::Timer(TimerEffect::Cancel {
                timer_id: DISCOVERY_TIMER_ID,
            })));
        }
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::Discover,
            })),
        );
        self.phase = Phase::Cancelled;
        effects
    }

    fn terminal_status(&self) -> Option<crate::engine::WorkflowStatus> {
        (self.phase == Phase::Completed).then_some(crate::engine::WorkflowStatus::Completed {
            operation: Operation::Discover,
        })
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}

fn unexpected_event() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::UnexpectedEvent, Operation::Discover, false)
        .with_detail("event does not belong to the active discovery request")
}
