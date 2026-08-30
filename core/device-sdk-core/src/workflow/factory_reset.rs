use std::collections::BTreeSet;

use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, CheckpointPhase, Effect, EffectRequest, HostEvent,
        HostEventKind, HostMaterialEffect, PersistenceEffect, RequestId, TimerEffect,
        WorkflowCheckpoint, WorkflowKind, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{
        CHAR_AUTH_NONCE, CHAR_DEVICE_COMMAND, CHAR_PROVISIONING_RESULT,
        DEVICE_CMD_BLE_FACTORY_RESET, DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK,
        PROVISIONING_SUCCESS, SERVICE_BOTA_AUTH, SERVICE_BOTA_CONTROL, SERVICE_BOTA_PROVISIONING,
    },
    model::{
        DeviceSerialNumber, DurableFactoryResetResult, FactoryResetCommandId, HostMaterialId,
        ProvisioningNonce,
    },
    protocol::{encode_bounded_payload, parse_factory_reset_result},
    workflow::{WorkflowContext, WorkflowReducer},
};

const FACTORY_RESET_TIMEOUT_MS: u64 = 30_000;
const FACTORY_RESET_TIMER_ID: u64 = 1;
const FACTORY_RESET_GRANT_LENGTH: usize = 171;

#[derive(Clone, Debug)]
enum Mode {
    Start {
        command_id: FactoryResetCommandId,
        grant_id: HostMaterialId,
    },
    Resume {
        result: DurableFactoryResetResult,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    ReadingNonce,
    PreparingGrant,
    Subscribing,
    WritingGrant,
    WritingOpcode,
    AwaitingResult,
    PersistingResult,
    WritingReceipt,
    DeletingResult,
    Completed,
    Failed,
}

pub(crate) struct FactoryResetWorkflow {
    device: DeviceSerialNumber,
    mode: Mode,
    cancellation_id: CancellationId,
    phase: Phase,
    nonce: Option<ProvisioningNonce>,
    grant: Vec<u8>,
    durable_result: Option<DurableFactoryResetResult>,
    nonce_request_id: Option<RequestId>,
    material_request_id: Option<RequestId>,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    save_request_id: Option<RequestId>,
    delete_request_id: Option<RequestId>,
    timer_request_id: Option<RequestId>,
    checkpoint_request_ids: BTreeSet<RequestId>,
    terminal_error: Option<DeviceSdkError>,
}

impl FactoryResetWorkflow {
    pub(crate) fn start_new(
        device: DeviceSerialNumber,
        command_id: FactoryResetCommandId,
        grant_id: HostMaterialId,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            device,
            mode: Mode::Start {
                command_id,
                grant_id,
            },
            cancellation_id,
            phase: Phase::ReadingNonce,
            nonce: None,
            grant: Vec::new(),
            durable_result: None,
            nonce_request_id: None,
            material_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            save_request_id: None,
            delete_request_id: None,
            timer_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            terminal_error: None,
        }
    }

