use std::collections::BTreeSet;

use bota_device_sdk_core::engine::{EffectRequest, Event, HostEvent, HostEventKind, RequestId};

#[derive(Default)]
pub struct FakeHost {
    outstanding: BTreeSet<RequestId>,
    pub trace: Vec<EffectRequest>,
}

impl FakeHost {
    pub fn record(&mut self, effects: Vec<EffectRequest>) {
        for effect in effects {
            self.outstanding.insert(effect.request_id);
            self.trace.push(effect);
        }
    }

    pub fn respond(
        &self,
        request_id: RequestId,
        kind: HostEventKind,
    ) -> Result<Event, &'static str> {
        if !self.outstanding.contains(&request_id) {
            return Err("response request ID is not outstanding");
        }
        Ok(Event::Host(HostEvent { request_id, kind }))
    }
}
