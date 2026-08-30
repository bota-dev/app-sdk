use std::collections::BTreeSet;

use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, CheckpointPhase, Effect, EffectRequest, HostEvent,
        HostEventKind, HostMaterialEffect, PersistenceEffect, RequestId, TimerEffect,
        WorkflowCheckpoint, WorkflowKind, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{
        CHAR_API_ENDPOINT, CHAR_AUTH_NONCE, CHAR_DEVICE_TOKEN, CHAR_PK_D, CHAR_PROVISIONING_RESULT,
        PROVISIONING_SUCCESS, SERVICE_BOTA_AUTH, SERVICE_BOTA_PROVISIONING,
    },
    model::{
        DevicePublicKey, DeviceSerialNumber, HostMaterialId, ProvisioningMaterial,
        ProvisioningNonce,
    },
    protocol::{encode_bounded_payload, encode_provisioning_chunks},
    workflow::{WorkflowContext, WorkflowReducer},
};

const PROVISIONING_TIMEOUT_MS: u64 = 30_000;
const PROVISIONING_TIMER_ID: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    ReadingNonce,
    ReadingPublicKey,
    PreparingMaterial,
    Subscribing,
    WritingEndpoint,
    WritingToken,
    AwaitingResult,
    Completed,
    Failed,
}

pub(crate) struct ProvisioningWorkflow {
    device: DeviceSerialNumber,
    material_id: HostMaterialId,
    cancellation_id: CancellationId,
    phase: Phase,
    nonce: Option<ProvisioningNonce>,
    device_public_key: Option<DevicePublicKey>,
    api_endpoint: Vec<u8>,
    token_chunks: Vec<Vec<u8>>,
    chunk_index: usize,
    nonce_request_id: Option<RequestId>,
    public_key_request_id: Option<RequestId>,
    material_request_id: Option<RequestId>,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    timer_request_id: Option<RequestId>,
    checkpoint_request_ids: BTreeSet<RequestId>,
    terminal_error: Option<DeviceSdkError>,
}

impl ProvisioningWorkflow {
    pub(crate) fn new(
        device: DeviceSerialNumber,
        material_id: HostMaterialId,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            device,
            material_id,
            cancellation_id,
            phase: Phase::ReadingNonce,
            nonce: None,
            device_public_key: None,
            api_endpoint: Vec::new(),
            token_chunks: Vec::new(),
            chunk_index: 0,
            nonce_request_id: None,
            public_key_request_id: None,
            material_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            timer_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            terminal_error: None,
        }
    }

    fn checkpoint(&mut self, context: &mut WorkflowContext<'_>) -> EffectRequest {
        let request = context.request(Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: WorkflowCheckpoint {
                workflow: WorkflowKind::Provisioning,
                operation: Operation::Provision,
                device: self.device.clone(),
                recording: None,
                phase: CheckpointPhase::Verifying,
                completed_units: self.chunk_index as u64,
                retry_count: 0,
                last_sequence: None,
            },
        }));
        self.checkpoint_request_ids.insert(request.request_id);
        request
    }

    fn write_endpoint(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::WritingEndpoint;
        let write = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_PROVISIONING.into(),
            characteristic_uuid: CHAR_API_ENDPOINT.into(),
            payload: self.api_endpoint.clone(),
            with_response: true,
        }));
        self.write_request_id = Some(write.request_id);
        vec![write]
    }

    fn write_next_chunk(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let Some(payload) = self.token_chunks.get(self.chunk_index).cloned() else {
            self.phase = Phase::AwaitingResult;
            self.write_request_id = None;
            return Vec::new();
        };
        self.phase = Phase::WritingToken;
        let write = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_PROVISIONING.into(),
            characteristic_uuid: CHAR_DEVICE_TOKEN.into(),
            payload,
            with_response: true,
        }));
        self.write_request_id = Some(write.request_id);
        vec![write, self.checkpoint(context)]
    }

    fn complete(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        self.clear_volatile();
        let mut effects = self.cleanup_effects(context);
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::Provision,
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

    fn cleanup_effects(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.timer_request_id = None;
        let mut effects = vec![context.request(Effect::Timer(TimerEffect::Cancel {
            timer_id: PROVISIONING_TIMER_ID,
        }))];
        if self.subscription_request_id.take().is_some() {
            effects.push(context.request(Effect::Ble(BleEffect::Unsubscribe {
                service_uuid: SERVICE_BOTA_PROVISIONING.into(),
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            })));
        }
        effects
    }

    fn clear_volatile(&mut self) {
        if let Some(nonce) = &mut self.nonce {
            nonce.0.fill(0);
        }
        if let Some(public_key) = &mut self.device_public_key {
            public_key.0.fill(0);
        }
        self.api_endpoint.fill(0);
        for chunk in &mut self.token_chunks {
            chunk.fill(0);
        }
        self.nonce = None;
        self.device_public_key = None;
        self.api_endpoint.clear();
        self.token_chunks.clear();
    }

    fn protocol_rejection(code: u8) -> DeviceSdkError {
        DeviceSdkError::new(ErrorCode::ProtocolRejected, Operation::Provision, false)
            .with_protocol_status(u16::from(code))
            .with_detail("device rejected provisioning material")
    }
}

