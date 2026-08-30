use std::collections::BTreeSet;

use crate::{
    engine::{
        BleEffect, BleEvent, CancellationId, CheckpointPhase, Effect, EffectRequest,
        FirmwareBlobEffect, HostEvent, HostEventKind, NetworkEffect, NetworkEvent,
        PersistenceEffect, RequestId, TimerEffect, WorkflowCheckpoint, WorkflowKind,
        WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::{
        CHAR_FIRMWARE_REVISION, CHAR_RECORDING_TRANSFER, CHAR_TRANSFER_CONTROL,
        CHAR_TRANSFER_STATUS, FIRMWARE_ACK, FIRMWARE_CHUNK_SIZE, FIRMWARE_UPLOAD_START,
        FIRMWARE_UPLOAD_VERIFY, SERVICE_BOTA_STORAGE, SERVICE_DEVICE_INFO,
    },
    model::{
        DeviceSerialNumber, FirmwareImage, FirmwareUpdatePhase, FirmwareUpdateProgress,
        ReconnectHint,
    },
    protocol::{
        encode_firmware_data, encode_firmware_upload_start, encode_firmware_upload_verify,
        parse_ota_status,
    },
    workflow::{ConnectionWorkflow, WorkflowContext, WorkflowReducer},
};

const ACK_WINDOW: u16 = 8;
const ACK_TIMEOUT_ID: u64 = 101;
const ACK_TIMEOUT_MS: u64 = 5_000;
const REBOOT_TIMEOUT_ID: u64 = 102;
const REBOOT_TIMEOUT_MS: u64 = 30_000;
const RECONNECT_TIMEOUT_ID: u64 = 103;
const RECONNECT_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    LoadingCheckpoint,
    Downloading,
    Subscribing,
    Starting,
    AwaitingReady,
    ReadingChunk,
    WritingChunk,
    WaitingAck,
    Verifying,
    AwaitingVerify,
    AwaitingReboot,
    Reconnecting,
    ReadingVersion,
    Completed,
    Failed,
}

pub(crate) struct FirmwareUpdateWorkflow {
    device: DeviceSerialNumber,
    image: FirmwareImage,
    download_id: u64,
    reconnect_hint: ReconnectHint,
    cancellation_id: CancellationId,
    phase: Phase,
    offset: u64,
    next_sequence: u16,
    pending_chunk_units: u64,
    latest_ack: Option<u16>,
    waiting_ack: Option<u16>,
    ready_result: Option<u8>,
    verify_result: Option<u8>,
    retry_count: u16,
    load_request_id: Option<RequestId>,
    download_request_id: Option<RequestId>,
    blob_request_id: Option<RequestId>,
    subscription_request_id: Option<RequestId>,
    write_request_id: Option<RequestId>,
    timer_request_id: Option<RequestId>,
    timer_id: Option<u64>,
    reconnect_timer_request_id: Option<RequestId>,
    checkpoint_request_ids: BTreeSet<RequestId>,
    connection: Option<Box<ConnectionWorkflow>>,
    terminal_error: Option<DeviceSdkError>,
}