    pub(crate) fn resume(
        device: DeviceSerialNumber,
        result: DurableFactoryResetResult,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            device,
            mode: Mode::Resume {
                result: result.clone(),
            },
            cancellation_id,
            phase: Phase::Subscribing,
            nonce: None,
            grant: Vec::new(),
            durable_result: Some(result),
            nonce_request_id: None,
            material_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            save_request_id: None,
            delete_request_id: None,
            timer_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            terminal_error: None,
        }
    }

    fn command_id(&self) -> FactoryResetCommandId {
        match &self.mode {
            Mode::Start { command_id, .. } => command_id.clone(),
            Mode::Resume { result } => result.command_id.clone(),
        }
    }

    fn checkpoint(
        &mut self,
        phase: CheckpointPhase,
        context: &mut WorkflowContext<'_>,
    ) -> EffectRequest {
        let request = context.request(Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: WorkflowCheckpoint {
                workflow: WorkflowKind::FactoryReset,
                operation: Operation::FactoryReset,
                device: self.device.clone(),
                recording: None,
                phase,
                completed_units: 0,
                retry_count: 0,
                last_sequence: None,
            },
        }));
        self.checkpoint_request_ids.insert(request.request_id);
        request
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Subscribing;
        let subscribe = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_PROVISIONING.into(),
            characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
        }));
        self.subscription_request_id = Some(subscribe.request_id);
        vec![subscribe]
    }

    fn write_grant(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::WritingGrant;
        let write = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_CONTROL.into(),
            characteristic_uuid: CHAR_DEVICE_COMMAND.into(),
            payload: self.grant.clone(),
            with_response: true,
        }));
        self.write_request_id = Some(write.request_id);
        vec![write]
    }

    fn write_opcode(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.grant.fill(0);
        self.grant.clear();
        self.phase = Phase::WritingOpcode;
        let write = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_CONTROL.into(),
            characteristic_uuid: CHAR_DEVICE_COMMAND.into(),
            payload: vec![DEVICE_CMD_BLE_FACTORY_RESET],
            with_response: true,
        }));
        self.write_request_id = Some(write.request_id);
        vec![write]
    }

    fn persist_result(
        &mut self,
        result: DurableFactoryResetResult,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::PersistingResult;
        self.durable_result = Some(result.clone());
        let save = context.request(Effect::Persistence(
            PersistenceEffect::SaveFactoryResetResult { result },
        ));
        self.save_request_id = Some(save.request_id);
        let mut effects = self.unsubscribe(context);
        effects.push(save);
        effects.push(self.checkpoint(CheckpointPhase::AwaitingReceipt, context));
        effects
    }

    fn write_receipt(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::WritingReceipt;
        let write = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_CONTROL.into(),
            characteristic_uuid: CHAR_DEVICE_COMMAND.into(),
            payload: vec![DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK],
            with_response: true,
        }));
        self.write_request_id = Some(write.request_id);
        vec![write]
    }

    fn delete_result(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::DeletingResult;
        let delete = context.request(Effect::Persistence(
            PersistenceEffect::DeleteFactoryResetResult {
                command_id: self.command_id(),
            },
        ));
        self.delete_request_id = Some(delete.request_id);
        vec![delete]
    }

    fn complete(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        self.clear_volatile();
        let mut effects = self.cleanup_effects(context);
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::FactoryReset,
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
        self.clear_volatile();
        let mut effects = self.cleanup_effects(context);
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn unsubscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if self.subscription_request_id.take().is_none() {
            return Vec::new();
        }
        vec![context.request(Effect::Ble(BleEffect::Unsubscribe {
            service_uuid: SERVICE_BOTA_PROVISIONING.into(),
            characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
        }))]
    }

    fn cleanup_effects(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.timer_request_id = None;
        let mut effects = vec![context.request(Effect::Timer(TimerEffect::Cancel {
            timer_id: FACTORY_RESET_TIMER_ID,
        }))];
        effects.extend(self.unsubscribe(context));
        effects
    }

    fn clear_volatile(&mut self) {
        if let Some(nonce) = &mut self.nonce {
            nonce.0.fill(0);
        }
        self.grant.fill(0);
        self.nonce = None;
        self.grant.clear();
    }

    fn protocol_failure(code: u8) -> DeviceSdkError {
        DeviceSdkError::new(ErrorCode::ProtocolRejected, Operation::FactoryReset, false)
            .with_protocol_status(u16::from(code))
            .with_detail("device rejected authenticated factory reset")
    }

    fn persistence_failure(platform_code: Option<i64>) -> DeviceSdkError {
        DeviceSdkError::new(ErrorCode::PersistenceFailed, Operation::FactoryReset, true)
            .with_detail(format!(
                "factory-reset journal operation failed with code {platform_code:?}"
            ))
    }
}