impl WorkflowReducer for ProvisioningWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::Provision,
        }));
        let nonce = context.request(Effect::Ble(BleEffect::Read {
            service_uuid: SERVICE_BOTA_AUTH.into(),
            characteristic_uuid: CHAR_AUTH_NONCE.into(),
        }));
        let timer = context.request(Effect::Timer(TimerEffect::Schedule {
            timer_id: PROVISIONING_TIMER_ID,
            delay_ms: PROVISIONING_TIMEOUT_MS,
        }));
        self.nonce_request_id = Some(nonce.request_id);
        self.timer_request_id = Some(timer.request_id);
        vec![started, nonce, timer, self.checkpoint(context)]
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
                            Operation::Provision,
                            false,
                        )
                        .with_detail("provisioning nonce must be exactly 16 bytes"),
                        context,
                    ));
                }
                let mut nonce = [0_u8; 16];
                nonce.copy_from_slice(&value);
                self.nonce = Some(ProvisioningNonce(nonce));
                self.phase = Phase::ReadingPublicKey;
                let read = context.request(Effect::Ble(BleEffect::Read {
                    service_uuid: SERVICE_BOTA_AUTH.into(),
                    characteristic_uuid: CHAR_PK_D.into(),
                }));
                self.public_key_request_id = Some(read.request_id);
                Ok(vec![read])
            }
            (Phase::ReadingPublicKey, HostEventKind::Ble(BleEvent::ReadCompleted { value }))
                if Some(request_id) == self.public_key_request_id =>
            {
                self.public_key_request_id = None;
                if value.len() != 64 {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::Provision,
                            false,
                        )
                        .with_detail("device public key must be exactly 64 bytes"),
                        context,
                    ));
                }
                self.device_public_key = Some(DevicePublicKey(value));
                self.phase = Phase::PreparingMaterial;
                let request = context.request(Effect::HostMaterial(
                    HostMaterialEffect::PrepareProvisioning {
                        material_id: self.material_id.clone(),
                        device: self.device.clone(),
                        nonce: self.nonce.clone().expect("nonce was read above"),
                        device_public_key: self
                            .device_public_key
                            .clone()
                            .expect("public key was read above"),
                    },
                ));
                self.material_request_id = Some(request.request_id);
                Ok(vec![request])
            }
            (
                Phase::PreparingMaterial,
                HostEventKind::ProvisioningMaterialPrepared { material },
            ) if Some(request_id) == self.material_request_id => {
                self.material_request_id = None;
                let ProvisioningMaterial {
                    api_endpoint,
                    device_token,
                    mtu,
                } = material;
                let endpoint = match encode_bounded_payload(&api_endpoint, 1) {
                    Ok(endpoint) if endpoint.len() == 1 => endpoint,
                    Ok(_) => {
                        return Ok(self.fail(
                            DeviceSdkError::new(
                                ErrorCode::InvalidInput,
                                Operation::Provision,
                                false,
                            )
                            .with_detail("API endpoint must contain exactly one byte"),
                            context,
                        ));
                    }
                    Err(error) => return Ok(self.fail(error, context)),
                };
                let chunks = match encode_provisioning_chunks(&device_token, mtu) {
                    Ok(chunks) if !chunks.is_empty() => chunks,
                    Ok(_) => {
                        return Ok(self.fail(
                            DeviceSdkError::new(
                                ErrorCode::InvalidInput,
                                Operation::Provision,
                                false,
                            )
                            .with_detail("device token cannot be empty"),
                            context,
                        ));
                    }
                    Err(error) => return Ok(self.fail(error, context)),
                };
                self.api_endpoint = endpoint;
                self.token_chunks = chunks;
                self.chunk_index = 0;
                if let Some(nonce) = &mut self.nonce {
                    nonce.0.fill(0);
                }
                if let Some(public_key) = &mut self.device_public_key {
                    public_key.0.fill(0);
                }
                self.nonce = None;
                self.device_public_key = None;

                self.phase = Phase::Subscribing;
                let subscribe = context.request(Effect::Ble(BleEffect::Subscribe {
                    service_uuid: SERVICE_BOTA_PROVISIONING.into(),
                    characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                }));
                self.subscription_request_id = Some(subscribe.request_id);
                Ok(vec![subscribe])
            }
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_PROVISIONING_RESULT =>
            {
                Ok(self.write_endpoint(context))
            }
            (Phase::WritingEndpoint, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                Ok(self.write_next_chunk(context))
            }
            (Phase::WritingToken, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                self.chunk_index = self.chunk_index.saturating_add(1);
                Ok(self.write_next_chunk(context))
            }
            (
                phase @ (Phase::AwaitingResult | Phase::WritingToken),
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid,
                    value,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_PROVISIONING_RESULT
                && (phase == Phase::AwaitingResult
                    || self.chunk_index.saturating_add(1) == self.token_chunks.len()) =>
            {
                let Some(code) = value.first().copied() else {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::Provision,
                            false,
                        )
                        .with_detail("empty provisioning result"),
                        context,
                    ));
                };
                if code == PROVISIONING_SUCCESS {
                    Ok(self.complete(context))
                } else {
                    Ok(self.fail(Self::protocol_rejection(code), context))
                }
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. }))
                if Some(request_id) == self.subscription_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::NotConnected, Operation::Provision, true)
                        .with_detail("device disconnected during provisioning"),
                    context,
                ))
            }
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [
                    self.nonce_request_id,
                    self.public_key_request_id,
                    self.subscription_request_id,
                    self.write_request_id,
                ]
                .contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::ConnectionFailed, Operation::Provision, true)
                        .with_detail(format!(
                            "BLE provisioning operation failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            (Phase::PreparingMaterial, HostEventKind::HostMaterialFailed { platform_code })
                if Some(request_id) == self.material_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::Internal, Operation::Provision, true)
                        .with_detail(format!(
                            "host material preparation failed with code {platform_code:?}"
                        )),
                    context,
                ))
            }
            (
                _,
                HostEventKind::TimerFired {
                    timer_id: PROVISIONING_TIMER_ID,
                },
            ) if Some(request_id) == self.timer_request_id => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::Timeout, Operation::Provision, true)
                    .with_detail("provisioning timed out"),
                context,
            )),
            _ => Err(
                DeviceSdkError::new(ErrorCode::UnexpectedEvent, Operation::Provision, false)
                    .with_detail("event does not belong to the active provisioning phase"),
            ),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.clear_volatile();
        let mut effects = self.cleanup_effects(context);
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::Provision,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::Provision,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed provisioning records its terminal error"),
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
    fn volatile_material_is_overwritten_before_release() {
        let mut workflow = ProvisioningWorkflow::new(
            DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
            HostMaterialId::new("material-1").unwrap(),
            CancellationId::from_bytes([1; 16]),
        );
        workflow.nonce = Some(ProvisioningNonce([1; 16]));
        workflow.device_public_key = Some(DevicePublicKey(vec![2; 64]));
        workflow.api_endpoint = vec![3];
        workflow.token_chunks = vec![vec![4; 8]];

        workflow.clear_volatile();

        assert!(workflow.nonce.is_none());
        assert!(workflow.device_public_key.is_none());
        assert!(workflow.api_endpoint.is_empty());
        assert!(workflow.token_chunks.is_empty());
    }
}
