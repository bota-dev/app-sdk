use std::{cmp::Reverse, collections::BTreeSet};

use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, CheckpointPhase, Effect, EffectRequest, HostEvent,
        HostEventKind, PersistenceEffect, RequestId, TimerEffect, WorkflowCheckpoint, WorkflowKind,
        WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{CHAR_SERIAL_NUMBER, SERVICE_DEVICE_INFO},
    model::{ConnectionMode, DeviceCandidate, DeviceSerialNumber, ReconnectHint},
    workflow::{WorkflowContext, WorkflowReducer},
};

const MANUAL_CONNECTION_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Pending,
    Scanning,
    StoppingScan,
    Connecting,
    Discovering,
    ReadingSerial,
    Disconnecting,
    Persisting,
    Completed,
    Failed,
}

enum DisconnectOutcome {
    ProbeNext,
    Fail(DeviceSdkError),
}

pub(crate) struct ConnectionWorkflow {
    device: DeviceSerialNumber,
    mode: ConnectionMode,
    cancellation_id: CancellationId,
    hint: ReconnectHint,
    phase: Phase,
    discovered: Vec<DeviceCandidate>,
    probe_candidates: Vec<DeviceCandidate>,
    attempted_peripheral_ids: BTreeSet<String>,
    candidate_index: usize,
    active_candidate: Option<DeviceCandidate>,
    verify_serial: bool,
    retry_count: u16,
    next_timer_id: u64,
    scan_request_id: Option<RequestId>,
    scan_timer_request_id: Option<RequestId>,
    scan_timer_id: Option<u64>,
    stop_scan_request_id: Option<RequestId>,
    connect_request_id: Option<RequestId>,
    attempt_timer_request_id: Option<RequestId>,
    attempt_timer_id: Option<u64>,
    discover_request_id: Option<RequestId>,
    read_request_id: Option<RequestId>,
    disconnect_request_id: Option<RequestId>,
    persist_request_id: Option<RequestId>,
    checkpoint_request_ids: BTreeSet<RequestId>,
    disconnect_outcome: Option<DisconnectOutcome>,
    terminal_error: Option<DeviceSdkError>,
}

impl ConnectionWorkflow {
    pub(crate) fn manual(
        device: DeviceSerialNumber,
        candidate: DeviceCandidate,
        cancellation_id: CancellationId,
    ) -> Self {
        let mut workflow = Self::base(
            device,
            ConnectionMode::Manual,
            cancellation_id,
            ReconnectHint::default(),
        );
        workflow.active_candidate = Some(candidate);
        workflow.verify_serial = true;
        workflow
    }

    pub(crate) fn reconnect(
        device: DeviceSerialNumber,
        hint: ReconnectHint,
        cancellation_id: CancellationId,
    ) -> Self {
        Self::base(device, ConnectionMode::Reconnect, cancellation_id, hint)
    }

    fn base(
        device: DeviceSerialNumber,
        mode: ConnectionMode,
        cancellation_id: CancellationId,
        hint: ReconnectHint,
    ) -> Self {
        Self {
            device,
            mode,
            cancellation_id,
            hint,
            phase: Phase::Pending,
            discovered: Vec::new(),
            probe_candidates: Vec::new(),
            attempted_peripheral_ids: BTreeSet::new(),
            candidate_index: 0,
            active_candidate: None,
            verify_serial: false,
            retry_count: 0,
            next_timer_id: 1,
            scan_request_id: None,
            scan_timer_request_id: None,
            scan_timer_id: None,
            stop_scan_request_id: None,
            connect_request_id: None,
            attempt_timer_request_id: None,
            attempt_timer_id: None,
            discover_request_id: None,
            read_request_id: None,
            disconnect_request_id: None,
            persist_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            disconnect_outcome: None,
            terminal_error: None,
        }
    }

    pub(crate) fn operation(&self) -> Operation {
        match self.mode {
            ConnectionMode::Manual => Operation::Connect,
            ConnectionMode::Reconnect => Operation::Reconnect,
        }
    }

