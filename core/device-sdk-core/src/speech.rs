//! Optional, IO-free speech client policy. RTC transports execute its decisions;
//! they never infer authorization from a room, track name or display name.
//! This owner is independent of the BLE workflow and retains no caption content,
//! audio, endpoint token or playback history.
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    model::parse_rfc3339_millis,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroize;
mod captions;
pub mod capture;
mod finish;
pub use captions::{
    SpeechCaptionFailure, SpeechCaptionRecovery, SpeechCaptionRequest, SpeechCaptionUpdate,
};
pub use finish::{
    SpeechFinishBoundary, SpeechFinishFailure, SpeechFinishRequest, SpeechFinishedSource,
    SpeechSourceFinish,
};

const MAX_JSON: usize = 32 * 1024;
const MAX_SOURCES: usize = 1024;
const MAX_TRACKS: usize = 16;
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
type Result<T> = std::result::Result<T, DeviceSdkError>;
fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
}
fn unavailable() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::NotConnected, Operation::Connect, false)
}
fn bound() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::PayloadTooLarge, Operation::Decode, false)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechRetention {
    OriginalAudioAndText,
    TextOnly,
    LiveOnly,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechListeningMode {
    Translated,
    Original,
    CaptionsOnly,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechContext {
    pub project_id: String,
    pub session_id: String,
    pub participant_id: String,
    pub member_generation: u32,
    pub retention: SpeechRetention,
    pub can_publish: bool,
    pub can_subscribe: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechSubscription {
    pub revision: u32,
    pub target_language: String,
    pub mode: SpeechListeningMode,
    pub source_participant_ids: Vec<String>,
}
impl SpeechSubscription {
    fn validate(&self) -> Result<()> {
        if self.revision > i32::MAX as u32
            || !language(&self.target_language)
            || self.source_participant_ids.len() > 32
            || (self.revision == 0 && !self.source_participant_ids.is_empty())
        {
            return Err(invalid());
        }
        for (i, id) in self.source_participant_ids.iter().enumerate() {
            if !uuid(id) || self.source_participant_ids[..i].contains(id) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
// Credential-bearing input deliberately has no Debug or Serialize implementation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    protocol_version: u8,
    provider: String,
    url: String,
    room: String,
    identity: String,
    token: String,
    expires_at: String,
    session_id: String,
    participant_id: String,
    member_generation: u32,
    worker_generation: u32,
    processor_identity: String,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Clone, PartialEq, Eq)]
struct GrantIdentity {
    url: String,
    room: String,
    identity: String,
    processor: String,
    worker: u32,
}
fn grant(context: &SpeechContext, raw: &str, now: u64) -> Result<(GrantIdentity, u64)> {
    if raw.len() > MAX_JSON || now > MAX_INTEGER {
        return Err(invalid());
    }
    let value: Grant = serde_json::from_str(raw).map_err(|_| invalid())?;
    let host = value
        .url
        .strip_prefix("wss://")
        .and_then(|v| v.strip_suffix(".livekit.cloud"));
    let valid_host = host.is_some_and(|v| {
        !v.is_empty() && v.len() <= 63 && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    });
    let expires = parse_rfc3339_millis(&value.expires_at).map_err(|_| invalid())?;
    let processor = value
        .processor_identity
        .strip_prefix("worker_")
        .and_then(|v| v.rsplit_once('_'))
        .is_some_and(|(id, g)| uuid(id) && g == value.worker_generation.to_string());
    let room_bytes = serde_json::to_vec(&json!([
        context.project_id,
        context.session_id,
        context.participant_id,
        context.member_generation,
        value.worker_generation
    ]))
    .map_err(|_| invalid())?;
    let hash: String = Sha256::digest(room_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if value.protocol_version != 1
        || value.provider != "livekit"
        || !valid_host
        || !processor
        || value.worker_generation == 0
        || value.worker_generation > i32::MAX as u32
        || value.session_id != context.session_id
        || value.participant_id != context.participant_id
        || value.member_generation != context.member_generation
        || value.identity
            != format!(
                "member_{}_{}",
                context.participant_id, context.member_generation
            )
        || value.room != format!("speech_{hash}")
        || value.token.is_empty()
        || value.token.len() > 16384
        || !value.token.bytes().all(|b| b.is_ascii_graphic())
        || expires <= now
        || expires - now > 120_000
    {
        return Err(invalid());
    }
    Ok((
        GrantIdentity {
            url: value.url.clone(),
            room: value.room.clone(),
            identity: value.identity.clone(),
            processor: value.processor_identity.clone(),
            worker: value.worker_generation,
        },
        expires,
    ))
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SpeechCommand {
    BeginSourceFinish,
    SourcePublication {
        track_sid: Option<String>,
    },
    SourceFinishResult {
        request_id: u32,
        body: Value,
    },
    SourceFinishFailure {
        request_id: u32,
        reason: SpeechFinishFailure,
    },
    EnableCaptionRecovery,
    RecoverCaptions,
    CaptionPage {
        request_id: u32,
        page: Value,
    },
    CaptionFailure {
        request_id: u32,
        reason: SpeechCaptionFailure,
    },
    Connected,
    Closed,
    Tick,
    SetMicrophone {
        enabled: bool,
    },
    SetListening {
        enabled: bool,
    },
    BeginChange,
    ApplyDesired {
        change_id: u32,
        subscription: SpeechSubscription,
    },
    BuffersCleared {
        generation: u32,
    },
    TrackRemoved {
        media_track_sid: String,
    },
    Event {
        sender: String,
        json: String,
    },
    Renew {
        grant_json: String,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTrack {
    pub media_track_sid: String,
    pub source_id: String,
    pub source_epoch: u64,
    pub source_participant_id: String,
    pub origin: String,
    pub output_id: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechUpdate {
    pub source_finish: SpeechSourceFinish,
    pub recovery: SpeechCaptionRecovery,
    pub captions: Vec<SpeechCaptionUpdate>,
    pub connected: bool,
    pub disconnect: bool,
    pub can_capture: bool,
    pub can_play: bool,
    pub subscription_revision: u32,
    pub change_id: u32,
    pub clear_generation: u32,
    pub clear_playback: bool,
    pub expires_at_ms: u64,
    pub gap: bool,
    pub event: Option<Value>,
    pub tracks: Vec<SpeechTrack>,
}

pub struct SpeechClient {
    finish: finish::Finish,
    recovery: captions::Recovery,
    context: SpeechContext,
    grant: GrantIdentity,
    expires: u64,
    now: u64,
    subscription: SpeechSubscription,
    connected: bool,
    closed: bool,
    microphone: bool,
    listening: bool,
    changing: bool,
    change_id: u32,
    applied: bool,
    early_applied: Option<Value>,
    sequence: u64,
    clear_generation: u32,
    cleared_generation: u32,
    sources: BTreeMap<String, u64>,
    tracks: BTreeMap<String, SpeechTrack>,
}
impl SpeechClient {
    pub fn from_json(configuration_json: &str, grant_json: &str, now: u64) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Configuration {
            context: SpeechContext,
            subscription: SpeechSubscription,
        }
        if configuration_json.len() > MAX_JSON {
            return Err(bound());
        }
        let config: Configuration =
            serde_json::from_str(configuration_json).map_err(|_| invalid())?;
        Self::new(config.context, grant_json, config.subscription, now)
    }
    /// One bounded JSON projection for both generated JS and browser WASM.
    /// Values crossing this boundary are checked to fit exact JS integers.
    pub fn dispatch_json(&mut self, command_json: &str, now: u64) -> Result<String> {
        if command_json.len() > captions::MAX_PAGE_JSON {
            self.stop()?;
            return Err(bound());
        }
        let command: SpeechCommand = match serde_json::from_str(command_json) {
            Ok(command) => command,
            Err(_) => {
                self.stop()?;
                return Err(invalid());
            }
        };
        if command_json.len() > MAX_JSON && !matches!(command, SpeechCommand::CaptionPage { .. }) {
            self.stop()?;
            return Err(bound());
        }
        serde_json::to_string(&self.dispatch(command, now)?).map_err(|_| invalid())
    }
    pub fn new(
        context: SpeechContext,
        grant_json: &str,
        subscription: SpeechSubscription,
        now: u64,
    ) -> Result<Self> {
        if !identifier(&context.project_id, 128)
            || !uuid(&context.session_id)
            || !uuid(&context.participant_id)
            || context.member_generation == 0
            || context.member_generation > i32::MAX as u32
        {
            return Err(invalid());
        }
        subscription.validate()?;
        let (grant, expires) = grant(&context, grant_json, now)?;
        Ok(Self {
            finish: finish::Finish::default(),
            recovery: captions::Recovery::default(),
            context,
            grant,
            expires,
            now,
            subscription,
            connected: false,
            closed: false,
            microphone: false,
            listening: false,
            changing: false,
            change_id: 0,
            applied: false,
            early_applied: None,
            sequence: 0,
            clear_generation: 1,
            cleared_generation: 0,
            sources: BTreeMap::new(),
            tracks: BTreeMap::new(),
        })
    }
    fn clear(&mut self) -> Result<()> {
        self.clear_generation = self.clear_generation.checked_add(1).ok_or_else(bound)?;
        self.tracks.clear();
        Ok(())
    }
    fn stop(&mut self) -> Result<()> {
        if !self.closed {
            self.clear()?;
        }
        self.closed = true;
        self.connected = false;
        self.microphone = false;
        self.listening = false;
        self.sources.clear();
        self.recovery.close();
        self.finish.close();
        self.early_applied = None;
        Ok(())
    }
    fn update(&self, event: Option<Value>, gap: bool) -> SpeechUpdate {
        SpeechUpdate {
            source_finish: self.finish.snapshot(),
            recovery: self.recovery.snapshot(),
            captions: Vec::new(),
            connected: self.connected,
            disconnect: self.closed,
            can_capture: self.connected
                && !self.closed
                && self.context.can_publish
                && !self.finish.held()
                && self.microphone,
            can_play: self.connected
                && !self.closed
                && self.context.can_subscribe
                && self.listening
                && self.applied
                && !self.changing
                && self.cleared_generation == self.clear_generation
                && self.subscription.mode != SpeechListeningMode::CaptionsOnly,
            subscription_revision: self.subscription.revision,
            change_id: self.change_id,
            clear_generation: self.clear_generation,
            clear_playback: self.clear_generation != self.cleared_generation,
            expires_at_ms: self.expires,
            event,
            gap,
            tracks: self.tracks.values().cloned().collect(),
        }
    }
    /// All clocks are supplied by the host. A backward clock or malformed event
    /// is a terminal adapter error; the host must close media on an Err result.
    pub fn dispatch(&mut self, command: SpeechCommand, now: u64) -> Result<SpeechUpdate> {
        if now < self.now || now > MAX_INTEGER {
            self.stop()?;
            return Err(invalid());
        }
        self.now = now;
        if now >= self.expires {
            self.stop()?;
        }
        if self.closed
            && !matches!(
                command,
                SpeechCommand::Tick | SpeechCommand::Closed | SpeechCommand::BuffersCleared { .. }
            )
        {
            return Err(unavailable());
        }
        let result = self.apply(command);
        if result.is_err() {
            self.stop()?;
        }
        result
    }
    fn apply(&mut self, command: SpeechCommand) -> Result<SpeechUpdate> {
        let mut event = None;
        let mut caption_updates = Vec::new();
        let mut gap = false;
        match command {
            SpeechCommand::BeginSourceFinish => {
                if !self.context.can_publish {
                    return Err(invalid());
                }
                self.microphone = false;
                self.finish.begin(self.now);
            }
            SpeechCommand::SourcePublication { track_sid } => self.finish.publication(track_sid)?,
            SpeechCommand::SourceFinishResult { request_id, body } => {
                self.finish.result(request_id, body, self.now)?
            }
            SpeechCommand::SourceFinishFailure { request_id, reason } => {
                if self.finish.failed(request_id, reason, self.now) {
                    self.stop()?;
                }
            }
            SpeechCommand::EnableCaptionRecovery => self.recovery.enable(),
            SpeechCommand::RecoverCaptions => self.recovery.retry(),
            SpeechCommand::CaptionPage { request_id, page } => {
                caption_updates = self.recovery.page(
                    request_id,
                    page,
                    &self.context,
                    &self.subscription,
                    self.now,
                )?;
            }
            SpeechCommand::CaptionFailure { request_id, reason } => {
                if self.recovery.failed(request_id, &reason, self.now) {
                    match reason {
                        SpeechCaptionFailure::Unauthorized => self.stop()?,
                        SpeechCaptionFailure::StaleSubscription => {
                            self.changing = true;
                            self.applied = false;
                            self.early_applied = None;
                            self.clear()?;
                        }
                        SpeechCaptionFailure::Unavailable => {}
                    }
                }
            }
            SpeechCommand::Connected => {
                self.connected = true;
            }
            SpeechCommand::Closed => {
                self.stop()?;
            }
            SpeechCommand::Tick => {}
            SpeechCommand::SetMicrophone { enabled } => {
                if enabled && !self.context.can_publish {
                    return Err(invalid());
                }
                if !enabled || !self.finish.held() {
                    if enabled {
                        self.finish.reset();
                    }
                    self.microphone = enabled;
                }
            }
            SpeechCommand::SetListening { enabled } => {
                if enabled && !self.context.can_subscribe {
                    return Err(invalid());
                }
                if enabled != self.listening {
                    self.clear()?;
                    self.listening = enabled;
                }
            }
            SpeechCommand::BeginChange => {
                self.recovery.reset();
                self.change_id = self.change_id.checked_add(1).ok_or_else(bound)?;
                self.changing = true;
                self.clear()?;
            }
            SpeechCommand::ApplyDesired {
                change_id,
                subscription,
            } => {
                if change_id != self.change_id || !self.changing {
                    return Ok(self.update(None, false));
                }
                subscription.validate()?;
                if subscription.revision < self.subscription.revision
                    || (subscription.revision == self.subscription.revision
                        && subscription != self.subscription)
                {
                    return Err(invalid());
                }
                if subscription != self.subscription {
                    self.applied = false;
                    self.sequence = 0;
                    self.sources.clear();
                }
                self.subscription = subscription;
                self.changing = false;
                if let Some(early) = self.early_applied.take() {
                    self.apply_ack(&early)?;
                }
            }
            SpeechCommand::BuffersCleared { generation } => {
                if generation == self.clear_generation {
                    self.cleared_generation = generation;
                }
            }
            SpeechCommand::TrackRemoved { media_track_sid } => {
                self.tracks.remove(&media_track_sid);
            }
            SpeechCommand::Renew { grant_json } => {
                let (identity, expires) = grant(&self.context, &grant_json, self.now)?;
                if identity != self.grant || expires < self.expires {
                    return Err(invalid());
                }
                self.expires = expires;
            }
            SpeechCommand::Event { sender, json } => {
                if sender != self.grant.processor {
                    return Ok(self.update(None, false));
                }
                if json.len() > MAX_JSON {
                    return Err(bound());
                }
                let value: Value = serde_json::from_str(&json).map_err(|_| invalid())?;
                if !self.envelope(&value) {
                    return Ok(self.update(None, false));
                }
                if string(&value, "type")? == "subscription_applied" {
                    only(
                        &value,
                        "protocolVersion projectId sessionId retention participantId memberGeneration workerGeneration subscriptionRevision type targetLanguage mode",
                    )?;
                    if self.changing {
                        // A worker acknowledgement can arrive before the host's
                        // HTTP reply. Retain only this small, content-free hint.
                        let revision = number(&value, "subscriptionRevision")?;
                        if revision >= u64::from(self.subscription.revision)
                            && self.early_applied.as_ref().is_none_or(|old| {
                                old["subscriptionRevision"]
                                    .as_u64()
                                    .is_some_and(|old| revision >= old)
                            })
                        {
                            self.early_applied = Some(value);
                        }
                    } else if self.apply_ack(&value)? {
                        event = Some(value);
                    }
                } else if self.context.can_subscribe
                    && !self.changing
                    && self.applied
                    && number(&value, "subscriptionRevision")?
                        == u64::from(self.subscription.revision)
                {
                    let sequence = number(&value, "eventSequence")?;
                    if sequence == 0 || sequence <= self.sequence {
                        return Ok(self.update(None, false));
                    }
                    self.validate_content(&value)?;
                    gap = sequence != self.sequence + 1;
                    if gap {
                        self.clear()?;
                        self.recovery.hint();
                    }
                    self.sequence = sequence;
                    if self.accept_content(&value)? {
                        if value["type"] == "caption" {
                            if let Some(update) = self.recovery.upsert(
                                value["record"].clone(),
                                value["final"].as_bool().ok_or_else(invalid)?,
                                "live",
                                self.subscription.revision,
                                None,
                            )? {
                                caption_updates.push(update);
                                event = Some(value);
                            }
                        } else {
                            event = Some(value);
                        }
                    }
                }
            }
        }
        self.recovery.poll(
            &self.context,
            &self.subscription,
            self.connected && !self.closed && !self.changing,
            self.now,
        )?;
        self.finish.poll(
            &self.context,
            self.grant.worker,
            self.connected && !self.closed,
            self.now,
        )?;
        let mut update = self.update(event, gap);
        update.captions = caption_updates;
        Ok(update)
    }
    fn envelope(&self, v: &Value) -> bool {
        v.get("protocolVersion") == Some(&json!(1))
            && v.get("projectId") == Some(&json!(self.context.project_id))
            && v.get("sessionId") == Some(&json!(self.context.session_id))
            && v.get("retention") == Some(&json!(self.context.retention))
            && v.get("participantId") == Some(&json!(self.context.participant_id))
            && v.get("memberGeneration") == Some(&json!(self.context.member_generation))
            && v.get("workerGeneration") == Some(&json!(self.grant.worker))
    }
    fn apply_ack(&mut self, v: &Value) -> Result<bool> {
        if number(v, "subscriptionRevision")? != u64::from(self.subscription.revision) {
            return Ok(false);
        }
        if string(v, "targetLanguage")? != self.subscription.target_language
            || v.get("mode") != Some(&json!(self.subscription.mode))
        {
            return Err(invalid());
        }
        self.applied = true;
        Ok(true)
    }
    fn validate_content(&self, v: &Value) -> Result<()> {
        let common = "protocolVersion projectId sessionId retention participantId memberGeneration workerGeneration subscriptionRevision type eventSequence sourceId sourceEpoch sourceParticipantId sourceMemberGeneration";
        let kind = string(v, "type")?;
        let fields = match kind {
            "caption" => "record final",
            "status" => "code unitId",
            "audio_start" | "audio_end" | "audio_cancel" => {
                "unitId outputId targetLanguage channels origin transport codec sourceSampleRate voice mediaTrackSid samples"
            }
            "original_start" => {
                "mediaTrackSid origin transport codec sourceSampleRate channels sourceStartSample workerStartMs"
            }
            _ => return Err(invalid()),
        };
        only(v, &format!("{common} {fields}"))?;
        if !uuid(string(v, "sourceId")?)
            || !uuid(string(v, "sourceParticipantId")?)
            || number(v, "sourceEpoch")? == 0
            || number(v, "sourceMemberGeneration")? == 0
        {
            return Err(invalid());
        }
        match kind {
            "caption" => {
                if v.get("final").and_then(Value::as_bool).is_none() {
                    return Err(invalid());
                }
                let record = v.get("record").ok_or_else(invalid)?;
                captions::validate_record(&self.context, record)?;
                for field in "protocolVersion projectId sessionId retention sourceId sourceEpoch sourceParticipantId sourceMemberGeneration".split(' ') {
                    if record.get(field)!=v.get(field) { return Err(invalid()); }
                }
            }
            "status" => {
                if !matches!(
                    string(v, "code")?,
                    "unauthorized"
                        | "stale_source"
                        | "source_gap"
                        | "invalid_audio"
                        | "provider_unavailable"
                        | "provider_protocol"
                        | "buffer_limit"
                        | "output_skipped"
                        | "cancelled"
                        | "conflict"
                        | "not_ready"
                ) {
                    return Err(invalid());
                }
                if let Some(unit) = v.get("unitId")
                    && unit.as_str().is_none_or(|s| !identifier(s, 512))
                {
                    return Err(invalid());
                }
            }
            _ => {
                if (kind != "audio_cancel" || v.get("mediaTrackSid").is_some())
                    && !identifier(string(v, "mediaTrackSid")?, 128)
                {
                    return Err(invalid());
                }
                if string(v, "transport")? != "webrtc"
                    || string(v, "codec")? != "opus"
                    || number(v, "channels")? != 1
                {
                    return Err(invalid());
                }
                if kind == "original_start" {
                    if string(v, "origin")? != "original" || number(v, "sourceSampleRate")? != 16000
                    {
                        return Err(invalid());
                    }
                    number(v, "sourceStartSample")?;
                    number(v, "workerStartMs")?;
                } else {
                    if string(v, "origin")? != "generated"
                        || number(v, "sourceSampleRate")? != 24000
                        || !language(string(v, "targetLanguage")?)
                        || string(v, "voice")? != "neutral"
                        || !identifier(string(v, "unitId")?, 512)
                        || !identifier(string(v, "outputId")?, 512)
                    {
                        return Err(invalid());
                    }
                    if kind == "audio_end" {
                        number(v, "samples")?;
                    }
                }
            }
        }
        Ok(())
    }
    fn accept_content(&mut self, v: &Value) -> Result<bool> {
        let source = string(v, "sourceId")?;
        let participant = string(v, "sourceParticipantId")?;
        if participant == self.context.participant_id {
            return Ok(false);
        }
        if !self
            .subscription
            .source_participant_ids
            .iter()
            .any(|id| id == participant)
        {
            return Ok(false);
        }
        let epoch = number(v, "sourceEpoch")?;
        if let Some(old) = self.sources.get(source) {
            if epoch < *old {
                return Ok(false);
            }
            if epoch > *old {
                self.clear()?;
            }
        } else if self.sources.len() >= MAX_SOURCES {
            return Err(bound());
        }
        self.sources.insert(source.into(), epoch);
        let kind = string(v, "type")?;
        if kind == "caption" {
            return Ok(v["record"]
                .get("targetLanguage")
                .is_none_or(|target| target.as_str() == Some(&self.subscription.target_language)));
        }
        if kind == "status" {
            return Ok(true);
        }
        if participant == self.context.participant_id {
            return Ok(false);
        }
        let original = kind == "original_start";
        if (original && self.subscription.mode != SpeechListeningMode::Original)
            || (!original
                && (self.subscription.mode != SpeechListeningMode::Translated
                    || string(v, "targetLanguage")? != self.subscription.target_language))
        {
            return Ok(false);
        }
        if kind == "audio_cancel" && v.get("mediaTrackSid").is_none() {
            return Ok(true);
        }
        let sid = string(v, "mediaTrackSid")?;
        if kind == "audio_cancel" {
            if self.tracks.get(sid).is_some_and(|track| {
                track.output_id.as_deref() == v.get("outputId").and_then(Value::as_str)
            }) {
                self.clear()?;
            }
        } else if kind != "audio_end" {
            if !self.tracks.contains_key(sid) && self.tracks.len() >= MAX_TRACKS {
                return Err(bound());
            }
            self.tracks.insert(
                sid.into(),
                SpeechTrack {
                    media_track_sid: sid.into(),
                    source_id: source.into(),
                    source_epoch: epoch,
                    source_participant_id: participant.into(),
                    origin: if original { "original" } else { "generated" }.into(),
                    output_id: v.get("outputId").and_then(Value::as_str).map(str::to_owned),
                },
            );
        }
        // audio_end means sender drain, not that the listener has heard every
        // sample. Keep the track eligible until cancellation/change/expiry.
        Ok(true)
    }
}
fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or_else(invalid)
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or_else(invalid)
}
fn number(v: &Value, key: &str) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_INTEGER)
        .ok_or_else(invalid)
}
fn scalar(v: &Value, key: &str) -> Result<f64> {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| *n >= 0.0 && *n <= MAX_INTEGER as f64)
        .ok_or_else(invalid)
}
fn only(v: &Value, fields: &str) -> Result<()> {
    if object(v)?
        .keys()
        .any(|key| !fields.split(' ').any(|allowed| allowed == key))
    {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn identifier(v: &str, max: usize) -> bool {
    !v.is_empty()
        && v.len() <= max
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:-.".contains(&c))
}
fn language(v: &str) -> bool {
    matches!(v, "en" | "zh" | "ja" | "ko" | "es" | "fr" | "de")
}
fn uuid(v: &str) -> bool {
    v.len() == 36
        && v.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