impl FirmwareUpdateWorkflow {
    pub(crate) fn new(
        device: DeviceSerialNumber,
        image: FirmwareImage,
        download_id: u64,
        reconnect_hint: ReconnectHint,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            device,
            image,
            download_id,
            reconnect_hint,
            cancellation_id,
            phase: Phase::LoadingCheckpoint,
            offset: 0,
            next_sequence: 0,
            pending_chunk_units: 0,
            latest_ack: None,
            waiting_ack: None,
            ready_result: None,
            verify_result: None,
            retry_count: 0,
            load_request_id: None,
            download_request_id: None,
            blob_request_id: None,
            subscription_request_id: None,
            write_request_id: None,
            timer_request_id: None,
            timer_id: None,
            reconnect_timer_request_id: None,
            checkpoint_request_ids: BTreeSet::new(),
            connection: None,
            terminal_error: None,
        }
    }

    fn checkpoint_matches(&self, checkpoint: &WorkflowCheckpoint) -> bool {
        checkpoint.workflow == WorkflowKind::FirmwareUpdate
            && checkpoint.operation == Operation::UpdateFirmware
            && checkpoint.device == self.device
            && checkpoint.firmware_version.as_deref() == Some(self.image.version.as_str())
    }

    fn checkpoint(
        &mut self,
        phase: CheckpointPhase,
        context: &mut WorkflowContext<'_>,
    ) -> EffectRequest {
        let request = context.request(Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: WorkflowCheckpoint {
                workflow: WorkflowKind::FirmwareUpdate,
                operation: Operation::UpdateFirmware,
                device: self.device.clone(),
                recording: None,
                phase,
                completed_units: self.offset,
                retry_count: self.retry_count,
                last_sequence: self.next_sequence.checked_sub(1),
                firmware_version: Some(self.image.version.clone()),
            },
        }));
        self.checkpoint_request_ids.insert(request.request_id);
        request
    }

    fn progress(
        &mut self,
        phase: FirmwareUpdatePhase,
        completed_bytes: u64,
        total_bytes: u64,
        context: &mut WorkflowContext<'_>,
    ) -> EffectRequest {
        context.request(Effect::Notify(WorkflowNotification::FirmwareProgress {
            progress: FirmwareUpdateProgress {
                phase,
                completed_bytes,
                total_bytes,
            },
        }))
    }

    fn begin_download(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Downloading;
        let request = context.request(Effect::Network(NetworkEffect::Download {
            download_id: self.download_id,
        }));
        self.download_request_id = Some(request.request_id);
        vec![
            self.progress(
                FirmwareUpdatePhase::Downloading,
                0,
                u64::from(self.image.size_bytes),
                context,
            ),
            request,
        ]
    }

    fn subscribe(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Subscribing;
        let request = context.request(Effect::Ble(BleEffect::Subscribe {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
        }));
        self.subscription_request_id = Some(request.request_id);
        vec![
            self.progress(
                FirmwareUpdatePhase::AwaitingDevice,
                0,
                u64::from(self.image.size_bytes),
                context,
            ),
            request,
        ]
    }

    fn write_start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Starting;
        self.ready_result = None;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload: encode_firmware_upload_start(self.image.size_bytes)
                .expect("firmware size has a fixed-width wire representation"),
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn begin_transfer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        // Firmware recreates update.ufw on every UPLOAD_START, so retries reuse
        // the downloaded host blob but restart the device transfer from zero.
        self.offset = 0;
        self.next_sequence = 0;
        self.pending_chunk_units = 0;
        self.latest_ack = None;
        self.waiting_ack = None;
        self.read_next_or_verify(context)
    }

    fn read_next_or_verify(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if self.offset >= u64::from(self.image.size_bytes) {
            return self.write_verify(context);
        }
        self.phase = Phase::ReadingChunk;
        let remaining = u64::from(self.image.size_bytes).saturating_sub(self.offset);
        let max_length = remaining.min(FIRMWARE_CHUNK_SIZE as u64) as u16;
        let request = context.request(Effect::FirmwareBlob(FirmwareBlobEffect::ReadChunk {
            download_id: self.download_id,
            offset: self.offset,
            max_length,
        }));
        self.blob_request_id = Some(request.request_id);
        vec![request]
    }

    fn write_chunk(
        &mut self,
        bytes: Vec<u8>,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        self.phase = Phase::WritingChunk;
        self.pending_chunk_units = bytes.len() as u64;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            payload: encode_firmware_data(self.next_sequence, &bytes)?,
            with_response: false,
        }));
        self.write_request_id = Some(request.request_id);
        Ok(vec![request])
    }

    fn wait_for_ack(
        &mut self,
        sequence: u16,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.phase = Phase::WaitingAck;
        self.waiting_ack = Some(sequence);
        self.schedule_timer(ACK_TIMEOUT_ID, ACK_TIMEOUT_MS, context)
    }

    fn write_verify(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Verifying;
        self.verify_result = None;
        let request = context.request(Effect::Ble(BleEffect::Write {
            service_uuid: SERVICE_BOTA_STORAGE.into(),
            characteristic_uuid: CHAR_TRANSFER_CONTROL.into(),
            payload: encode_firmware_upload_verify(self.image.crc32)
                .expect("CRC32 has a fixed-width wire representation"),
            with_response: true,
        }));
        self.write_request_id = Some(request.request_id);
        vec![
            self.progress(
                FirmwareUpdatePhase::Verifying,
                u64::from(self.image.size_bytes),
                u64::from(self.image.size_bytes),
                context,
            ),
            request,
        ]
    }

    fn begin_reboot(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::AwaitingReboot;
        let mut effects = vec![self.progress(
            FirmwareUpdatePhase::Rebooting,
            u64::from(self.image.size_bytes),
            u64::from(self.image.size_bytes),
            context,
        )];
        effects.extend(self.schedule_timer(REBOOT_TIMEOUT_ID, REBOOT_TIMEOUT_MS, context));
        effects
    }

    fn begin_reconnect(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Reconnecting;
        self.connection = Some(Box::new(ConnectionWorkflow::reconnect(
            self.device.clone(),
            self.reconnect_hint.clone(),
            self.cancellation_id,
        )));
        let mut effects = vec![
            self.progress(
                FirmwareUpdatePhase::Reconnecting,
                u64::from(self.image.size_bytes),
                u64::from(self.image.size_bytes),
                context,
            ),
            self.checkpoint(CheckpointPhase::Reconnecting, context),
        ];
        let reconnect_timer = context.request(Effect::Timer(TimerEffect::Schedule {
            timer_id: RECONNECT_TIMEOUT_ID,
            delay_ms: RECONNECT_TIMEOUT_MS,
        }));
        self.reconnect_timer_request_id = Some(reconnect_timer.request_id);
        effects.push(reconnect_timer);
        let connection_effects = self
            .connection
            .as_mut()
            .expect("connection was assigned above")
            .start(context);
        effects.extend(Self::filter_connection_effects(connection_effects));
        effects
    }

    fn read_version(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::ReadingVersion;
        let request = context.request(Effect::Ble(BleEffect::Read {
            service_uuid: SERVICE_DEVICE_INFO.into(),
            characteristic_uuid: CHAR_FIRMWARE_REVISION.into(),
        }));
        self.write_request_id = Some(request.request_id);
        vec![request]
    }

    fn schedule_timer(
        &mut self,
        timer_id: u64,
        delay_ms: u64,
        context: &mut WorkflowContext<'_>,
    ) -> Vec<EffectRequest> {
        self.timer_id = Some(timer_id);
        let request = context.request(Effect::Timer(TimerEffect::Schedule { timer_id, delay_ms }));
        self.timer_request_id = Some(request.request_id);
        vec![request]
    }

    fn cancel_timer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.timer_request_id = None;
        let Some(timer_id) = self.timer_id.take() else {
            return Vec::new();
        };
        vec![context.request(Effect::Timer(TimerEffect::Cancel { timer_id }))]
    }

    fn cancel_reconnect_timer(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        if self.reconnect_timer_request_id.take().is_none() {
            return Vec::new();
        }
        vec![context.request(Effect::Timer(TimerEffect::Cancel {
            timer_id: RECONNECT_TIMEOUT_ID,
        }))]
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

    fn complete(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        self.phase = Phase::Completed;
        let mut effects = self.cancel_timer(context);
        effects.extend(self.cancel_reconnect_timer(context));
        effects.extend(self.unsubscribe(context));
        effects.push(context.request(Effect::Persistence(PersistenceEffect::DeleteCheckpoint)));
        effects.push(self.progress(
            FirmwareUpdatePhase::Complete,
            u64::from(self.image.size_bytes),
            u64::from(self.image.size_bytes),
            context,
        ));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::UpdateFirmware,
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
        let mut effects = self.cancel_timer(context);
        effects.extend(self.cancel_reconnect_timer(context));
        effects.extend(self.unsubscribe(context));
        effects.push(context.request(Effect::Notify(WorkflowNotification::Failed { error })));
        effects
    }

    fn filter_connection_effects(effects: Vec<EffectRequest>) -> Vec<EffectRequest> {
        effects
            .into_iter()
            .filter(|request| {
                !matches!(
                    request.effect,
                    Effect::Persistence(
                        PersistenceEffect::SaveCheckpoint { .. }
                            | PersistenceEffect::DeleteCheckpoint
                    ) | Effect::Notify(WorkflowNotification::Started {
                        operation: Operation::Reconnect,
                    }) | Effect::Notify(WorkflowNotification::Completed {
                        operation: Operation::Reconnect,
                    }) | Effect::Notify(WorkflowNotification::Failed { .. })
                )
            })
            .collect()
    }

    fn handle_status_notification(
        &mut self,
        value: &[u8],
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let status = parse_ota_status(value)?;
        match status.command {
            FIRMWARE_UPLOAD_START => {
                if status.result != 0 {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::UpdateFirmware,
                            true,
                        )
                        .with_protocol_status(u16::from(status.result))
                        .with_detail("device rejected firmware upload or failed storage write"),
                        context,
                    ));
                }
                match self.phase {
                    Phase::Starting => {
                        self.ready_result = Some(status.result);
                        Ok(Vec::new())
                    }
                    Phase::AwaitingReady => Ok(self.begin_transfer(context)),
                    _ => Ok(Vec::new()),
                }
            }
            FIRMWARE_ACK => {
                let Some(sequence) = status.sequence else {
                    return Ok(Vec::new());
                };
                self.latest_ack = Some(sequence);
                if self.phase == Phase::WaitingAck && self.waiting_ack == Some(sequence) {
                    self.waiting_ack = None;
                    let mut effects = self.cancel_timer(context);
                    effects.extend(self.read_next_or_verify(context));
                    Ok(effects)
                } else {
                    Ok(Vec::new())
                }
            }
            FIRMWARE_UPLOAD_VERIFY => {
                if status.result != 0 {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::IntegrityFailed,
                            Operation::UpdateFirmware,
                            true,
                        )
                        .with_protocol_status(u16::from(status.result))
                        .with_detail("device rejected the firmware CRC32"),
                        context,
                    ));
                }
                match self.phase {
                    Phase::Verifying => {
                        self.verify_result = Some(status.result);
                        Ok(Vec::new())
                    }
                    Phase::AwaitingVerify => Ok(self.begin_reboot(context)),
                    _ => Ok(Vec::new()),
                }
            }
            _ => Ok(Vec::new()),
        }
    }

    fn dispatch_reconnect(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        if matches!(
            event,
            HostEvent {
                request_id,
                kind: HostEventKind::TimerFired {
                    timer_id: RECONNECT_TIMEOUT_ID,
                },
            } if Some(request_id) == self.reconnect_timer_request_id
        ) {
            let mut effects = self
                .connection
                .as_mut()
                .map(|connection| connection.cancel(context))
                .map(Self::filter_connection_effects)
                .unwrap_or_default();
            effects.extend(
                self.fail(
                    DeviceSdkError::new(ErrorCode::Timeout, Operation::UpdateFirmware, true)
                        .with_detail("timed out waiting for firmware reboot reconnect"),
                    context,
                ),
            );
            return Ok(effects);
        }

        let connection = self
            .connection
            .as_mut()
            .expect("reconnecting phase owns a connection reducer");
        let effects = connection.dispatch(event, context)?;
        let status = connection.terminal_status();
        match status {
            Some(WorkflowStatus::Completed { .. }) => {
                self.connection = None;
                let mut filtered = Self::filter_connection_effects(effects);
                filtered.extend(self.cancel_reconnect_timer(context));
                filtered.extend(self.read_version(context));
                Ok(filtered)
            }
            Some(WorkflowStatus::Failed { error }) => {
                self.connection = None;
                Ok(self.fail(error, context))
            }
            _ => Ok(Self::filter_connection_effects(effects)),
        }
    }
}

