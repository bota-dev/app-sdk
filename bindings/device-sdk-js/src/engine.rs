use crate::{ABI_VERSION, MAX_CALLBACKS, MAX_MESSAGE_BYTES, codecs, json};
use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, CapabilitySet, Command, Effect, EffectRequest,
        EncryptedUploadV2HostEffect, EncryptedUploadV2HostEvent, Event, FirmwareBlobEffect,
        HostEvent, HostEventKind, HostMaterialEffect, NetworkEffect, NetworkEvent,
        PersistenceEffect, RecordingSinkEffect, RequestId, SecureStorageEffect, TimerEffect,
        WorkflowEngine, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        DeviceSerialNumber, FactoryResetCommandId, HostMaterialId, RecordingSinkId,
        UploadDestinationId, UploadSessionId,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    version: u32,
    action: String,
    generation: Option<u64>,
    cancellation_id: Option<[u8; 16]>,
    operation: Option<Operation>,
    command: Option<Command>,
    capabilities: Option<CapabilitySet>,
    event: Option<HostEvent>,
    codec: Option<String>,
    input: Option<serde_json::Value>,
}

#[derive(Clone, Copy)]
struct Owner {
    generation: u64,
    cancellation_id: CancellationId,
    operation: Operation,
}

struct Pending {
    recurring: bool,
    effect: Effect,
}

#[derive(Default)]
pub(crate) struct Engine {
    core: WorkflowEngine,
    owner: Option<Owner>,
    last_generation: u64,
    pending: BTreeMap<RequestId, Pending>,
    codecs: codecs::CodecState,
}

#[derive(Serialize)]
struct WorkflowResult {
    generation: u64,
    effects: Vec<EffectRequest>,
    status: WorkflowStatus,
}

#[derive(Serialize)]
struct Success<T> {
    ok: bool,
    result: T,
}

#[derive(Serialize)]
struct Failure<'a> {
    ok: bool,
    error: ErrorView<'a>,
}

#[derive(Serialize)]
struct ErrorView<'a> {
    code: &'static str,
    operation: &'static str,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

pub(crate) fn invalid(detail: &str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false).with_detail(detail)
}

pub(crate) fn error_bytes(error: &DeviceSdkError) -> Vec<u8> {
    // Bounded static bridge errors and core errors contain no caller payloads.
    json::encode_bounded(&Failure {
        ok: false,
        error: ErrorView { code: error.code.as_str(), operation: error.operation.as_str(),
            retryable: error.retryable, protocol_status: error.protocol_status,
            detail: error.detail.as_deref() },
    }, MAX_MESSAGE_BYTES).unwrap_or_else(|_| b"{\"ok\":false,\"error\":{\"code\":\"internal\",\"operation\":\"unknown\",\"retryable\":false}}".to_vec())
}

impl Engine {
    // Keep the RPC dispatcher separate so generated JS stays within Hermes's
    // normal parser depth even as the supported codec set grows.
    #[inline(never)]
    pub(crate) fn request(&mut self, bytes: &[u8]) -> Vec<u8> {
        match self.try_request(bytes) {
            Ok(result) => result,
            Err(error) => error_bytes(&error),
        }
    }

