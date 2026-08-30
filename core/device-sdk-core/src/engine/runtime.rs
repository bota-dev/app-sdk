use crate::{
    engine::{CancellationId, CapabilitySet, Command, EffectRequest, Event, WorkflowStatus},
    error::{DeviceSdkError, ErrorCode, Operation},
    workflow::{ConnectionWorkflow, DiscoveryWorkflow, WorkflowContext, WorkflowReducer},
};

enum ActiveWorkflow {
    Discovery(DiscoveryWorkflow),
    Connection(Box<ConnectionWorkflow>),
}

impl ActiveWorkflow {
    fn operation(&self) -> Operation {
        match self {
            Self::Discovery(_) => Operation::Discover,
            Self::Connection(workflow) => workflow.operation(),
        }
    }

    fn cancellation_id(&self) -> CancellationId {
        match self {
            Self::Discovery(workflow) => workflow.cancellation_id(),
            Self::Connection(workflow) => workflow.cancellation_id(),
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
            Command::Reconnect { device, hint } => ActiveWorkflow::Connection(Box::new(
                ConnectionWorkflow::reconnect(device, hint, cancellation_id),
            )),
            _ => {
                return Err(
                    DeviceSdkError::new(ErrorCode::UnsupportedOperation, operation, false)
                        .with_detail("workflow reducer is not implemented"),
                );
            }
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
        };

        let terminal_status = match active {
            ActiveWorkflow::Discovery(workflow) => workflow.terminal_status(),
            ActiveWorkflow::Connection(workflow) => workflow.terminal_status(),
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
