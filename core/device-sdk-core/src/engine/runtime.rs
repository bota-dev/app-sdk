use crate::{
    engine::{CancellationId, CapabilitySet, Command, EffectRequest, Event, WorkflowStatus},
    error::{DeviceSdkError, ErrorCode, Operation},
    workflow::{
        ConnectionWorkflow, DeviceLogsWorkflow, DiscoveryWorkflow, FactoryResetWorkflow,
        FirmwareUpdateWorkflow, ProvisioningWorkflow, RecordingTransferWorkflow,
        UploadHandoffWorkflow, WorkflowContext, WorkflowReducer,
    },
};

enum ActiveWorkflow {
    Discovery(DiscoveryWorkflow),
    Connection(Box<ConnectionWorkflow>),
    Provisioning(Box<ProvisioningWorkflow>),
    FactoryReset(Box<FactoryResetWorkflow>),
    RecordingTransfer(Box<RecordingTransferWorkflow>),
    UploadHandoff(Box<UploadHandoffWorkflow>),
    FirmwareUpdate(Box<FirmwareUpdateWorkflow>),
    DeviceLogs(Box<DeviceLogsWorkflow>),
}

impl ActiveWorkflow {
    fn operation(&self) -> Operation {
        match self {
            Self::Discovery(_) => Operation::Discover,
            Self::Connection(workflow) => workflow.operation(),
            Self::Provisioning(_) => Operation::Provision,
            Self::FactoryReset(_) => Operation::FactoryReset,
            Self::RecordingTransfer(_) => Operation::TransferRecording,
            Self::UploadHandoff(_) => Operation::Upload,
            Self::FirmwareUpdate(_) => Operation::UpdateFirmware,
            Self::DeviceLogs(_) => Operation::ReadDeviceLogs,
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        match self {
            Self::Discovery(workflow) => workflow.cancellation_id(),
            Self::Connection(workflow) => workflow.cancellation_id(),
            Self::Provisioning(workflow) => workflow.cancellation_id(),
            Self::FactoryReset(workflow) => workflow.cancellation_id(),
            Self::RecordingTransfer(workflow) => workflow.cancellation_id(),
            Self::UploadHandoff(workflow) => workflow.cancellation_id(),
            Self::FirmwareUpdate(workflow) => workflow.cancellation_id(),
            Self::DeviceLogs(workflow) => workflow.cancellation_id(),
        }
    }
}

pub struct WorkflowEngine {
    active: Option<ActiveWorkflow>,
    status: WorkflowStatus,
    next_request_id: u64,
    terminal_cancellation_id: Option<CancellationId>,
}

impl Default for WorkflowEngine {
    fn default() -> Self {
        Self {
            active: None,
            status: WorkflowStatus::Idle,
            next_request_id: 1,
            terminal_cancellation_id: None,
        }
    }
}

impl WorkflowEngine {
    pub const fn status(&self) -> &WorkflowStatus {
        &self.status
    }