    fn try_request(&mut self, bytes: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(invalid("RPC input exceeds the message bound"));
        }
        let request: Request = json::decode(bytes)
            .map_err(|_| invalid("RPC does not match the typed JSON contract"))?;
        if request.version != ABI_VERSION {
            return Err(invalid("unsupported RPC version"));
        }
        if request.action == "codec" {
            if request.command.is_some()
                || request.capabilities.is_some()
                || request.event.is_some()
                || request.generation.is_some()
                || request.cancellation_id.is_some()
                || request.operation.is_some()
            {
                return Err(invalid("codec RPC contains workflow fields"));
            }
            let codec = request
                .codec
                .ok_or_else(|| invalid("codec name is required"))?;
            let input = request.input.unwrap_or(serde_json::Value::Null);
            let output = self.codecs.execute(&codec, input)?;
            // CodecState already uses JS-safe serialization for its typed output.
            let mut result = b"{\"ok\":true,\"result\":".to_vec();
            if output.len() > MAX_MESSAGE_BYTES - result.len() - 1 {
                return Err(invalid("codec output exceeds the message bound"));
            }
            result.extend_from_slice(&output);
            result.push(b'}');
            return Ok(result);
        }
        if request.codec.is_some() || request.input.is_some() {
            return Err(invalid("workflow RPC contains codec fields"));
        }
        // Bulk bodies belong to host files; one workflow callback is bounded
        // separately so its framing/effect envelope always fits the result budget.
        if bytes.len() > 64 * 1024 {
            return Err(invalid("workflow RPC exceeds the callback byte bound"));
        }
        let effects = match request.action.as_str() {
            "start" => {
                if request.event.is_some() {
                    return Err(invalid("start RPC contains callback fields"));
                }
                let generation = request
                    .generation
                    .ok_or_else(|| invalid("generation is required"))?;
                if generation == 0 || generation <= self.last_generation {
                    return Err(invalid("start must advance the workflow generation"));
                }
                let cancellation_id = CancellationId::from_bytes(
                    request
                        .cancellation_id
                        .ok_or_else(|| invalid("cancellation_id is required"))?,
                );
                let command = request
                    .command
                    .ok_or_else(|| invalid("command is required"))?;
                validate_command(&command)?;
                let capabilities = request
                    .capabilities
                    .ok_or_else(|| invalid("capabilities are required"))?;
                let operation = command.operation();
                if request
                    .operation
                    .is_some_and(|supplied| supplied != operation)
                {
                    return Err(invalid("start operation does not match the command"));
                }
                let effects = self.core.start(command, &capabilities, cancellation_id)?;
                self.owner = Some(Owner {
                    generation,
                    cancellation_id,
                    operation,
                });
                self.last_generation = generation;
                self.pending.clear();
                effects
            }
            "dispatch" => {
                if request.command.is_some() || request.capabilities.is_some() {
                    return Err(invalid("callback RPC contains start fields"));
                }
                self.require_owner(&request)?;
                let event = request.event.ok_or_else(|| invalid("event is required"))?;
                let pending = self
                    .pending
                    .get(&event.request_id)
                    .ok_or_else(|| unexpected("callback request does not own a pending effect"))?;
                if !callback_matches(&pending.effect, &event.kind) {
                    return Err(unexpected(
                        "callback kind does not match its exact host effect",
                    ));
                }
                let recurring = pending.recurring;
                validate_event(&event)?;
                let request_id = event.request_id;
                let terminal_callback = callback_finishes_request(&event.kind);
                let effects = self.core.dispatch(Event::Host(event))?;
                if !recurring || terminal_callback {
                    self.pending.remove(&request_id);
                }
                effects
            }
            "cancel" => {
                if request.command.is_some()
                    || request.capabilities.is_some()
                    || request.event.is_some()
                {
                    return Err(invalid("cancel RPC contains command or event fields"));
                }
                self.require_owner(&request)?;
                let cancellation_id = self
                    .owner
                    .expect("require_owner validated ownership")
                    .cancellation_id;
                self.core.dispatch(Event::Cancelled { cancellation_id })?
            }
            "status" => {
                if request.command.is_some()
                    || request.capabilities.is_some()
                    || request.event.is_some()
                    || request.operation.is_some()
                    || request.generation.is_some()
                    || request.cancellation_id.is_some()
                {
                    return Err(invalid("status RPC contains workflow fields"));
                }
                Vec::new()
            }
            _ => return Err(invalid("unknown RPC action")),
        };
        self.track_effects(&effects)?;
        let result = WorkflowResult {
            generation: self.last_generation,
            effects,
            status: self.core.status().clone(),
        };
        if !matches!(self.core.status(), WorkflowStatus::Running { .. }) {
            self.pending.clear();
        }
        json::encode_bounded(&Success { ok: true, result }, MAX_MESSAGE_BYTES)
            .map_err(|_| invalid("RPC output exceeds the message bound"))
    }

    fn require_owner(&self, request: &Request) -> Result<(), DeviceSdkError> {
        let owner = self
            .owner
            .ok_or_else(|| unexpected("no workflow owns the engine"))?;
        if request.generation != Some(owner.generation)
            || request.operation != Some(owner.operation)
            || request.cancellation_id.as_ref() != Some(owner.cancellation_id.as_bytes())
        {
            return Err(unexpected(
                "callback generation, operation or cancellation ID does not own the workflow",
            ));
        }
        Ok(())
    }

    fn track_effects(&mut self, effects: &[EffectRequest]) -> Result<(), DeviceSdkError> {
        for envelope in effects {
            match &envelope.effect {
                Effect::Timer(TimerEffect::Cancel { timer_id }) => self.pending.retain(|_, pending| !matches!(&pending.effect, Effect::Timer(TimerEffect::Schedule { timer_id: pending_id, .. }) if pending_id == timer_id)),
                Effect::Ble(BleEffect::Unsubscribe { characteristic_uuid, .. }) => self.pending.retain(|_, pending| !matches!(&pending.effect, Effect::Ble(BleEffect::Subscribe { characteristic_uuid: pending_uuid, .. }) if pending_uuid == characteristic_uuid)),
                _ => {}
            }
            let Some(recurring) = callback_ownership(&envelope.effect) else {
                continue;
            };
            if self.pending.len() >= MAX_CALLBACKS {
                return Err(invalid("too many pending host effects"));
            }
            self.pending.insert(
                envelope.request_id,
                Pending {
                    recurring,
                    effect: envelope.effect.clone(),
                },
            );
        }
        Ok(())
    }
}

