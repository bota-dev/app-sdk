mod discovery;

pub(crate) use discovery::DiscoveryWorkflow;

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

    fn is_completed(&self) -> bool;

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