    fn begin_scan(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Scanning;
        let scan = context.request(Effect::Ble(BleEffect::StartScan {
            allow_duplicates: true,
        }));
        let (timer_id, timer) = self.schedule_timer(self.hint.scan_timeout_ms, context);
        self.scan_request_id = Some(scan.request_id);
        self.scan_timer_request_id = Some(timer.request_id);
        self.scan_timer_id = Some(timer_id);
        vec![
            scan,
            timer,
            self.checkpoint(CheckpointPhase::Reconnecting, context),
        ]
    }

    fn stop_scan(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::StoppingScan;
        let stop = context.request(Effect::Ble(BleEffect::StopScan));
        self.disconnect_request_id = None;
        self.discover_request_id = None;
        self.read_request_id = None;
        self.connect_request_id = None;
        let mut effects = Vec::new();
        if let Some(timer_id) = self.scan_timer_id {
            effects.push(context.request(Effect::Timer(TimerEffect::Cancel { timer_id })));
        }
        self.scan_request_id = None;
        self.scan_timer_request_id = None;
        self.scan_timer_id = None;
        self.stop_scan_request_id = Some(stop.request_id);
        effects.push(stop);
        effects.push(self.checkpoint(CheckpointPhase::Reconnecting, context));
        effects
    }

    fn begin_connection(
        &mut self,
        candidate: DeviceCandidate,
        verify_serial: bool,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Connecting;
        self.attempted_peripheral_ids
            .insert(candidate.peripheral_id.clone());
        self.active_candidate = Some(candidate.clone());
        self.verify_serial = verify_serial;
        self.discover_request_id = None;
        self.read_request_id = None;
        self.disconnect_request_id = None;
        self.persist_request_id = None;
        let connect = context.request(Effect::Ble(BleEffect::Connect {
            peripheral_id: candidate.peripheral_id,
        }));
        let timeout_ms = match self.mode {
            ConnectionMode::Manual => MANUAL_CONNECTION_TIMEOUT_MS,
            ConnectionMode::Reconnect => self.hint.connection_timeout_ms,
        };
        let (timer_id, timer) = self.schedule_timer(timeout_ms, context);
        self.connect_request_id = Some(connect.request_id);
        self.attempt_timer_request_id = Some(timer.request_id);
        self.attempt_timer_id = Some(timer_id);
        vec![
            connect,
            timer,
            self.checkpoint(CheckpointPhase::Connecting, context),
        ]
    }

    fn begin_persist(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Persisting;
        let candidate = self
            .active_candidate
            .clone()
            .expect("connection phases always have an active candidate");
        let persist = context.request(Effect::Persistence(
            PersistenceEffect::SaveConnectionIdentity {
                device: self.device.clone(),
                candidate,
            },
        ));
        self.persist_request_id = Some(persist.request_id);
        let mut effects = self.cancel_attempt_timer(context);
        effects.push(persist);
        effects.push(self.checkpoint(CheckpointPhase::Verifying, context));
        effects
    }

    fn begin_disconnect(
        &mut self,
        outcome: DisconnectOutcome,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Disconnecting;
        self.disconnect_outcome = Some(outcome);
        let candidate = self
            .active_candidate
            .as_ref()
            .expect("disconnect requires an active candidate");
        let disconnect = context.request(Effect::Ble(BleEffect::Disconnect {
            peripheral_id: candidate.peripheral_id.clone(),
        }));
        self.disconnect_request_id = Some(disconnect.request_id);
        let mut effects = self.cancel_attempt_timer(context);
        effects.push(disconnect);
        effects.push(self.checkpoint(CheckpointPhase::Reconnecting, context));
        effects
    }