fn callback_matches(effect: &Effect, event: &HostEventKind) -> bool {
    match (effect, event) {
        (
            Effect::Timer(TimerEffect::Schedule { timer_id, .. }),
            HostEventKind::TimerFired { timer_id: returned },
        ) => timer_id == returned,
        (Effect::Ble(_), HostEventKind::Ble(BleEvent::Failed { .. })) => true,
        (
            Effect::Ble(BleEffect::StartScan { .. }),
            HostEventKind::Ble(BleEvent::ScanResult { .. } | BleEvent::ScanStopped),
        ) => true,
        (Effect::Ble(BleEffect::StopScan), HostEventKind::Ble(BleEvent::ScanStopped)) => true,
        (
            Effect::Ble(BleEffect::Connect { peripheral_id }),
            HostEventKind::Ble(
                BleEvent::Connected {
                    peripheral_id: returned,
                }
                | BleEvent::Disconnected {
                    peripheral_id: returned,
                    ..
                },
            ),
        ) => peripheral_id == returned,
        (
            Effect::Ble(BleEffect::DiscoverServices { peripheral_id }),
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: returned,
            }),
        ) => peripheral_id == returned,
        (
            Effect::Ble(BleEffect::Disconnect { peripheral_id }),
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: returned,
                ..
            }),
        ) => peripheral_id == returned,
        (
            Effect::Ble(BleEffect::Read { .. }),
            HostEventKind::Ble(BleEvent::ReadCompleted { .. }),
        ) => true,
        (Effect::Ble(BleEffect::Write { .. }), HostEventKind::Ble(BleEvent::WriteCompleted)) => {
            true
        }
        (
            Effect::Ble(BleEffect::Subscribe {
                characteristic_uuid,
                ..
            }),
            HostEventKind::Ble(
                BleEvent::Subscribed {
                    characteristic_uuid: returned,
                }
                | BleEvent::Notification {
                    characteristic_uuid: returned,
                    ..
                },
            ),
        ) => characteristic_uuid.eq_ignore_ascii_case(returned),
        (
            Effect::Ble(BleEffect::Subscribe { .. }),
            HostEventKind::Ble(BleEvent::Disconnected { .. }),
        ) => true,
        (Effect::Persistence(_), HostEventKind::PersistenceFailed { .. }) => true,
        (
            Effect::Persistence(PersistenceEffect::LoadCheckpoint),
            HostEventKind::CheckpointLoaded { .. },
        )
        | (
            Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. }),
            HostEventKind::CheckpointSaved,
        )
        | (
            Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. }),
            HostEventKind::ConnectionIdentitySaved,
        )
        | (
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. }),
            HostEventKind::FactoryResetResultSaved,
        )
        | (
            Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { .. }),
            HostEventKind::FactoryResetResultDeleted,
        ) => true,
        (
            Effect::SecureStorage(SecureStorageEffect::Read { key }),
            HostEventKind::SecretLoaded { key: returned, .. },
        )
        | (
            Effect::SecureStorage(
                SecureStorageEffect::Write { key, .. } | SecureStorageEffect::Delete { key },
            ),
            HostEventKind::SecretStored { key: returned },
        ) => key == returned,
        (Effect::HostMaterial(_), HostEventKind::HostMaterialFailed { .. }) => true,
        (
            Effect::HostMaterial(HostMaterialEffect::PrepareProvisioning { .. }),
            HostEventKind::ProvisioningMaterialPrepared { .. },
        )
        | (
            Effect::HostMaterial(HostMaterialEffect::PrepareFactoryResetGrant { .. }),
            HostEventKind::FactoryResetGrantPrepared { .. },
        ) => true,
        (
            Effect::RecordingSink(
                RecordingSinkEffect::Truncate { .. }
                | RecordingSinkEffect::Append { .. }
                | RecordingSinkEffect::Finalize { .. }
                | RecordingSinkEffect::Discard { .. },
            ),
            HostEventKind::RecordingSinkFailed { .. },
        ) => true,
        (
            Effect::RecordingSink(
                RecordingSinkEffect::AppendStreamingPlaintext { .. }
                | RecordingSinkEffect::BeginStreamingEncrypted { .. }
                | RecordingSinkEffect::AppendStreamingEncrypted { .. }
                | RecordingSinkEffect::FinalizeStreaming { .. }
                | RecordingSinkEffect::DiscardStreaming { .. },
            ),
            HostEventKind::StreamingSinkFailed { .. },
        ) => true,
        (
            Effect::RecordingSink(RecordingSinkEffect::Truncate { .. }),
            HostEventKind::RecordingSinkTruncated,
        )
        | (
            Effect::RecordingSink(RecordingSinkEffect::Append { .. }),
            HostEventKind::RecordingSinkAppendCompleted { .. },
        )
        | (
            Effect::RecordingSink(RecordingSinkEffect::Finalize { .. }),
            HostEventKind::RecordingSinkFinalized { .. }
            | HostEventKind::RecordingSinkIntegrityFailed,
        )
        | (
            Effect::RecordingSink(
                RecordingSinkEffect::AppendStreamingPlaintext { .. }
                | RecordingSinkEffect::BeginStreamingEncrypted { .. }
                | RecordingSinkEffect::AppendStreamingEncrypted { .. },
            ),
            HostEventKind::StreamingSinkAccepted { .. },
        )
        | (
            Effect::RecordingSink(RecordingSinkEffect::FinalizeStreaming { .. }),
            HostEventKind::StreamingSinkFinalized { .. },
        ) => true,
        (Effect::FirmwareBlob(_), HostEventKind::FirmwareBlobFailed { .. }) => true,
        (
            Effect::FirmwareBlob(FirmwareBlobEffect::ReadChunk {
                download_id,
                offset,
                max_length,
            }),
            HostEventKind::FirmwareChunkRead {
                download_id: returned_id,
                offset: returned_offset,
                bytes,
            },
        ) => {
            download_id == returned_id
                && offset == returned_offset
                && bytes.len() <= usize::from(*max_length)
        }
        (
            Effect::Network(NetworkEffect::Download { download_id }),
            HostEventKind::Network(
                NetworkEvent::DownloadProgress {
                    download_id: returned,
                    ..
                }
                | NetworkEvent::DownloadCompleted {
                    download_id: returned,
                    ..
                },
            ),
        ) => download_id == returned,
        (
            Effect::Network(NetworkEffect::Upload { upload_id, .. }),
            HostEventKind::Network(
                NetworkEvent::UploadProgress {
                    upload_id: returned,
                    ..
                }
                | NetworkEvent::UploadCompleted {
                    upload_id: returned,
                },
            ),
        ) => upload_id == returned,
        (
            Effect::Network(NetworkEffect::Download { download_id }),
            HostEventKind::Network(NetworkEvent::Failed { transfer_id, .. }),
        ) => download_id == transfer_id,
        (
            Effect::Network(NetworkEffect::Upload { upload_id, .. }),
            HostEventKind::Network(NetworkEvent::Failed { transfer_id, .. }),
        ) => upload_id == transfer_id,
        (
            Effect::EncryptedUploadV2(_),
            HostEventKind::EncryptedUploadV2(
                EncryptedUploadV2HostEvent::Failed { .. }
                | EncryptedUploadV2HostEvent::MixedProfile,
            ),
        ) => true,
        (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::LoadCheckpoint { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::CheckpointLoaded(_)),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::TruncateSink { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::SinkTruncated),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::PrepareSession { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::SessionPrepared {
                ..
            }),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StartTransfer { .. }),
            HostEventKind::EncryptedUploadV2(
                EncryptedUploadV2HostEvent::TransferStarted
                | EncryptedUploadV2HostEvent::ResumeRejected
                | EncryptedUploadV2HostEvent::WindowStaged { .. }
                | EncryptedUploadV2HostEvent::TransferCompleted(_),
            ),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::RepairWindow { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::WindowStaged { .. }),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::SaveCheckpoint { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::CheckpointSaved),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AcknowledgeWindow { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::WindowAcknowledged {
                ..
            }),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StageArtifacts { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::ArtifactsStaged),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AwaitCompletionReceipt {
                ..
            }),
            HostEventKind::EncryptedUploadV2(
                EncryptedUploadV2HostEvent::CompletionReceiptAccepted { .. },
            ),
        )
        | (
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. }),
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::RecordingConfirmed),
        ) => true,
        _ => false,
    }
}

