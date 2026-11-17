//! Exact-source finish intent and bounded status reconciliation, without media IO.
use super::{MAX_INTEGER, Result, SpeechContext, bound, invalid, uuid};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFinishRequest {
    pub request_id: u32,
    pub project_id: String,
    pub session_id: String,
    pub participant_id: String,
    pub member_generation: u32,
    pub worker_generation: u32,
    pub track_sid: String,
    pub source_id: Option<String>,
    pub source_epoch: Option<u32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechFinishedSource {
    pub id: String,
    pub epoch: u32,
    pub participant_id: String,
    pub member_generation: u32,
    pub track_sid: String,
    pub state: String,
    pub finish: SpeechFinishBoundary,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechFinishBoundary {
    pub state: String,
    pub worker_generation: u32,
    pub sequence: Option<String>,
    pub samples: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSourceFinish {
    pub status: &'static str,
    pub hold_publication: bool,
    pub track_sid: Option<String>,
    pub source: Option<SpeechFinishedSource>,
    pub request: Option<SpeechFinishRequest>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechFinishFailure {
    Unavailable,
    Unauthorized,
    StaleSource,
}
pub(super) struct Finish {
    view: SpeechSourceFinish,
    next_id: u32,
    next_at: u64,
    deadline: u64,
}
impl Default for Finish {
    fn default() -> Self {
        Self {
            view: SpeechSourceFinish {
                status: "idle",
                hold_publication: false,
                track_sid: None,
                source: None,
                request: None,
            },
            next_id: 0,
            next_at: 0,
            deadline: 0,
        }
    }
}
impl Finish {
    pub fn snapshot(&self) -> SpeechSourceFinish {
        self.view.clone()
    }
    pub fn held(&self) -> bool {
        self.view.hold_publication
    }
    pub fn reset(&mut self) {
        let next_id = self.next_id;
        *self = Self::default();
        self.next_id = next_id;
    }
    pub fn close(&mut self) {
        self.reset();
        self.view.status = "closed";
    }
    pub fn begin(&mut self, now: u64) {
        if self.held() && self.view.status != "unavailable" && now < self.deadline {
            return;
        }
        if !self.held() {
            self.reset();
            self.view.status = "preparing";
        } else {
            self.view.status = "waiting";
        }
        self.view.hold_publication = true;
        self.next_at = now;
        self.deadline = now.saturating_add(90_000);
    }
    pub fn publication(&mut self, sid: Option<String>) -> Result<()> {
        if self.view.status != "preparing" {
            return Ok(());
        }
        if let Some(sid) = sid {
            if sid.is_empty()
                || sid.len() > 128
                || !sid
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            {
                return Err(invalid());
            }
            self.view.track_sid = Some(sid);
            self.view.status = "waiting";
        } else {
            self.view.status = "no_source";
            self.view.hold_publication = false;
        }
        Ok(())
    }
    pub fn poll(
        &mut self,
        context: &SpeechContext,
        worker: u32,
        connected: bool,
        now: u64,
    ) -> Result<()> {
        if !self.held() {
            return Ok(());
        }
        if now >= self.deadline {
            self.view.status = "unavailable";
            self.view.request = None;
            return Ok(());
        }
        if !connected
            || self.view.request.is_some()
            || self.view.status == "unavailable"
            || now < self.next_at
        {
            return Ok(());
        }
        let Some(sid) = &self.view.track_sid else {
            return Ok(());
        };
        self.next_id = self.next_id.checked_add(1).ok_or_else(bound)?;
        self.view.request = Some(SpeechFinishRequest {
            request_id: self.next_id,
            project_id: context.project_id.clone(),
            session_id: context.session_id.clone(),
            participant_id: context.participant_id.clone(),
            member_generation: context.member_generation,
            worker_generation: worker,
            track_sid: sid.clone(),
            source_id: self.view.source.as_ref().map(|s| s.id.clone()),
            source_epoch: self.view.source.as_ref().map(|s| s.epoch),
        });
        Ok(())
    }
    pub fn result(&mut self, id: u32, body: Value, now: u64) -> Result<()> {
        if self.held() && now >= self.deadline {
            self.view.status = "unavailable";
            self.view.request = None;
            return Ok(());
        }
        let Some(request) = self.view.request.as_ref().filter(|r| r.request_id == id) else {
            return Ok(());
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Response {
            source: SpeechFinishedSource,
        }
        if body.to_string().len() > 4096 {
            return Err(bound());
        }
        let source = serde_json::from_value::<Response>(body)
            .map_err(|_| invalid())?
            .source;
        let finish = &source.finish;
        if !uuid(&source.id)
            || source.epoch == 0
            || source.epoch > i32::MAX as u32
            || source.participant_id != request.participant_id
            || source.member_generation != request.member_generation
            || source.track_sid != request.track_sid
            || finish.worker_generation != request.worker_generation
            || request.source_id.as_ref().is_some_and(|v| v != &source.id)
            || request.source_epoch.is_some_and(|v| v != source.epoch)
        {
            return Err(invalid());
        }
        let has_boundary = match (&finish.sequence, &finish.samples) {
            (None, None) => false,
            (Some(sequence), Some(samples)) if decimal(sequence) && decimal(samples) => true,
            _ => return Err(invalid()),
        };
        let (status, held) = match finish.state.as_str() {
            "requested" if source.state == "active" && !has_boundary => ("requested", true),
            "draining" if source.state == "active" && has_boundary => ("draining", true),
            "completed" if source.state == "ended" && has_boundary => ("completed", false),
            "interrupted" if source.state == "interrupted" => ("interrupted", false),
            _ => return Err(invalid()),
        };
        if self.view.source.as_ref().is_some_and(|old| {
            old.finish.sequence.is_some()
                && (old.finish.sequence != finish.sequence || old.finish.samples != finish.samples)
        }) {
            return Err(invalid());
        }
        self.view.source = Some(source);
        self.view.status = status;
        self.view.hold_publication = held;
        self.view.request = None;
        self.next_at = now.saturating_add(1000);
        Ok(())
    }
    /// True means current publisher authorization is lost and the owner must close.
    pub fn failed(&mut self, id: u32, reason: SpeechFinishFailure, now: u64) -> bool {
        if !self
            .view
            .request
            .as_ref()
            .is_some_and(|r| r.request_id == id)
        {
            return false;
        }
        self.view.request = None;
        match reason {
            SpeechFinishFailure::Unauthorized => return true,
            SpeechFinishFailure::StaleSource => {
                self.view.status = "stale";
                self.view.hold_publication = false;
            }
            SpeechFinishFailure::Unavailable => {
                self.view.status = "retrying";
                self.next_at = now.saturating_add(1000);
            }
        }
        false
    }
}
fn decimal(value: &str) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|n| n <= MAX_INTEGER && n.to_string() == value)
}