    fn begin_next_probe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let Some(candidate) = self.probe_candidates.get(self.candidate_index).cloned() else {
            return self.fail(
                DeviceSdkError::new(ErrorCode::DeviceNotFound, Operation::Reconnect, true)
                    .with_detail(format!("device {} was not found", self.device)),
                context,
            );
        };
        self.begin_connection(candidate, true, context)
    }

    fn finish_disconnect(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        match self
            .disconnect_outcome
            .take()
            .expect("disconnect outcome is assigned before the effect")
        {
            DisconnectOutcome::ProbeNext => {
                self.retry_count = self.retry_count.saturating_add(1);
                if self.probe_candidates.is_empty() {
                    self.prepare_probe_candidates();
                } else {
                    self.candidate_index = self.candidate_index.saturating_add(1);
                }
                self.begin_next_probe(context)
            }
            DisconnectOutcome::Fail(error) => self.fail(error, context),
        }
    }

    fn fail(
        &mut self,
        error: DeviceSdkError,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::Failed;
        self.terminal_error = Some(error.clone());
        let mut effects = self.cancel_attempt_timer(context);
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn record_candidate(&mut self, candidate: DeviceCandidate) {
        if let Some(existing) = self
            .discovered
            .iter_mut()
            .find(|existing| existing.peripheral_id == candidate.peripheral_id)
        {
            *existing = candidate;
        } else {
            self.discovered.push(candidate);
        }
    }

    fn is_exact_candidate(&self, candidate: &DeviceCandidate) -> bool {
        if self.hint.stored_peripheral_id.as_deref() == Some(&candidate.peripheral_id) {
            return true;
        }
        self.hint
            .normalized_advertised_address()
            .is_some_and(|wanted| {
                candidate.normalized_advertised_address().as_deref() == Some(wanted.as_str())
            })
    }

    fn prepare_probe_candidates(&mut self) {
        let stored_name = self.hint.stored_name.as_deref();
        let active_id = self
            .active_candidate
            .as_ref()
            .map(|candidate| candidate.peripheral_id.as_str());
        self.probe_candidates = self
            .discovered
            .iter()
            .filter(|candidate| Some(candidate.peripheral_id.as_str()) != active_id)
            .filter(|candidate| {
                !self
                    .attempted_peripheral_ids
                    .contains(&candidate.peripheral_id)
            })
            .filter(|candidate| match stored_name {
                Some(name) => candidate.name.as_deref() == Some(name),
                None => candidate
                    .name
                    .as_deref()
                    .is_some_and(|name| name.starts_with("Bota")),
            })
            .cloned()
            .collect();
        self.probe_candidates
            .sort_by_key(|candidate| Reverse(candidate.rssi));
        self.candidate_index = 0;
    }

    fn schedule_timer(
        &mut self,
        delay_ms: u64,
        context: &mut WorkflowContext<'_>,
    ) -> (u64, EffectRequest) {
        let timer_id = self.next_timer_id;
        self.next_timer_id = self.next_timer_id.saturating_add(1);
        let request = context.request(Effect::Timer(TimerEffect::Schedule { timer_id, delay_ms }));
        (timer_id, request)
    }

    fn cancel_attempt_timer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.attempt_timer_request_id = None;
        let Some(timer_id) = self.attempt_timer_id.take() else {
            return Vec::new();
        };
        vec![context.request(Effect::Timer(TimerEffect::Cancel { timer_id }))]
    }

    fn checkpoint(
        &mut self,
        phase: CheckpointPhase,
        context: &mut WorkflowContext<'_>,
    ) -> EffectRequest {
        let request = context.request(Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: WorkflowCheckpoint {
                workflow: WorkflowKind::Connection,
                operation: self.operation(),
                device: self.device.clone(),
                recording: None,
                phase,
                completed_units: self.candidate_index as u64,
                retry_count: self.retry_count,
                last_sequence: None,
            },
        }));
        self.checkpoint_request_ids.insert(request.request_id);
        request
    }

    fn parse_serial(value: Vec<u8>) -> Result<DeviceSerialNumber, DeviceSdkError> {
        let value = String::from_utf8(value).map_err(|_| {
            DeviceSdkError::new(ErrorCode::IdentityMismatch, Operation::Connect, false)
                .with_detail("serial number is not UTF-8")
        })?;
        DeviceSerialNumber::new(value.trim_matches(['\0', ' ', '\r', '\n'])).map_err(|_| {
            DeviceSdkError::new(ErrorCode::IdentityMismatch, Operation::Connect, false)
                .with_detail("serial number is malformed")
        })
    }
}

