//! Metadata-only policy for independent host capture. Native/browser IO owns
//! PCM, AEAD, atomic encrypted storage and HTTP. No audio or key enters this ABI.
use super::{Result, invalid};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    maximum_chunk_samples: u64,
    maximum_capture_samples: u64,
    maximum_chunks: u32,
    maximum_clocks: usize,
    chunk_aad_prefix: String,
    manifest_aad_prefix: String,
    journal_aad_prefix: String,
}
fn profile() -> &'static Profile {
    static PROFILE: OnceLock<Profile> = OnceLock::new();
    PROFILE.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../protocol/manifest/speech-capture-v1.json"
        ))
        .expect("checked capture profile")
    })
}
fn uuid(value: &str) -> Result<Vec<u8>> {
    if !super::uuid(value) || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(invalid());
    }
    let compact = value.replace('-', "");
    (0..32)
        .step_by(2)
        .map(|index| u8::from_str_radix(&compact[index..index + 2], 16).map_err(|_| invalid()))
        .collect()
}
fn digest(value: &str) -> Result<Vec<u8>> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    (0..64)
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| invalid()))
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn manifest_aad(capture_id: &str) -> Result<Vec<u8>> {
    let mut bytes = profile().manifest_aad_prefix.as_bytes().to_vec();
    bytes.extend(uuid(capture_id)?);
    Ok(bytes)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Clock {
    id: String,
    samples: u64,
    end_known: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    protocol_version: u8,
    capture_id: String,
    recording_id: String,
    archive_samples: u64,
    next_sequence: u32,
    chain_sha256: String,
    clocks: Vec<Clock>,
    active_clock: bool,
    finished: bool,
}
impl State {
    fn validate(&self) -> Result<()> {
        uuid(&self.capture_id)?;
        digest(&self.chain_sha256)?;
        let limits = profile();
        if self.protocol_version != 1
            || !self.recording_id.starts_with("rec_")
            || self.recording_id.len() > 255
            || self.recording_id.len() <= 4
            || !self
                .recording_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || self.archive_samples > limits.maximum_capture_samples
            || self.next_sequence > limits.maximum_chunks
            || self.clocks.len() > limits.maximum_clocks
            || self.active_clock && (self.clocks.is_empty() || self.finished)
            || self.archive_samples < u64::from(self.next_sequence)
        {
            return Err(invalid());
        }
        let mut samples = 0_u64;
        for (index, clock) in self.clocks.iter().enumerate() {
            uuid(&clock.id)?;
            if clock.samples > limits.maximum_capture_samples
                || self.clocks[..index]
                    .iter()
                    .any(|previous| previous.id == clock.id)
            {
                return Err(invalid());
            }
            samples = samples.checked_add(clock.samples).ok_or_else(invalid)?;
        }
        if samples > limits.maximum_capture_samples
            || samples < self.archive_samples
            || self.next_sequence == 0
                && (self.archive_samples != 0
                    || self.chain_sha256 != hex(&Sha256::digest(manifest_aad(&self.capture_id)?)))
            || self.active_clock && self.clocks.last().is_some_and(|clock| clock.end_known)
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn active(&self) -> Result<&Clock> {
        if !self.active_clock || self.finished {
            return Err(invalid());
        }
        self.clocks.last().ok_or_else(invalid)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    sequence: u32,
    clock_id: String,
    first_sample: u64,
    samples: u64,
    archive_sample: u64,
}
fn header_aad(capture_id: &str, header: &Header) -> Result<Vec<u8>> {
    let limits = profile();
    if header.sequence >= limits.maximum_chunks
        || header.samples == 0
        || header.samples > limits.maximum_chunk_samples
        || header.first_sample
            > limits
                .maximum_capture_samples
                .saturating_sub(header.samples)
        || header.archive_sample
            > limits
                .maximum_capture_samples
                .saturating_sub(header.samples)
    {
        return Err(invalid());
    }
    let mut bytes = limits.chunk_aad_prefix.as_bytes().to_vec();
    bytes.extend(uuid(capture_id)?);
    bytes.extend(uuid(&header.clock_id)?);
    bytes.extend(header.sequence.to_be_bytes());
    bytes.extend(header.first_sample.to_be_bytes());
    bytes.extend((header.samples as u32).to_be_bytes());
    bytes.extend(header.archive_sample.to_be_bytes());
    Ok(bytes)
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Create {
        capture_id: String,
        recording_id: String,
        retention: String,
    },
    Restore {
        state: State,
    },
    BeginClock {
        state: State,
        clock_id: String,
    },
    Plan {
        state: State,
        first_sample: u64,
        samples: u64,
    },
    Commit {
        state: State,
        header: Header,
        sha256: String,
    },
    EndClock {
        state: State,
        samples: u64,
    },
    Recover {
        state: State,
    },
    Finish {
        state: State,
    },
    Aad {
        capture_id: String,
        kind: String,
    },
    Receipt {
        state: State,
        manifest_sha256: String,
        receipt: Value,
    },
}
fn value<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| invalid())
}

/// A state is authenticated by the host's encrypted journal before Restore.
/// Commit follows the same atomic durable transaction as its ciphertext chunk.
pub fn dispatch_json(input: &str) -> Result<String> {
    if input.len() > 65536 {
        return Err(invalid());
    }
    let request: Request = serde_json::from_str(input).map_err(|_| invalid())?;
    let output = match request {
        Request::Create {
            capture_id,
            recording_id,
            retention,
        } => {
            if retention != "original_audio_and_text" {
                return Err(invalid());
            }
            let chain_sha256 = hex(&Sha256::digest(manifest_aad(&capture_id)?));
            let state = State {
                protocol_version: 1,
                capture_id,
                recording_id,
                archive_samples: 0,
                next_sequence: 0,
                chain_sha256,
                clocks: vec![],
                active_clock: false,
                finished: false,
            };
            state.validate()?;
            value(state)?
        }
        Request::Restore { state } => {
            state.validate()?;
            value(state)?
        }
        Request::BeginClock {
            mut state,
            clock_id,
        } => {
            state.validate()?;
            uuid(&clock_id)?;
            if state.active_clock
                || state.finished
                || state.clocks.len() >= profile().maximum_clocks
                || state.clocks.iter().any(|clock| clock.id == clock_id)
            {
                return Err(invalid());
            }
            state.clocks.push(Clock {
                id: clock_id,
                samples: 0,
                end_known: false,
            });
            state.active_clock = true;
            value(state)?
        }
        Request::Plan {
            state,
            first_sample,
            samples,
        } => {
            state.validate()?;
            let clock = state.active()?;
            if first_sample < clock.samples {
                return Err(invalid());
            }
            let header = Header {
                sequence: state.next_sequence,
                clock_id: clock.id.clone(),
                first_sample,
                samples,
                archive_sample: state.archive_samples,
            };
            let aad = header_aad(&state.capture_id, &header)?;
            if state.clocks.iter().map(|clock| clock.samples).sum::<u64>() - clock.samples
                + first_sample
                + samples
                > profile().maximum_capture_samples
            {
                return Err(invalid());
            }
            json!({ "header":header, "aad":STANDARD.encode(aad) })
        }
        Request::Commit {
            mut state,
            header,
            sha256,
        } => {
            state.validate()?;
            let clock = state.active()?;
            header_aad(&state.capture_id, &header)?;
            if header.sequence != state.next_sequence
                || header.archive_sample != state.archive_samples
                || header.clock_id != clock.id
                || header.first_sample < clock.samples
            {
                return Err(invalid());
            }
            let mut hash = Sha256::new();
            hash.update(digest(&state.chain_sha256)?);
            hash.update(digest(&sha256)?);
            state.chain_sha256 = hex(&hash.finalize());
            state.next_sequence += 1;
            state.archive_samples += header.samples;
            state.clocks.last_mut().ok_or_else(invalid)?.samples =
                header.first_sample + header.samples;
            state.validate()?;
            value(state)?
        }
        Request::EndClock { mut state, samples } => {
            state.validate()?;
            if samples < state.active()?.samples || samples > profile().maximum_capture_samples {
                return Err(invalid());
            }
            let clock = state.clocks.last_mut().ok_or_else(invalid)?;
            clock.samples = samples;
            clock.end_known = true;
            state.active_clock = false;
            state.validate()?;
            value(state)?
        }
        Request::Recover { mut state } => {
            state.validate()?;
            // A crash cannot prove the last captured sample. Preserve the last
            // committed position and report its unknown tail, never an EOF.
            state.active_clock = false;
            value(state)?
        }
        Request::Finish { mut state } => {
            state.validate()?;
            if state.active_clock {
                return Err(invalid());
            }
            state.finished = true;
            json!({"manifest": {"protocolVersion":1,"captureId":state.capture_id,"totalChunks":state.next_sequence,
                "archiveSamples":state.archive_samples,"chainSha256":state.chain_sha256,"clocks":state.clocks},
                "aad":STANDARD.encode(manifest_aad(&state.capture_id)?),"state":state})
        }
        Request::Aad { capture_id, kind } => {
            let mut bytes = match kind.as_str() {
                "manifest" => profile().manifest_aad_prefix.as_bytes().to_vec(),
                "journal" => profile().journal_aad_prefix.as_bytes().to_vec(),
                _ => return Err(invalid()),
            };
            bytes.extend(uuid(&capture_id)?);
            json!({"aad":STANDARD.encode(bytes)})
        }
        Request::Receipt {
            state,
            manifest_sha256,
            receipt,
        } => {
            state.validate()?;
            digest(&manifest_sha256)?;
            let record = receipt.as_object().ok_or_else(invalid)?;
            if !state.finished
                || record.get("profile").and_then(Value::as_str) != Some("speech_capture_pcm_v1")
                || record.get("capture_id").and_then(Value::as_str) != Some(&state.capture_id)
                || record.get("recording_id").and_then(Value::as_str) != Some(&state.recording_id)
                || record.get("state").and_then(Value::as_str) != Some("published")
                || record.get("audio_verification").and_then(Value::as_str) != Some("verified")
                || record.get("manifest_sha256").and_then(Value::as_str) != Some(&manifest_sha256)
                || record.get("archive_samples").and_then(Value::as_u64)
                    != Some(state.archive_samples)
            {
                return Err(invalid());
            }
            digest(
                record
                    .get("content_sha256")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?,
            )?;
            json!({"canDelete":true})
        }
    };
    serde_json::to_string(&output).map_err(|_| invalid())
}