    pub fn start(
        &mut self,
        command: Command,
        capabilities: &CapabilitySet,
        cancellation_id: CancellationId,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        if let Some(active) = &self.active {
            return Err(DeviceSdkError::new(
                ErrorCode::OperationInProgress,
                command.operation(),
                false,
            )
            .with_detail(format!(
                "{} already owns the workflow engine",
                active.operation().as_str()
            )));
        }

        command.authorize(capabilities)?;
        let operation = command.operation();
        let active = match command {
            Command::DiscoverDevices {
                timeout_ms,
                allow_duplicates,
            } => ActiveWorkflow::Discovery(DiscoveryWorkflow::new(
                cancellation_id,
                timeout_ms,
                allow_duplicates,
            )),
            Command::Connect { device, candidate } => ActiveWorkflow::Connection(Box::new(
                ConnectionWorkflow::manual(device, candidate, cancellation_id),
            )),
            Command::ConnectSelected { candidate } => ActiveWorkflow::Connection(Box::new(
                ConnectionWorkflow::selected(candidate, cancellation_id),
            )),
            Command::Reconnect { device, hint } => ActiveWorkflow::Connection(Box::new(
                ConnectionWorkflow::reconnect(device, hint, cancellation_id),
            )),
            Command::Provision {
                device,
                material_id,
            } => ActiveWorkflow::Provisioning(Box::new(ProvisioningWorkflow::new(
                device,
                material_id,
                cancellation_id,
            ))),
            Command::FactoryReset {
                device,
                command_id,
                grant_id,
            } => ActiveWorkflow::FactoryReset(Box::new(FactoryResetWorkflow::start_new(
                device,
                command_id,
                grant_id,
                cancellation_id,
            ))),
            Command::ResumeFactoryReset {
                device,
                command_id,
                expected_result,
            } => {
                ActiveWorkflow::FactoryReset(Box::new(FactoryResetWorkflow::resume(
                    device,
                    command_id,
                    expected_result,
                    cancellation_id,
                )))
            }
            Command::TransferRecording {
                device,
                recording,
                sink_id,
                total_units,
            } => ActiveWorkflow::RecordingTransfer(Box::new(RecordingTransferWorkflow::new(
                device,
                recording,
                sink_id,
                total_units,
                cancellation_id,
            ))),
            Command::UploadRecording {
                device,
                recording,
                upload_id,
                destination_id,
            } => ActiveWorkflow::UploadHandoff(Box::new(UploadHandoffWorkflow::new(
                device,
                recording,
                upload_id,
                destination_id,
                cancellation_id,
            ))),
            Command::UpdateFirmware {
                device,
                image,
                download_id,
                reconnect_hint,
            } => ActiveWorkflow::FirmwareUpdate(Box::new(FirmwareUpdateWorkflow::new(
                device,
                image,
                download_id,
                reconnect_hint,
                cancellation_id,
            ))),
            Command::ReadDeviceLogs { device } => ActiveWorkflow::DeviceLogs(Box::new(
                DeviceLogsWorkflow::new(device, cancellation_id),
            )),
        };

        self.status = WorkflowStatus::Running {
            operation,
            cancellation_id,
        };
        self.terminal_cancellation_id = None;
        self.active = Some(active);

        let mut context =
            WorkflowContext::new(&mut self.next_request_id, operation, cancellation_id);
        let effects = match self.active.as_mut() {
            Some(ActiveWorkflow::Discovery(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::Connection(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::Provisioning(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::FactoryReset(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::RecordingTransfer(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::UploadHandoff(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::FirmwareUpdate(workflow)) => workflow.start(&mut context),
            Some(ActiveWorkflow::DeviceLogs(workflow)) => workflow.start(&mut context),
            None => unreachable!("workflow was assigned above"),
        };
        Ok(effects)
    }

    pub fn dispatch(&mut self, event: Event) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        if let Event::Cancelled { cancellation_id } = event {
            return self.cancel(cancellation_id);
        }

        let Some(active) = self.active.as_mut() else {
            return Err(unexpected_event(
                Operation::Unknown,
                "no workflow is active",
            ));
        };
        let operation = active.operation();
        let cancellation_id = active.cancellation_id();
        let Event::Host(host_event) = event else {
            unreachable!("cancellation is handled above")
        };
        let mut context =
            WorkflowContext::new(&mut self.next_request_id, operation, cancellation_id);
        let effects = match active {
            ActiveWorkflow::Discovery(workflow) => workflow.dispatch(host_event, &mut context)?,
            ActiveWorkflow::Connection(workflow) => workflow.dispatch(host_event, &mut context)?,
            ActiveWorkflow::Provisioning(workflow) => {
                workflow.dispatch(host_event, &mut context)?
            }
            ActiveWorkflow::FactoryReset(workflow) => {
                workflow.dispatch(host_event, &mut context)?
            }
            ActiveWorkflow::RecordingTransfer(workflow) => {
                workflow.dispatch(host_event, &mut context)?
            }
            ActiveWorkflow::UploadHandoff(workflow) => {
                workflow.dispatch(host_event, &mut context)?
            }
            ActiveWorkflow::FirmwareUpdate(workflow) => {
                workflow.dispatch(host_event, &mut context)?
            }
            ActiveWorkflow::DeviceLogs(workflow) => workflow.dispatch(host_event, &mut context)?,
        };

        let terminal_status = match active {
            ActiveWorkflow::Discovery(workflow) => workflow.terminal_status(),
            ActiveWorkflow::Connection(workflow) => workflow.terminal_status(),
            ActiveWorkflow::Provisioning(workflow) => workflow.terminal_status(),
            ActiveWorkflow::FactoryReset(workflow) => workflow.terminal_status(),
            ActiveWorkflow::RecordingTransfer(workflow) => workflow.terminal_status(),
            ActiveWorkflow::UploadHandoff(workflow) => workflow.terminal_status(),
            ActiveWorkflow::FirmwareUpdate(workflow) => workflow.terminal_status(),
            ActiveWorkflow::DeviceLogs(workflow) => workflow.terminal_status(),
        };
        if let Some(status) = terminal_status {
            self.status = status;
            self.active = None;
        }
        Ok(effects)
    }

    fn cancel(
        &mut self,
        cancellation_id: CancellationId,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
        let Some(active) = self.active.as_mut() else {
            if self.terminal_cancellation_id == Some(cancellation_id) {
                return Ok(Vec::new());
            }
            return Err(unexpected_event(
                Operation::Unknown,
                "no workflow is active",
            ));
        };
        let operation = active.operation();
        let active_cancellation_id = active.cancellation_id();
        if active_cancellation_id != cancellation_id {
            return Err(unexpected_event(
                operation,
                "cancellation ID does not own the active workflow",
            ));
        }

        let mut context =
            WorkflowContext::new(&mut self.next_request_id, operation, cancellation_id);
        let effects = match active {
            ActiveWorkflow::Discovery(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::Connection(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::Provisioning(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::FactoryReset(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::RecordingTransfer(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::UploadHandoff(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::FirmwareUpdate(workflow) => workflow.cancel(&mut context),
            ActiveWorkflow::DeviceLogs(workflow) => workflow.cancel(&mut context),
        };
        self.status = WorkflowStatus::Cancelled { operation };
        self.terminal_cancellation_id = Some(cancellation_id);
        self.active = None;
        Ok(effects)
    }
}

fn unexpected_event(operation: Operation, detail: &str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::UnexpectedEvent, operation, false).with_detail(detail)
}