impl WorkflowReducer for ConnectionWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: self.operation(),
        }));
        let mut effects = vec![started];
        let next = match self.mode {
            ConnectionMode::Manual => self.begin_connection(
                self.active_candidate
                    .clone()
                    .expect("manual connection requires a candidate"),
                true,
                context,
            ),
            ConnectionMode::Reconnect => self.begin_scan(context),
        };
        effects.extend(next);
        effects
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
            (Phase::Scanning, HostEventKind::Ble(BleEvent::ScanResult { candidate }))
                if Some(request_id) == self.scan_request_id =>
            {
                let exact = self.is_exact_candidate(&candidate);
                self.record_candidate(candidate.clone());
                if exact {
                    self.active_candidate = Some(candidate);
                    self.verify_serial = false;
                    Ok(self.stop_scan(context))
                } else {
                    Ok(Vec::new())
                }
            }
            (Phase::Scanning, HostEventKind::TimerFired { timer_id })
                if Some(request_id) == self.scan_timer_request_id
                    && Some(timer_id) == self.scan_timer_id =>
            {
                Ok(self.stop_scan(context))
            }
            (Phase::StoppingScan, HostEventKind::Ble(BleEvent::ScanStopped))
                if Some(request_id) == self.stop_scan_request_id =>
            {
                self.stop_scan_request_id = None;
                if let Some(candidate) = self.active_candidate.clone() {
                    Ok(self.begin_connection(candidate, false, context))
                } else {
                    self.prepare_probe_candidates();
                    Ok(self.begin_next_probe(context))
                }
            }
            (Phase::Connecting, HostEventKind::Ble(BleEvent::Connected { peripheral_id }))
                if Some(request_id) == self.connect_request_id
                    && self
                        .active_candidate
                        .as_ref()
                        .is_some_and(|candidate| candidate.peripheral_id == peripheral_id) =>
            {
                self.connect_request_id = None;
                self.phase = Phase::Discovering;
                let discover =
                    context.request(Effect::Ble(BleEffect::DiscoverServices { peripheral_id }));
                self.discover_request_id = Some(discover.request_id);
                Ok(vec![
                    discover,
                    self.checkpoint(CheckpointPhase::Verifying, context),
                ])
            }
            (
                Phase::Discovering,
                HostEventKind::Ble(BleEvent::ServicesDiscovered { peripheral_id }),
            ) if Some(request_id) == self.discover_request_id
                && self
                    .active_candidate
                    .as_ref()
                    .is_some_and(|candidate| candidate.peripheral_id == peripheral_id) =>
            {
                self.discover_request_id = None;
                if self.verify_serial {
                    self.phase = Phase::ReadingSerial;
                    let read = context.request(Effect::Ble(BleEffect::Read {
                        service_uuid: SERVICE_DEVICE_INFO.into(),
                        characteristic_uuid: CHAR_SERIAL_NUMBER.into(),
                    }));
                    self.read_request_id = Some(read.request_id);
                    Ok(vec![read])
                } else {
                    Ok(self.begin_persist(context))
                }
            }
            (Phase::ReadingSerial, HostEventKind::Ble(BleEvent::ReadCompleted { value }))
                if Some(request_id) == self.read_request_id =>
            {
                self.read_request_id = None;
                match Self::parse_serial(value) {
                    Ok(read_serial) if read_serial == self.device => {
                        Ok(self.begin_persist(context))
                    }
                    Ok(read_serial) => {
                        let outcome = match self.mode {
                            ConnectionMode::Manual => DisconnectOutcome::Fail(
                                DeviceSdkError::new(
                                    ErrorCode::IdentityMismatch,
                                    Operation::Connect,
                                    false,
                                )
                                .with_detail(format!(
                                    "selected device serial is {read_serial}, expected {}",
                                    self.device
                                )),
                            ),
                            ConnectionMode::Reconnect => DisconnectOutcome::ProbeNext,
                        };
                        Ok(self.begin_disconnect(outcome, context))
                    }
                    Err(error) => {
                        let outcome = match self.mode {
                            ConnectionMode::Manual => DisconnectOutcome::Fail(error),
                            ConnectionMode::Reconnect => DisconnectOutcome::ProbeNext,
                        };
                        Ok(self.begin_disconnect(outcome, context))
                    }
                }
            }
            (Phase::Disconnecting, HostEventKind::Ble(BleEvent::Disconnected { .. }))
                if Some(request_id) == self.disconnect_request_id =>
            {
                self.disconnect_request_id = None;
                Ok(self.finish_disconnect(context))
            }
            (Phase::Persisting, HostEventKind::ConnectionIdentitySaved)
                if Some(request_id) == self.persist_request_id =>
            {
                self.persist_request_id = None;
                self.phase = Phase::Completed;
                let candidate = self
                    .active_candidate
                    .clone()
                    .expect("persisting connection has a candidate");
                Ok(vec![
                    context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)),
                    context.request(Effect::Notify(
                        WorkflowNotification::ConnectionEstablished {
                            device: self.device.clone(),
                            candidate,
                            mode: self.mode,
                        },
                    )),
                    context.request(Effect::Notify(WorkflowNotification::Completed {
                        operation: self.operation(),
                    })),
                ])
            }
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.connect_request_id =>
            {
                self.connect_request_id = None;
                let error =
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, self.operation(), true)
                        .with_detail(format!("BLE connect failed with code {platform_code:?}"));
                if self.mode == ConnectionMode::Reconnect {
                    let mut effects = self.cancel_attempt_timer(context);
                    self.prepare_probe_candidates();
                    self.retry_count = self.retry_count.saturating_add(1);
                    effects.extend(self.begin_next_probe(context));
                    Ok(effects)
                } else {
                    Ok(self.fail(error, context))
                }
            }
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.discover_request_id
                    || Some(request_id) == self.read_request_id =>
            {
                self.discover_request_id = None;
                self.read_request_id = None;
                let error =
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, self.operation(), true)
                        .with_detail(format!(
                            "BLE connection verification failed with code {platform_code:?}"
                        ));
                let outcome = match self.mode {
                    ConnectionMode::Manual => DisconnectOutcome::Fail(error),
                    ConnectionMode::Reconnect => DisconnectOutcome::ProbeNext,
                };
                Ok(self.begin_disconnect(outcome, context))
            }
            (_, HostEventKind::Ble(BleEvent::Failed { .. }))
                if Some(request_id) == self.disconnect_request_id =>
            {
                self.disconnect_request_id = None;
                Ok(self.finish_disconnect(context))
            }
            (_, HostEventKind::TimerFired { timer_id })
                if Some(request_id) == self.attempt_timer_request_id
                    && Some(timer_id) == self.attempt_timer_id =>
            {
                let outcome = match self.mode {
                    ConnectionMode::Manual => DisconnectOutcome::Fail(
                        DeviceSdkError::new(ErrorCode::Timeout, Operation::Connect, true)
                            .with_detail("connection verification timed out"),
                    ),
                    ConnectionMode::Reconnect => DisconnectOutcome::ProbeNext,
                };
                Ok(self.begin_disconnect(outcome, context))
            }
            _ => Err(
                DeviceSdkError::new(ErrorCode::UnexpectedEvent, self.operation(), false)
                    .with_detail("event does not belong to the active connection phase"),
            ),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = Vec::new();
        if self.phase == Phase::Scanning {
            effects.push(context.request(Effect::Ble(BleEffect::StopScan)));
            if let Some(timer_id) = self.scan_timer_id {
                effects.push(context.request(Effect::Timer(TimerEffect::Cancel { timer_id })));
            }
        }
        if let Some(peripheral_id) = self
            .active_candidate
            .as_ref()
            .map(|candidate| candidate.peripheral_id.clone())
        {
            effects.extend(self.cancel_attempt_timer(context));
            effects.push(context.request(Effect::Ble(BleEffect::Disconnect { peripheral_id })));
        }
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: self.operation(),
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: self.operation(),
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed phase records its terminal error"),
            }),
            _ => None,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        self.cancellation_id
    }
}