impl WorkflowReducer for FactoryResetWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::FactoryReset,
        }));
        let timer = context.request(Effect::Timer(TimerEffect::Schedule {
            timer_id: FACTORY_RESET_TIMER_ID,
            delay_ms: FACTORY_RESET_TIMEOUT_MS,
        }));
        self.timer_request_id = Some(timer.request_id);
        let mut effects = vec![started, timer];
        match self.mode {
            Mode::Start { .. } => {
                let read = context.request(Effect::Ble(BleEffect::Read {
                    service_uuid: SERVICE_BOTA_AUTH.into(),
                    characteristic_uuid: CHAR_AUTH_NONCE.into(),
                }));
                self.nonce_request_id = Some(read.request_id);
                effects.push(read);
                effects.push(self.checkpoint(CheckpointPhase::Verifying, context));
            }
            Mode::Resume { .. } => {
                effects.extend(self.subscribe(context));
                effects.push(self.checkpoint(CheckpointPhase::AwaitingReceipt, context));
            }
        }
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
            (Phase::ReadingNonce, HostEventKind::Ble(BleEvent::ReadCompleted { value }))
                if Some(request_id) == self.nonce_request_id =>
            {
                self.nonce_request_id = None;
                if value.len() != 16 {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::FactoryReset,
                            false,
                        )
                        .with_detail("factory-reset nonce must be exactly 16 bytes"),
                        context,
                    ));
                }
                let mut nonce = [0_u8; 16];
                nonce.copy_from_slice(&value);
                self.nonce = Some(ProvisioningNonce(nonce));
                self.phase = Phase::PreparingGrant;
                let Mode::Start { grant_id, .. } = &self.mode else {
                    unreachable!("resume does not read a nonce")
                };
                let request = context.request(Effect::HostMaterial(
                    HostMaterialEffect::PrepareFactoryResetGrant {
                        grant_id: grant_id.clone(),
                        device: self.device.clone(),
                        nonce: self.nonce.clone().expect("nonce was set above"),
                    },
                ));
                self.material_request_id = Some(request.request_id);
                Ok(vec![request])
            }
            (Phase::PreparingGrant, HostEventKind::FactoryResetGrantPrepared { mut grant })
                if Some(request_id) == self.material_request_id =>
            {
                self.material_request_id = None;
                let bounded = match encode_bounded_payload(&grant, FACTORY_RESET_GRANT_LENGTH) {
                    Ok(grant) if grant.len() == FACTORY_RESET_GRANT_LENGTH => grant,
                    Ok(_) => {
                        grant.fill(0);
                        return Ok(self.fail(
                            DeviceSdkError::new(
                                ErrorCode::InvalidInput,
                                Operation::FactoryReset,
                                false,
                            )
                            .with_detail("factory-reset grant must be exactly 171 bytes"),
                            context,
                        ));
                    }
                    Err(error) => {
                        grant.fill(0);
                        return Ok(self.fail(error, context));
                    }
                };
                grant.fill(0);
                self.grant = bounded;
                if let Some(nonce) = &mut self.nonce {
                    nonce.0.fill(0);
                }
                self.nonce = None;
                Ok(self.subscribe(context))
            }
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_PROVISIONING_RESULT =>
            {
                match self.mode {
                    Mode::Start { .. } => Ok(self.write_grant(context)),
                    Mode::Resume { .. } => {
                        self.phase = Phase::AwaitingResult;
                        Ok(Vec::new())
                    }
                }
            }
            (Phase::WritingGrant, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.write_opcode(context))
            }
            (Phase::WritingOpcode, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                self.phase = Phase::AwaitingResult;
                Ok(Vec::new())
            }
            (
                phase @ (Phase::AwaitingResult | Phase::WritingOpcode),
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid,
                    value,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_PROVISIONING_RESULT =>
            {
                if value.first().copied() != Some(PROVISIONING_SUCCESS) {
                    let code = value.first().copied().unwrap_or(u8::MAX);
                    return Ok(self.fail(Self::protocol_failure(code), context));
                }
                if value.len() != 3 {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::FactoryReset,
                            false,
                        )
                        .with_detail(format!(
                            "factory-reset success must be exactly 3 bytes, received {}",
                            value.len()
                        )),
                        context,
                    ));
                }
                if phase == Phase::WritingOpcode {
                    self.write_request_id = None;
                }
                let result = parse_factory_reset_result(&value)?;
                match &self.mode {
                    Mode::Start { command_id, .. } => Ok(self.persist_result(
                        DurableFactoryResetResult {
                            command_id: command_id.clone(),
                            result,
                        },
                        context,
                    )),
                    Mode::Resume { result: persisted } if persisted.result == result => {
                        let mut effects = self.unsubscribe(context);
                        effects.extend(self.write_receipt(context));
                        Ok(effects)
                    }
                    Mode::Resume { .. } => Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::FactoryReset,
                            false,
                        )
                        .with_detail("replayed factory-reset result does not match the journal"),
                        context,
                    )),
                }
            }
            (Phase::PersistingResult, HostEventKind::FactoryResetResultSaved)
                if Some(request_id) == self.save_request_id =>
            {
                self.save_request_id = None;
                Ok(self.write_receipt(context))
            }
            (Phase::PersistingResult, HostEventKind::PersistenceFailed { platform_code })
                if Some(request_id) == self.save_request_id =>
            {
                self.save_request_id = None;
                Ok(self.fail(Self::persistence_failure(platform_code), context))
            }
            (Phase::WritingReceipt, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.delete_result(context))
            }
            (Phase::WritingReceipt, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, Operation::FactoryReset, true)
                        .with_detail(format!(
                            "factory-reset receipt write failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            (Phase::DeletingResult, HostEventKind::FactoryResetResultDeleted)
                if Some(request_id) == self.delete_request_id =>
            {
                self.delete_request_id = None;
                Ok(self.complete(context))
            }
            (Phase::DeletingResult, HostEventKind::PersistenceFailed { platform_code })
                if Some(request_id) == self.delete_request_id =>
            {
                self.delete_request_id = None;
                Ok(self.fail(Self::persistence_failure(platform_code), context))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. }))
                if self.subscription_request_id.is_some() =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::NotConnected, Operation::FactoryReset, true)
                        .with_detail("device disconnected before reset receipt completed"),
                    context,
                ))
            }
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [
                    self.nonce_request_id,
                    self.subscription_request_id,
                    self.write_request_id,
                ]
                .contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, Operation::FactoryReset, true)
                        .with_detail(format!(
                            "BLE factory-reset operation failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            (Phase::PreparingGrant, HostEventKind::HostMaterialFailed { platform_code })
                if Some(request_id) == self.material_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::Internal, Operation::FactoryReset, true)
                        .with_detail(format!(
                            "factory-reset grant preparation failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            (
                _,
                HostEventKind::TimerFired {
                    timer_id: FACTORY_RESET_TIMER_ID,
                },
            ) if Some(request_id) == self.timer_request_id => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::Timeout, Operation::FactoryReset, true)
                    .with_detail("factory reset timed out"),
                context,
            )),
            _ => {
                Err(
                    DeviceSdkError::new(ErrorCode::UnexpectedEvent, Operation::FactoryReset, false)
                        .with_detail("event does not belong to the active factory-reset phase"),
                )
            }
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.clear_volatile();
        let mut effects = self.cleanup_effects(context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::FactoryReset,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::FactoryReset,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed factory reset records its terminal error"),
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

    #[test]
    fn volatile_reset_material_is_overwritten_before_release() {
        let mut workflow = FactoryResetWorkflow::start_new(
            DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
            FactoryResetCommandId::new("cmd-1").unwrap(),
            HostMaterialId::new("grant-1").unwrap(),
            CancellationId::from_bytes([1; 16]),
        );
        workflow.nonce = Some(ProvisioningNonce([1; 16]));
        workflow.grant = vec![2; FACTORY_RESET_GRANT_LENGTH];

        workflow.clear_volatile();

        assert!(workflow.nonce.is_none());
        assert!(workflow.grant.is_empty());
    }
}
