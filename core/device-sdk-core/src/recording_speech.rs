//! Metadata-only direct recording transport policy. Platform IO owns sockets,
//! capture, encryption and playback; original audio never enters this facade.
use crate::{error::{DeviceSdkError, ErrorCode, Operation}, model::parse_rfc3339_millis};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::OnceLock;
use zeroize::Zeroize;

type Result<T> = std::result::Result<T, DeviceSdkError>;
fn invalid() -> DeviceSdkError { DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false) }
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile { subprotocol: String, path: String, input_magic: String, input_header_bytes: usize,
    input_sample_rate: u32, maximum_frame_samples: u32, maximum_sources: usize, maximum_control_bytes: usize,
    maximum_target_revision: u32, maximum_grant_lifetime_ms: u64 }
fn profile() -> &'static Profile {
    static VALUE: OnceLock<Profile> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(include_str!("../../../protocol/manifest/recording-speech-v1.json")).expect("checked recording speech profile"))
}
fn id(value: &str) -> bool { !value.is_empty() && value.len() <= 80 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }
fn uuid(value: &str) -> bool { value.len() == 36 && value.bytes().enumerate().all(|(i, b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() }) }
fn language(value: &str) -> bool { ["en","zh","ja","ko","fr","de","es"].contains(&value) }
fn endpoint(value: &str) -> bool {
    value.strip_prefix("wss://").and_then(|v| v.strip_suffix(&profile().path)).is_some_and(|host| {
        !host.is_empty() && host.len() <= 253 && host.bytes().all(|b| b.is_ascii_alphanumeric() || [b'.',b'-',b':'].contains(&b))
            && !host.starts_with('.') && !host.ends_with('.')
    })
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration { project_id: String, activity_id: String, endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resume: Option<Vec<Resume>> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resume { source_id: String, sample: u64 }
fn valid_resume(values: &[Resume]) -> bool {
    !values.is_empty() && values.len() <= profile().maximum_sources && values.iter().enumerate().all(|(index, value)|
        id(&value.source_id) && value.sample <= 48000 * 7200 && values[..index].iter().all(|previous| previous.source_id != value.source_id))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant { version: u8, project_id: String, activity_id: String, transport: String, protocol: String,
    url: String, token: String, expires_at: String, generation: u32 }
impl Drop for Grant { fn drop(&mut self) { self.token.zeroize(); } }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source { id: String, epoch: u32, role: String, speaker: String, language: String, start_sample: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capture_clock_id: Option<String> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Boundary { source_id: String, source_epoch: u32, sequence: u64, sample: u64 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target { revision: u32, language: String }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending { request_id: String, expected_revision: u32, language: String, boundaries: Vec<Boundary> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output { id: String, samples: u64 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Heard { source_id: String, last_sequence: u32 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: u8, configuration: Configuration, generation: u32, grant_deadline: u64, ready: bool, closed: bool, finishing: bool,
    sources: Vec<Source>, progress: Vec<Boundary>, target: Target, targets: Vec<Target>, pending: Option<Pending>,
    playback_held: bool, route: String, outputs: Vec<Output>, heard: Vec<Heard>,
}
impl State {
    fn validate(&self) -> Result<()> {
        if self.version != 1 || !id(&self.configuration.project_id) || !uuid(&self.configuration.activity_id) || !endpoint(&self.configuration.endpoint) ||
            self.generation == 0 || self.grant_deadline > MAX_INTEGER || self.closed || !["headphones","unqualified"].contains(&self.route.as_str()) ||
            self.sources.len() > profile().maximum_sources || self.progress.len() != self.sources.len() || self.outputs.len() > 4 || self.heard.len() > profile().maximum_sources ||
            self.targets.len() > profile().maximum_target_revision as usize ||
            self.target.revision > profile().maximum_target_revision || self.ready && (self.sources.is_empty() || self.target.revision == 0 || !language(&self.target.language)) { return Err(invalid()); }
        for (index, source) in self.sources.iter().enumerate() {
            let progress = &self.progress[index];
            if !id(&source.id) || source.epoch == 0 || !["mixed","local","remote"].contains(&source.role.as_str()) ||
                source.capture_clock_id.as_ref().is_some_and(|clock| !uuid(clock)) ||
                !["self","other","unknown"].contains(&source.speaker.as_str()) || source.role == "mixed" && source.speaker != "unknown" ||
                !["en","zh","multi"].contains(&source.language.as_str()) || source.start_sample > progress.sample || progress.sample > MAX_INTEGER || progress.sequence > MAX_INTEGER ||
                progress.source_id != source.id || progress.source_epoch != source.epoch || self.sources[..index].iter().any(|previous| previous.id == source.id || previous.role == source.role) ||
                self.sources.len() == 2 && source.role == "mixed" { return Err(invalid()); }
        }
        Ok(())
    }
    fn active(&self) -> Result<()> { self.validate()?; if !self.ready { return Err(invalid()); } Ok(()) }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready { r#type: String, version: u8, activity_id: String, generation: u32, target: Target,
    sources: Vec<Source>, input: Input, playback_route: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input { format: String, sample_rate: u32, max_frame_samples: u32 }
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Command {
    Create { configuration: Configuration, grant: Grant, now_ms: u64 },
    Ready { state: State, event: Ready, now_ms: u64 },
    BindMicrophone { state: State, clock_id: String },
    Frame { state: State, source_index: usize, first_sample: u64, samples: u32 },
    Target { state: State, request_id: String, language: String },
    TargetCommitted { state: State, request_id: String, revision: u32, language: String },
    PlaybackCleared { state: State, revision: u32 },
    Route { state: State, route: String },
    AudioStart { state: State, activity_id: String, generation: u32, revision: u32, output_id: String },
    AudioChunk { state: State, output_id: String, offset_samples: u64, samples: u32 },
    AudioEnd { state: State, output_id: String, samples: u64 },
    Caption { state: State, activity_id: String, generation: u32, revision: u32, source_id: String, source_epoch: u32,
        unit_id: String, start_sample: u64, end_sample: u64, source_language: String, target_language: Option<String>, text_bytes: u32 },
    Clear { state: State },
    Finish { state: State },
    Close { state: State },
}
pub fn dispatch_json(raw: &str) -> Result<String> {
    if raw.len() > profile().maximum_control_bytes { return Err(invalid()); }
    let command: Command = serde_json::from_str(raw).map_err(|_| invalid())?;
    let result = match command {
        Command::Create { configuration, grant, now_ms } => {
            let expires = parse_rfc3339_millis(&grant.expires_at).map_err(|_| invalid())?;
            if !id(&configuration.project_id) || !uuid(&configuration.activity_id) || !endpoint(&configuration.endpoint) || grant.version != 1 ||
                grant.transport != "websocket" || grant.protocol != profile().subprotocol || grant.url != configuration.endpoint ||
                grant.project_id != configuration.project_id || grant.activity_id != configuration.activity_id || grant.generation == 0 ||
                grant.token.len() != 43 || !grant.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') ||
                now_ms >= expires || expires - now_ms > profile().maximum_grant_lifetime_ms || expires > MAX_INTEGER ||
                (grant.generation > 1) != configuration.resume.is_some() || configuration.resume.as_ref().is_some_and(|values| !valid_resume(values)) { return Err(invalid()); }
            let mut control = json!({"type":"authenticate","version":1,"projectId":grant.project_id,"activityId":grant.activity_id,"token":grant.token});
            if let Some(resume) = &configuration.resume { control["resume"] = json!(resume); }
            let state = State { version: 1, configuration, generation: grant.generation, grant_deadline: expires, ready: false, closed: false, finishing: false,
                sources: vec![], progress: vec![], target: Target { revision: 0, language: String::new() }, targets: vec![], pending: None,
                playback_held: true, route: "unqualified".into(), outputs: vec![], heard: vec![] };
            json!({"state":state,"url":grant.url,"protocol":grant.protocol,"control":control})
        }
        Command::Ready { mut state, event, now_ms } => {
            state.validate()?;
            if state.ready || now_ms >= state.grant_deadline || event.r#type != "ready" || event.version != 1 || event.activity_id != state.configuration.activity_id ||
                event.generation != state.generation || event.input.format != "pcm_s16le" || event.input.sample_rate != profile().input_sample_rate ||
                event.input.max_frame_samples != profile().maximum_frame_samples || event.playback_route != "unqualified" ||
                state.configuration.resume.as_ref().is_some_and(|resume| resume.len() != event.sources.len() || resume.iter().any(|value|
                    !event.sources.iter().any(|source| source.id == value.source_id && source.start_sample == value.sample))) { return Err(invalid()); }
            state.ready = true; state.target = event.target; state.targets.push(state.target.clone()); state.sources = event.sources;
            state.progress = state.sources.iter().map(|source| Boundary { source_id: source.id.clone(), source_epoch: source.epoch, sequence: 0, sample: source.start_sample }).collect();
            state.validate()?;
            json!({"state":state,"clearPlayback":true})
        }
        Command::BindMicrophone { state, clock_id } => {
            state.active()?;
            if state.finishing || state.pending.is_some() || state.sources.len() != 1 || !uuid(&clock_id) ||
                state.sources[0].role != "mixed" || state.sources[0].speaker != "unknown" ||
                state.sources[0].capture_clock_id.as_deref() != Some(clock_id.as_str()) ||
                state.progress[0].sequence != 0 || state.progress[0].sample != 0 { return Err(invalid()); }
            json!({"state":state})
        }
        Command::Frame { mut state, source_index, first_sample, samples } => {
            state.active()?;
            if state.finishing || state.pending.is_some() || samples == 0 || samples > profile().maximum_frame_samples || source_index >= state.sources.len() { return Err(invalid()); }
            let cursor = &mut state.progress[source_index];
            if cursor.sample != first_sample || first_sample > MAX_INTEGER - u64::from(samples) || cursor.sequence >= MAX_INTEGER { return Err(invalid()); }
            let mut header = vec![0_u8; profile().input_header_bytes];
            header[..4].copy_from_slice(profile().input_magic.as_bytes()); header[4] = source_index as u8;
            header[6..8].copy_from_slice(&(profile().input_header_bytes as u16).to_le_bytes());
            header[8..12].copy_from_slice(&cursor.source_epoch.to_le_bytes()); header[12..16].copy_from_slice(&state.target.revision.to_le_bytes());
            cursor.sequence += 1;
            header[16..24].copy_from_slice(&cursor.sequence.to_le_bytes()); header[24..32].copy_from_slice(&first_sample.to_le_bytes());
            cursor.sample += u64::from(samples);
            json!({"state":state,"header":header})
        }
        Command::Target { mut state, request_id, language: target } => {
            state.active()?;
            if state.finishing || state.pending.is_some() || !id(&request_id) || !language(&target) || state.target.revision >= profile().maximum_target_revision { return Err(invalid()); }
            let change = Pending { request_id, expected_revision: state.target.revision, language: target, boundaries: state.progress.clone() };
            state.pending = Some(change.clone()); state.playback_held = true; state.outputs.clear();
            json!({"state":state,"control":{"type":"target","change":change},"clearPlayback":true})
        }
        Command::TargetCommitted { mut state, request_id, revision, language } => {
            state.active()?;
            let pending = state.pending.as_ref().ok_or_else(invalid)?;
            if pending.request_id != request_id || revision != pending.expected_revision + 1 || pending.language != language { return Err(invalid()); }
            state.target = Target { revision, language }; state.targets.push(state.target.clone()); state.pending = None; state.heard.clear();
            json!({"state":state,"clearPlayback":true})
        }
        Command::PlaybackCleared { mut state, revision } => {
            state.active()?;
            if state.pending.is_some() || revision != state.target.revision { return Err(invalid()); }
            state.playback_held = false;
            json!({"state":state,"control":{"type":"playback_ack","revision":revision}})
        }
        Command::Route { mut state, route } => {
            state.active()?;
            if !["headphones","unqualified"].contains(&route.as_str()) { return Err(invalid()); }
            let clear = route == "unqualified"; if clear { state.outputs.clear(); }
            state.route = route.clone(); json!({"state":state,"control":{"type":"route","route":route},"clearPlayback":clear})
        }
        Command::AudioStart { mut state, activity_id, generation, revision, output_id } => {
            state.active()?;
            let prefix = format!("{}:{}:{}:", state.configuration.activity_id, state.generation, state.target.revision);
            let parts: Vec<_> = output_id.split(':').collect();
            let unit = if parts.len() == 9 && parts[7] == state.target.language && parts[8] == "speech" {
                parts[5].parse::<u32>().ok().zip(parts[6].parse::<u32>().ok()).filter(|(first,last)|
                    *first > 0 && *last >= *first && *last <= 10000 && first.to_string() == parts[5] && last.to_string() == parts[6] &&
                    state.sources.iter().any(|source| source.id == parts[3] && source.epoch.to_string() == parts[4]) &&
                    state.heard.iter().all(|heard| heard.source_id != parts[3] || heard.last_sequence < *first))
            } else { None };
            let accepted = !state.playback_held && state.pending.is_none() && state.route == "headphones" && activity_id == state.configuration.activity_id &&
                generation == state.generation && revision == state.target.revision && output_id.starts_with(&prefix) && output_id.len() <= 256 &&
                state.outputs.len() < 4 && unit.is_some();
            if accepted {
                state.heard.retain(|heard| heard.source_id != parts[3]);
                state.heard.push(Heard { source_id: parts[3].into(), last_sequence: unit.expect("checked unit").1 });
                state.outputs.push(Output { id: output_id, samples: 0 });
            }
            json!({"state":state,"accepted":accepted})
        }
        Command::AudioChunk { mut state, output_id, offset_samples, samples } => {
            state.active()?;
            let output = state.outputs.iter_mut().find(|output| output.id == output_id);
            let accepted = !state.playback_held && state.route == "headphones" && output.as_ref().is_some_and(|output|
                output.samples == offset_samples && samples > 0 && samples <= 12000 && offset_samples <= 1_440_000 - u64::from(samples));
            if accepted { output.expect("checked output").samples += u64::from(samples); }
            else { state.outputs.retain(|output| output.id != output_id); }
            json!({"state":state,"accepted":accepted})
        }
        Command::AudioEnd { mut state, output_id, samples } => {
            state.active()?;
            let accepted = state.outputs.iter().any(|output| output.id == output_id && output.samples == samples);
            state.outputs.retain(|output| output.id != output_id); json!({"state":state,"accepted":accepted})
        }
        Command::Caption { state, activity_id, generation, revision, source_id, source_epoch, unit_id, start_sample, end_sample,
            source_language, target_language, text_bytes } => {
            state.active()?;
            let target = state.targets.iter().find(|target| target.revision == revision);
            let source = state.sources.iter().find(|source| source.id == source_id && source.epoch == source_epoch);
            let prefix = format!("{}:{}:{}:{}:{}:", state.configuration.activity_id, state.generation, revision, source_id, source_epoch);
            let accepted = activity_id == state.configuration.activity_id && generation == state.generation && target.is_some() &&
                source.is_some_and(|source| source.language == source_language && start_sample >= source.start_sample) &&
                start_sample <= end_sample && end_sample <= MAX_INTEGER && text_bytes > 0 && text_bytes <= 16384 &&
                unit_id.starts_with(&prefix) && unit_id.len() <= 256 && target_language.is_none_or(|language| target.is_some_and(|target| target.language == language));
            json!({"state":state,"accepted":accepted})
        }
        Command::Clear { mut state } => { state.active()?; state.outputs.clear(); json!({"state":state,"clearPlayback":true}) }
        Command::Finish { mut state } => {
            state.active()?; if state.pending.is_some() || state.finishing { return Err(invalid()); }
            state.finishing = true; json!({"state":state,"control":{"type":"finish"}})
        }
        Command::Close { mut state } => { state.outputs.clear(); state.closed = true; json!({"state":state,"clearPlayback":true}) }
    };
    serde_json::to_string(&result).map_err(|_| invalid())
}