impl WorkflowReducer for FirmwareUpdateWorkflow {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let started = context.request(Effect::Notify(WorkflowNotification::Started {
            operation: Operation::UpdateFirmware,
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

        if self.phase == Phase::Reconnecting {
            return self.dispatch_reconnect(event, context);
        }

        if let HostEventKind::Ble(BleEvent::Notification {
            characteristic_uuid,
            value,
        }) = &event.kind
            && Some(event.request_id) == self.subscription_request_id
            && characteristic_uuid == CHAR_TRANSFER_STATUS
        {
            return self.handle_status_notification(value, context);
        }

        if self.phase == Phase::AwaitingReboot
            && matches!(
                event.kind,
                HostEventKind::Ble(BleEvent::Disconnected { .. })
            )
        {
            let mut effects = self.cancel_timer(context);
            effects.extend(self.unsubscribe(context));
            effects.extend(self.begin_reconnect(context));
            return Ok(effects);
        }

        let request_id = event.request_id;
        match (self.phase, event.kind) {
            (Phase::LoadingCheckpoint, HostEventKind::CheckpointLoaded { checkpoint })
                if Some(request_id) == self.load_request_id =>
            {
                self.load_request_id = None;
                if let Some(checkpoint) = checkpoint.filter(|value| self.checkpoint_matches(value))
                {
                    self.retry_count = checkpoint.retry_count.saturating_add(1);
                    return match checkpoint.phase {
                        CheckpointPhase::Reconnecting => Ok(self.begin_reconnect(context)),
                        CheckpointPhase::Transferring | CheckpointPhase::Verifying => {
                            Ok(self.subscribe(context))
                        }
                        _ => Ok(self.begin_download(context)),
                    };
                }
                Ok(self.begin_download(context))
            }
            (
                Phase::Downloading,
                HostEventKind::Network(NetworkEvent::DownloadProgress {
                    download_id,
                    completed_bytes,
                    total_bytes,
                }),
            ) if Some(request_id) == self.download_request_id
                && download_id == self.download_id =>
            {
                Ok(vec![self.progress(
                    FirmwareUpdatePhase::Downloading,
                    completed_bytes,
                    total_bytes.unwrap_or(u64::from(self.image.size_bytes)),
                    context,
                )])
            }
            (
                Phase::Downloading,
                HostEventKind::Network(NetworkEvent::DownloadCompleted { download_id }),
            ) if Some(request_id) == self.download_request_id
                && download_id == self.download_id =>
            {
                self.download_request_id = None;
                let mut effects = vec![self.checkpoint(CheckpointPhase::Transferring, context)];
                effects.extend(self.subscribe(context));
                Ok(effects)
            }
            (
                Phase::Downloading,
                HostEventKind::Network(NetworkEvent::Failed {
                    transfer_id,
                    status_code,
                }),
            ) if Some(request_id) == self.download_request_id
                && transfer_id == self.download_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(ErrorCode::DownloadFailed, Operation::UpdateFirmware, true)
                        .with_protocol_status(status_code.unwrap_or(0))
                        .with_detail("firmware download failed"),
                    context,
                ))
            }
            (
                Phase::Subscribing,
                HostEventKind::Ble(BleEvent::Subscribed {
                    characteristic_uuid,
                }),
            ) if Some(request_id) == self.subscription_request_id
                && characteristic_uuid == CHAR_TRANSFER_STATUS =>
            {
                Ok(self.write_start(context))
            }
            (Phase::Starting, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                if self.ready_result == Some(0) {
                    Ok(self.begin_transfer(context))
                } else {
                    self.phase = Phase::AwaitingReady;
                    Ok(Vec::new())
                }
            }
            (
                Phase::ReadingChunk,
                HostEventKind::FirmwareChunkRead {
                    download_id,
                    offset,
                    bytes,
                },
            ) if Some(request_id) == self.blob_request_id
                && download_id == self.download_id
                && offset == self.offset =>
            {
                self.blob_request_id = None;
                let remaining = u64::from(self.image.size_bytes).saturating_sub(self.offset);
                if bytes.is_empty()
                    || bytes.len() > FIRMWARE_CHUNK_SIZE
                    || bytes.len() as u64 > remaining
                {
                    return Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::PersistenceFailed,
                            Operation::UpdateFirmware,
                            true,
                        )
                        .with_detail("firmware blob returned an invalid chunk"),
                        context,
                    ));
                }
                self.write_chunk(bytes, context)
            }
            (Phase::WritingChunk, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                let sent_sequence = self.next_sequence;
                self.next_sequence = self.next_sequence.wrapping_add(1);
                self.offset = self.offset.saturating_add(self.pending_chunk_units);
                self.pending_chunk_units = 0;
                let mut effects = vec![
                    self.checkpoint(CheckpointPhase::Transferring, context),
                    self.progress(
                        FirmwareUpdatePhase::Transferring,
                        self.offset,
                        u64::from(self.image.size_bytes),
                        context,
                    ),
                ];
                if self.next_sequence.is_multiple_of(ACK_WINDOW) {
                    if self.latest_ack == Some(sent_sequence) {
                        effects.extend(self.read_next_or_verify(context));
                    } else {
                        effects.extend(self.wait_for_ack(sent_sequence, context));
                    }
                } else {
                    effects.extend(self.read_next_or_verify(context));
                }
                Ok(effects)
            }
            (
                Phase::WaitingAck,
                HostEventKind::TimerFired {
                    timer_id: ACK_TIMEOUT_ID,
                },
            ) if Some(request_id) == self.timer_request_id => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::Timeout, Operation::UpdateFirmware, true)
                    .with_detail("firmware flow-control acknowledgement timed out"),
                context,
            )),
            (Phase::Verifying, HostEventKind::Ble(BleEvent::WriteCompleted))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                if self.verify_result == Some(0) {
                    Ok(self.begin_reboot(context))
                } else {
                    self.phase = Phase::AwaitingVerify;
                    Ok(Vec::new())
                }
            }
            (
                Phase::AwaitingReboot,
                HostEventKind::TimerFired {
                    timer_id: REBOOT_TIMEOUT_ID,
                },
            ) if Some(request_id) == self.timer_request_id => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::Timeout, Operation::UpdateFirmware, true)
                    .with_detail("device did not reboot after firmware verification"),
                context,
            )),
            (Phase::ReadingVersion, HostEventKind::Ble(BleEvent::ReadCompleted { value }))
                if Some(request_id) == self.write_request_id =>
            {
                self.write_request_id = None;
                let version = String::from_utf8(value)
                    .unwrap_or_default()
                    .trim_matches(['\0', ' ', '\r', '\n'])
                    .to_owned();
                if version == self.image.version {
                    Ok(self.complete(context))
                } else {
                    Ok(self.fail(
                        DeviceSdkError::new(
                            ErrorCode::ProtocolRejected,
                            Operation::UpdateFirmware,
                            true,
                        )
                        .with_detail(format!(
                            "device reports firmware {version}, expected {}",
                            self.image.version
                        )),
                        context,
                    ))
                }
            }
            (_, HostEventKind::FirmwareBlobFailed { platform_code })
                if Some(request_id) == self.blob_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::PersistenceFailed,
                        Operation::UpdateFirmware,
                        true,
                    )
                    .with_detail(format!(
                        "firmware blob read failed with code {platform_code:?}"
                    )),
                    context,
                ))
            }
            (_, HostEventKind::PersistenceFailed { platform_code })
                if self.checkpoint_request_ids.remove(&request_id)
                    || Some(request_id) == self.load_request_id =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::PersistenceFailed,
                        Operation::UpdateFirmware,
                        true,
                    )
                    .with_detail(format!(
                        "firmware checkpoint failed with code {platform_code:?}"
                    )),
                    context,
                ))
            }
            (_, HostEventKind::Ble(BleEvent::Disconnected { .. })) => Ok(self.fail(
                DeviceSdkError::new(ErrorCode::NotConnected, Operation::UpdateFirmware, true)
                    .with_detail("device disconnected before firmware verification completed"),
                context,
            )),
            (_, HostEventKind::Ble(BleEvent::Failed { platform_code }))
                if [
                    self.subscription_request_id,
                    self.write_request_id,
                    self.blob_request_id,
                ]
                .contains(&Some(request_id)) =>
            {
                Ok(self.fail(
                    DeviceSdkError::new(
                        ErrorCode::ConnectionFailed,
                        Operation::UpdateFirmware,
                        true,
                    )
                    .with_detail(format!(
                        "firmware BLE operation failed with code {platform_code:?}"
                    )),
                    context,
                ))
            }
            _ => Err(DeviceSdkError::new(
                ErrorCode::UnexpectedEvent,
                Operation::UpdateFirmware,
                false,
            )
            .with_detail("event does not belong to the active firmware-update phase")),
        }
    }

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest> {
        let mut effects = self.cancel_timer(context);
        effects.extend(self.cancel_reconnect_timer(context));
        if let Some(connection) = self.connection.as_mut() {
            effects.extend(Self::filter_connection_effects(connection.cancel(context)));
        }
        effects.extend(self.unsubscribe(context));
        effects.push(
            context.request(Effect::Notify(WorkflowNotification::Cancelled {
                operation: Operation::UpdateFirmware,
            })),
        );
        effects
    }

    fn terminal_status(&self) -> Option<WorkflowStatus> {
        match self.phase {
            Phase::Completed => Some(WorkflowStatus::Completed {
                operation: Operation::UpdateFirmware,
            }),
            Phase::Failed => Some(WorkflowStatus::Failed {
                error: self
                    .terminal_error
                    .clone()
                    .expect("failed firmware update records its terminal error"),
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
            Phase::Downloading,
            Phase::Subscribing,
            Phase::Starting,
            Phase::AwaitingReady,
            Phase::ReadingChunk,
            Phase::WritingChunk,
            Phase::WaitingAck,
            Phase::Verifying,
            Phase::AwaitingVerify,
            Phase::AwaitingReboot,
            Phase::Reconnecting,
            Phase::ReadingVersion,
        ] {
            let mut workflow = FirmwareUpdateWorkflow::new(
                DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
                FirmwareImage {
                    version: "1.0.18".into(),
                    size_bytes: 1_024,
                    crc32: 0x1234_5678,
                },
                41,
                ReconnectHint::default(),
                CancellationId::from_bytes([1; 16]),
            );
            workflow.phase = phase;
            assert_phase_cancels(&mut workflow, Operation::UpdateFirmware);
        }
    }
}