fn unexpected(detail: &str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::UnexpectedEvent, Operation::Unknown, false).with_detail(detail)
}

fn callback_ownership(effect: &Effect) -> Option<bool> {
    match effect {
        Effect::Notify(_)
        | Effect::Progress(_)
        | Effect::Timer(TimerEffect::Cancel { .. })
        | Effect::Persistence(PersistenceEffect::DeleteCheckpoint)
        | Effect::Ble(BleEffect::Unsubscribe { .. })
        | Effect::EncryptedUploadV2(
            EncryptedUploadV2HostEffect::DeleteCheckpoint { .. }
            | EncryptedUploadV2HostEffect::AbortV2 { .. },
        ) => None,
        Effect::Ble(BleEffect::StartScan { .. } | BleEffect::Subscribe { .. })
        | Effect::Network(_)
        | Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StartTransfer { .. }) => {
            Some(true)
        }
        _ => Some(false),
    }
}

fn callback_finishes_request(event: &HostEventKind) -> bool {
    matches!(
        event,
        HostEventKind::Ble(
            BleEvent::ScanStopped | BleEvent::Disconnected { .. } | BleEvent::Failed { .. }
        ) | HostEventKind::Network(
            NetworkEvent::DownloadCompleted { .. }
                | NetworkEvent::UploadCompleted { .. }
                | NetworkEvent::Failed { .. }
        ) | HostEventKind::EncryptedUploadV2(
            EncryptedUploadV2HostEvent::TransferCompleted(_)
                | EncryptedUploadV2HostEvent::ResumeRejected
                | EncryptedUploadV2HostEvent::MixedProfile
                | EncryptedUploadV2HostEvent::Failed { .. }
        )
    )
}

