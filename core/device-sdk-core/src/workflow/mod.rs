mod connection;
mod device_logs;
mod discovery;
mod encrypted_upload_v2;
mod factory_reset;
mod firmware_update;
mod provisioning;
mod recording_transfer;
mod streaming_transfer;
mod upload_handoff;

pub(crate) use connection::ConnectionWorkflow;
pub(crate) use device_logs::DeviceLogsWorkflow;
pub(crate) use discovery::DiscoveryWorkflow;
pub(crate) use encrypted_upload_v2::EncryptedUploadV2Workflow;
pub use encrypted_upload_v2::{
    EncryptedUploadV2Action, EncryptedUploadV2BatchCoordinator, EncryptedUploadV2BatchEvent,
    EncryptedUploadV2BatchRequest, EncryptedUploadV2BatchStatus, EncryptedUploadV2Checkpoint,
    EncryptedUploadV2TransferEvidence,
};
pub(crate) use factory_reset::FactoryResetWorkflow;
pub(crate) use firmware_update::FirmwareUpdateWorkflow;
pub(crate) use provisioning::ProvisioningWorkflow;
pub(crate) use recording_transfer::RecordingTransferWorkflow;
pub(crate) use streaming_transfer::StreamingTransferWorkflow;
pub(crate) use upload_handoff::UploadHandoffWorkflow;

use crate::{
    engine::{CancellationId, Effect, EffectRequest, HostEvent, RequestId},
    error::{DeviceSdkError, Operation},
};

pub(crate) trait WorkflowReducer {
    fn start(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest>;

    fn dispatch(
        &mut self,
        event: HostEvent,
        context: &mut WorkflowContext<'_>,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError>;

    fn cancel(&mut self, context: &mut WorkflowContext<'_>) -> Vec<EffectRequest>;

    fn terminal_status(&self) -> Option<crate::engine::WorkflowStatus>;

    fn cancellation_id(&self) -> CancellationId;
}

pub(crate) struct WorkflowContext<'a> {
    next_request_id: &'a mut u64,
    operation: Operation,
    cancellation_id: CancellationId,
}

impl<'a> WorkflowContext<'a> {
    pub(crate) fn new(
        next_request_id: &'a mut u64,
        operation: Operation,
        cancellation_id: CancellationId,
    ) -> Self {
        Self {
            next_request_id,
            operation,
            cancellation_id,
        }
    }

    pub(crate) fn request(&mut self, effect: Effect) -> EffectRequest {
        let request_id = RequestId::from_u64(*self.next_request_id);
        *self.next_request_id = self.next_request_id.saturating_add(1);
        EffectRequest::new(request_id, self.operation, self.cancellation_id, effect)
    }
}

#[cfg(test)]
pub(crate) fn assert_phase_cancels(workflow: &mut impl WorkflowReducer, operation: Operation) {
    let mut next_request_id = 1;
    let cancellation_id = workflow.cancellation_id();
    let mut context = WorkflowContext::new(&mut next_request_id, operation, cancellation_id);
    let effects = workflow.cancel(&mut context);
    assert!(effects.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(crate::engine::WorkflowNotification::Cancelled {
            operation: value
        }) if value == operation
    )));
}
