mod capability;
mod checkpoint;
mod command;
mod effect;
mod event;

pub use capability::*;
pub use checkpoint::*;
pub use command::*;
pub use effect::*;
pub use event::*;

use crate::error::DeviceSdkError;

pub trait Workflow {
    fn dispatch(&mut self, event: Event) -> Result<Vec<EffectRequest>, DeviceSdkError>;
}