pub(crate) fn validate_command(command: &Command) -> Result<(), DeviceSdkError> {
    match command {
        Command::DiscoverDevices { .. } => {}
        Command::Connect { device, candidate } => {
            serial(device)?;
            candidate_bounds(candidate)?;
        }
        Command::ConnectSelected { candidate } => candidate_bounds(candidate)?,
        Command::Reconnect { device, hint } => {
            serial(device)?;
            for value in [
                &hint.stored_peripheral_id,
                &hint.advertised_address,
                &hint.stored_name,
            ]
            .into_iter()
            .flatten()
            {
                if value.len() > 512 {
                    return Err(invalid("reconnect hint exceeds the text bound"));
                }
            }
        }
        Command::Provision {
            device,
            material_id,
        } => {
            serial(device)?;
            HostMaterialId::new(material_id.as_str())?;
        }
        Command::TransferRecording {
            device, sink_id, ..
        }
        | Command::StreamRecording {
            device, sink_id, ..
        } => {
            serial(device)?;
            RecordingSinkId::new(sink_id.as_str())?;
        }
        Command::TransferEncryptedRecording { request } => {
            serial(&request.device)?;
            HostMaterialId::new(request.material_id.as_str())?;
            RecordingSinkId::new(request.sink_id.as_str())?;
        }
        Command::UploadRecording {
            device,
            upload_id,
            destination_id,
            ..
        } => {
            serial(device)?;
            UploadSessionId::new(upload_id.as_str())?;
            UploadDestinationId::new(destination_id.as_str())?;
        }
        Command::UpdateFirmware {
            device,
            image,
            reconnect_hint,
            ..
        } => {
            serial(device)?;
            if image.version.len() > 128 {
                return Err(invalid("firmware version exceeds the text bound"));
            }
            for value in [
                &reconnect_hint.stored_peripheral_id,
                &reconnect_hint.advertised_address,
                &reconnect_hint.stored_name,
            ]
            .into_iter()
            .flatten()
            {
                if value.len() > 512 {
                    return Err(invalid("reconnect hint exceeds the text bound"));
                }
            }
        }
        Command::ReadDeviceLogs { device } => serial(device)?,
        Command::FactoryReset {
            device,
            command_id,
            grant_id,
        } => {
            serial(device)?;
            FactoryResetCommandId::new(command_id.as_str())?;
            HostMaterialId::new(grant_id.as_str())?;
        }
        Command::ResumeFactoryReset {
            device, command_id, ..
        } => {
            serial(device)?;
            FactoryResetCommandId::new(command_id.as_str())?;
        }
    }
    Ok(())
}

