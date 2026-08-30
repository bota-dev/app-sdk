use crate::{
    engine::CancellationId,
    error::{DeviceSdkError, Operation},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WorkflowStatus {
    Idle,
    Running {
        operation: Operation,
        cancellation_id: CancellationId,
    },
    Completed {
        operation: Operation,
    },
    Cancelled {
        operation: Operation,
    },
    Failed {
        error: DeviceSdkError,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WorkflowNotification {
    Started {
        operation: Operation,
    },
    DeviceDiscovered {
        peripheral_id: String,
        name: Option<String>,
        advertisement: Vec<u8>,
    },
    Progress {
        operation: Operation,
        completed_units: u64,
        total_units: u64,
    },
    Retrying {
        operation: Operation,
        attempt: u32,
    },
    Completed {
        operation: Operation,
    },
    Cancelled {
        operation: Operation,
    },
    Failed {
        error: DeviceSdkError,
    },
}