fn serial(device: &DeviceSerialNumber) -> Result<(), DeviceSdkError> {
    DeviceSerialNumber::new(device.as_str()).map(|_| ())
}
fn candidate_bounds(
    candidate: &bota_device_sdk_core::model::DeviceCandidate,
) -> Result<(), DeviceSdkError> {
    if candidate.peripheral_id.is_empty()
        || candidate.peripheral_id.len() > 512
        || candidate
            .name
            .as_ref()
            .is_some_and(|value| value.len() > 512)
        || candidate
            .advertised_address
            .as_ref()
            .is_some_and(|value| value.len() > 512)
    {
        return Err(invalid("invalid or oversized device candidate"));
    }
    Ok(())
}

fn validate_event(event: &HostEvent) -> Result<(), DeviceSdkError> {
    match &event.kind {
        HostEventKind::Ble(BleEvent::ScanResult { candidate }) => candidate_bounds(candidate)?,
        HostEventKind::CheckpointLoaded {
            checkpoint: Some(checkpoint),
        } => serial(&checkpoint.device)?,
        HostEventKind::EncryptedUploadV2(
            EncryptedUploadV2HostEvent::CheckpointLoaded(Some(checkpoint))
            | EncryptedUploadV2HostEvent::WindowStaged { checkpoint, .. }
            | EncryptedUploadV2HostEvent::WindowAcknowledged { checkpoint },
        ) => serial(&checkpoint.device)?,
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bota_device_sdk_core::model::{DeviceCandidate, ReconnectHint};

    fn start(command: Command, generation: u64) -> Vec<u8> {
        #[derive(Serialize)]
        struct Start {
            version: u32,
            action: &'static str,
            generation: u64,
            cancellation_id: [u8; 16],
            capabilities: CapabilitySet,
            command: Command,
        }
        json::encode(&Start {
            version: 1,
            action: "start",
            generation,
            cancellation_id: [7; 16],
            capabilities: command.required_capabilities(),
            command,
        })
        .unwrap()
    }
    fn response(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).unwrap()
    }
    fn reconnect() -> Command {
        Command::Reconnect {
            device: DeviceSerialNumber::new("C8SU2XXWHI").unwrap(),
            hint: ReconnectHint::default(),
        }
    }

    #[test]
    fn raw_bridge_runs_the_actual_reducer_and_preserves_effect_identity() {
        let command = reconnect();
        let mut direct = WorkflowEngine::default();
        let expected = direct
            .start(
                command.clone(),
                &command.required_capabilities(),
                CancellationId::from_bytes([7; 16]),
            )
            .unwrap();
        let result = response(&Engine::default().request(&start(command, 1)));
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["result"]["effects"],
            serde_json::from_slice::<serde_json::Value>(&json::encode(&expected).unwrap()).unwrap()
        );
        assert_eq!(result["result"]["generation"], "1");
    }

    #[test]
    fn malformed_newtypes_and_rpc_shapes_do_not_start_a_workflow() {
        let mut engine = Engine::default();
        let command = Command::Connect {
            device: DeviceSerialNumber::new("VALID").unwrap(),
            candidate: DeviceCandidate {
                peripheral_id: "selected".into(),
                name: None,
                advertised_address: None,
                rssi: 0,
            },
        };
        let mut document: serde_json::Value = serde_json::from_slice(&start(command, 1)).unwrap();
        document["command"]["Connect"]["device"] = serde_json::Value::String("not a serial".into());
        assert_eq!(
            response(&engine.request(&serde_json::to_vec(&document).unwrap()))["error"]["code"],
            "invalid_input"
        );
        assert!(matches!(engine.core.status(), WorkflowStatus::Idle));
        for bytes in [
            b"null".as_slice(),
            b"{}",
            b"{\"version\":1,\"action\":\"status\",\"extra\":true}",
            b"{\"version\":2,\"action\":\"status\"}",
        ] {
            assert_eq!(response(&engine.request(bytes))["ok"], false);
        }
    }

    #[test]
    fn stale_generation_cancellation_and_request_callbacks_cannot_reach_core() {
        let mut engine = Engine::default();
        engine.request(&start(reconnect(), 3));
        let request_id = engine
            .pending
            .iter()
            .find(|(_, pending)| {
                matches!(
                    pending.effect,
                    Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
                )
            })
            .unwrap()
            .0
            .as_u64()
            .to_string();
        let callback = serde_json::json!({ "version":1, "action":"dispatch", "generation":"3", "operation":"Reconnect", "cancellation_id":[7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7], "event":{"request_id":request_id, "kind":"CheckpointSaved"} });
        for (key, value) in [
            ("generation", serde_json::json!("2")),
            ("operation", serde_json::json!("Connect")),
            ("cancellation_id", serde_json::json!(vec![0_u8; 16])),
        ] {
            let mut stale = callback.clone();
            stale[key] = value;
            assert_eq!(
                response(&engine.request(&serde_json::to_vec(&stale).unwrap()))["error"]["code"],
                "unexpected_event"
            );
        }
        let mut stale = callback.clone();
        stale["event"]["request_id"] = serde_json::json!("18446744073709551615");
        assert_eq!(
            response(&engine.request(&serde_json::to_vec(&stale).unwrap()))["error"]["code"],
            "unexpected_event"
        );
        let mut wrong_family = callback.clone();
        wrong_family["event"]["kind"] = serde_json::json!({"Ble":{"ReadCompleted":{"value":[0]}}});
        assert_eq!(
            response(&engine.request(&serde_json::to_vec(&wrong_family).unwrap()))["error"]["code"],
            "unexpected_event"
        );
        assert_eq!(
            response(&engine.request(&serde_json::to_vec(&callback).unwrap()))["ok"],
            true
        );
        assert_eq!(
            response(&engine.request(&serde_json::to_vec(&callback).unwrap()))["error"]["code"],
            "unexpected_event"
        );
    }

    #[test]
    fn every_core_command_uses_the_same_initial_effects_through_rpc() {
        use bota_device_sdk_core::{
            generated::protocol,
            model::{
                FirmwareImage, RecordingUploadProfile, RecordingUuid, UploadProfileSelection,
                UploadSecurityPolicy,
            },
            protocol::decode_encrypted_upload_v2_capabilities,
            workflow::EncryptedUploadV2BatchRequest,
        };
        let device = DeviceSerialNumber::new("C8SU2XXWHI").unwrap();
        let recording = RecordingUuid::from_bytes([0x22; 16]);
        let candidate = DeviceCandidate {
            peripheral_id: "selected".into(),
            name: None,
            advertised_address: None,
            rssi: 0,
        };
        let sink = RecordingSinkId::new("sink").unwrap();
        let v2 = EncryptedUploadV2BatchRequest {
            device: device.clone(),
            recording,
            recording_generation: 9,
            storage_format: protocol::STORAGE_FORMAT_BOTA_ENC_V2,
            upload_session_uuid: [0x11; 16],
            owner_revision: 3,
            transport_session_id: 0x1122_3344_5566,
            material_id: HostMaterialId::new("material").unwrap(),
            sink_id: sink.clone(),
            selection: UploadProfileSelection {
                policy: UploadSecurityPolicy::V2Preferred,
                profile: RecordingUploadProfile::EncryptedUploadV2,
            },
            capabilities: decode_encrypted_upload_v2_capabilities(&[
                1, 2, 24, 0, 127, 0, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0,
            ])
            .unwrap(),
            window_packets: 16,
            data_payload_bytes: 244,
            ciphertext_length: 330,
            ciphertext_sha256: [0x33; 32],
        };
        let commands = vec![
            Command::DiscoverDevices {
                timeout_ms: 5000,
                allow_duplicates: false,
            },
            Command::Connect {
                device: device.clone(),
                candidate: candidate.clone(),
            },
            Command::ConnectSelected { candidate },
            reconnect(),
            Command::Provision {
                device: device.clone(),
                material_id: HostMaterialId::new("material").unwrap(),
            },
            Command::TransferRecording {
                device: device.clone(),
                recording,
                sink_id: sink.clone(),
                total_units: 1024,
                confirm_on_completion: false,
            },
            Command::TransferEncryptedRecording { request: v2 },
            Command::StreamRecording {
                device: device.clone(),
                recording,
                sink_id: sink,
            },
            Command::UploadRecording {
                device: device.clone(),
                recording,
                upload_id: UploadSessionId::new("upload").unwrap(),
                destination_id: UploadDestinationId::new("destination").unwrap(),
            },
            Command::UpdateFirmware {
                device: device.clone(),
                image: FirmwareImage {
                    version: "1.2.3".into(),
                    size_bytes: 1024,
                    crc32: 0x11223344,
                },
                download_id: 9,
                reconnect_hint: ReconnectHint::default(),
            },
            Command::ReadDeviceLogs {
                device: device.clone(),
            },
            Command::FactoryReset {
                device: device.clone(),
                command_id: FactoryResetCommandId::new("reset").unwrap(),
                grant_id: HostMaterialId::new("grant").unwrap(),
            },
            Command::ResumeFactoryReset {
                device,
                command_id: FactoryResetCommandId::new("reset").unwrap(),
                expected_result: None,
            },
        ];
        assert_eq!(commands.len(), 13);
        for command in commands {
            let mut direct = WorkflowEngine::default();
            let expected = direct.start(
                command.clone(),
                &command.required_capabilities(),
                CancellationId::from_bytes([7; 16]),
            );
            let result = response(&Engine::default().request(&start(command, 1)));
            match expected {
                Ok(effects) => {
                    assert_eq!(result["ok"], true);
                    assert_eq!(
                        result["result"]["effects"],
                        serde_json::from_slice::<serde_json::Value>(
                            &json::encode(&effects).unwrap()
                        )
                        .unwrap()
                    );
                }
                Err(error) => {
                    assert_eq!(result["ok"], false);
                    assert_eq!(result["error"]["code"], error.code.as_str());
                }
            }
        }
    }
}
