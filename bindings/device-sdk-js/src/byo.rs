//! Generated-JS BYO orchestration. Hosts execute effects; Rust chooses the route,
//! retries, immutable identity, durable recovery and receipt-gated cleanup.
use crate::{
    codecs::{input, output, public_output},
    engine::invalid,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bota_device_sdk_core::{
    error::DeviceSdkError, generated::protocol as wire, model::*, protocol::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ByoInput {
    operation_id: String,
    mode: String,
    device: Value,
    recording: Option<Recording>,
    scope: Scope,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Recording {
    uuid: String,
    generation: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    base_url: String,
    scope_key: String,
    organization_id: String,
    project_id: String,
    environment: String,
    device_id: String,
    binding_generation: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Machine {
    input: ByoInput,
    stage: String,
    next: String,
    recording: Option<Recording>,
    docs: Value,
    stream: bool,
    capabilities: Value,
    facts: Value,
    context: Value,
    authorization: Value,
    status: Value,
    upload: Value,
    manifest: Value,
    recovery: Option<ByoRecovery>,
    identity_key: String,
    load_key: String,
    offset: u32,
    index: u32,
    chunk_count: u32,
    bytes: Vec<u8>,
    segment: Value,
    source_length: u32,
    source_hash: String,
    hash_state: Vec<u8>,
    cursor: u32,
    pages: u32,
    catalog: Vec<Recording>,
    transport: String,
    fallback: bool,
    started: u64,
    refreshed: u64,
    polls: u32,
    http_attempt: u8,
    retry_action: Value,
    renew_after: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Advance {
    state: Machine,
    event: Value,
    now_ms: u64,
    random_uuid: String,
}

fn fail(detail: &str) -> DeviceSdkError {
    invalid(detail)
}
fn object(v: &Value) -> Result<&serde_json::Map<String, Value>, DeviceSdkError> {
    v.as_object()
        .ok_or_else(|| fail("BYO document must be an object"))
}
fn text(v: &Value, key: &str) -> Result<String, DeviceSdkError> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| fail("missing BYO text field"))
}
fn number(v: &Value, key: &str) -> Result<u32, DeviceSdkError> {
    v.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| fail("invalid BYO integer"))
}
fn boolean(v: &Value, key: &str) -> Result<bool, DeviceSdkError> {
    v.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| fail("invalid BYO boolean"))
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
fn sha(v: &[u8]) -> String {
    Sha256::digest(v)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn bytes(v: &Value) -> Result<Vec<u8>, DeviceSdkError> {
    input(v.clone())
}
fn safe_json(value: &Value) -> Result<(), DeviceSdkError> {
    match value {
        Value::Number(number) => {
            let safe = if let Some(n) = number.as_u64() {
                n <= 9_007_199_254_740_991
            } else if let Some(n) = number.as_i64() {
                n.unsigned_abs() <= 9_007_199_254_740_991
            } else {
                number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.0)
            };
            if !safe {
                return Err(fail("BYO JSON number exceeds exact JavaScript range"));
            }
        }
        Value::Array(items) => {
            for item in items {
                safe_json(item)?;
            }
        }
        Value::Object(fields) => {
            for value in fields.values() {
                safe_json(value)?;
            }
        }
        _ => (),
    }
    Ok(())
}
fn json_bytes(v: &Value) -> Result<Vec<u8>, DeviceSdkError> {
    safe_json(v)?;
    let b = serde_json::to_vec(v).map_err(|_| fail("invalid BYO JSON"))?;
    if b.len() > 32768 {
        return Err(fail("BYO JSON exceeds bound"));
    }
    Ok(b)
}
fn parse(v: &Value) -> Result<Value, DeviceSdkError> {
    let raw = bytes(v)?;
    if raw.len() > 32768 {
        return Err(fail("BYO document exceeds bound"));
    }
    let v: Value = serde_json::from_slice(&raw).map_err(|_| fail("invalid BYO JSON"))?;
    object(&v)?;
    Ok(v)
}
fn data(v: &Value) -> Result<Value, DeviceSdkError> {
    let v = parse(v)?;
    let result = v
        .get("data")
        .cloned()
        .ok_or_else(|| fail("missing BYO response data"))?;
    object(&result)?;
    Ok(result)
}
fn identity(recording: &Recording) -> Result<Vec<u8>, DeviceSdkError> {
    if !uuid(&recording.uuid) {
        return Err(fail("invalid BYO UUID"));
    }
    let hex = recording.uuid.replace('-', "");
    let mut result = (0..32)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| fail("invalid BYO UUID")))
        .collect::<Result<Vec<_>, _>>()?;
    result.extend_from_slice(&recording.generation.to_le_bytes());
    Ok(result)
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

impl Machine {
    fn new(input: ByoInput, now: u64) -> Result<Self, DeviceSdkError> {
        let s = &input.scope;
        if !input.operation_id.starts_with("byo-")
            || input.operation_id.len() > 64
            || !["list", "sync", "stream"].contains(&input.mode.as_str())
            || (input.mode == "sync" && input.recording.is_none())
            || s.binding_generation == 0
            || s.scope_key.is_empty()
            || s.scope_key.len() > 512
            || !["development", "gamma", "production"].contains(&s.environment.as_str())
            || ![&s.organization_id, &s.project_id, &s.device_id]
                .iter()
                .all(|v| id(v))
            || !s.base_url.starts_with("https://")
            || s.base_url.len() > 8192
            || s.base_url.contains(['?', '#', '@', '\r', '\n'])
            || text(&input.device, "connectionState")? != "connected"
            || text(&input.device, "serialNumber")?.is_empty()
            || !(23..=517).contains(&number(&input.device, "mtu")?)
            || now > 9_007_199_254_740_991
        {
            return Err(fail("invalid BYO configuration"));
        }
        if input.recording.as_ref().is_some_and(|r| !uuid(&r.uuid)) {
            return Err(fail("invalid BYO recording"));
        }
        let recording = input.recording.clone();
        Ok(Self {
            input,
            stage: "refresh_initial".into(),
            next: String::new(),
            recording,
            docs: json!({}),
            stream: false,
            capabilities: Value::Null,
            facts: Value::Null,
            context: Value::Null,
            authorization: Value::Null,
            status: Value::Null,
            upload: Value::Null,
            manifest: Value::Null,
            recovery: None,
            identity_key: String::new(),
            load_key: String::new(),
            offset: 0,
            index: 0,
            chunk_count: 0,
            bytes: vec![],
            segment: Value::Null,
            source_length: 0,
            source_hash: String::new(),
            hash_state: vec![],
            cursor: 0,
            pages: 0,
            catalog: vec![],
            transport: String::new(),
            fallback: false,
            started: now,
            refreshed: now,
            polls: 0,
            http_attempt: 0,
            retry_action: Value::Null,
            renew_after: String::new(),
        })
    }
    fn reply(self, action: Value) -> Result<Vec<u8>, DeviceSdkError> {
        let reply = json!({"state":self,"action":action});
        safe_json(&reply)?;
        public_output(reply)
    }
    fn action(&self, kind: &str) -> Value {
        json!({"kind":kind})
    }
    fn ble(&self, op: u8, bytes: Vec<u8>) -> Value {
        json!({"kind":"ble","operation":op,"bytes":bytes})
    }
    fn http(&self, route: &str, suffix: String, body: Option<Value>, retain: bool) -> Value {
        json!({"kind":"http","route":route,"suffix":suffix,"body":body,"drain":retain})
    }
    fn endpoint(&self) -> Result<String, DeviceSdkError> {
        let id = text(&self.context, "upload_session_id")?;
        if !uuid(&id) {
            return Err(fail("invalid BYO session"));
        }
        Ok(format!("/{id}"))
    }
    fn recording(&self) -> Result<&Recording, DeviceSdkError> {
        self.recording
            .as_ref()
            .ok_or_else(|| fail("missing BYO recording"))
    }
    fn recording_identity(&self) -> Result<Vec<u8>, DeviceSdkError> {
        identity(self.recording()?)
    }
    fn scope(&self, context: &Value) -> Result<(), DeviceSdkError> {
        let s = &self.input.scope;
        let r = self.recording()?;
        if text(context, "organization_id")? != s.organization_id
            || text(context, "project_id")? != s.project_id
            || text(context, "device_id")? != s.device_id
            || text(context, "environment")? != s.environment
            || number(context, "binding_generation")? != s.binding_generation
            || text(context, "recording_uuid")? != r.uuid
            || number(context, "recording_generation")? != r.generation
            || text(context, "channel")? != "ble"
            || !uuid(&text(context, "upload_session_id")?)
        {
            return Err(fail("BYO identity conflict"));
        }
        Ok(())
    }
    fn capture(&self) -> Result<ByoCapture, DeviceSdkError> {
        let s = &self.input.scope;
        let r = self.recording()?;
        Ok(ByoCapture {
            environment: match s.environment.as_str() {
                "development" => ByoEnvironment::Development,
                "gamma" => ByoEnvironment::Gamma,
                _ => ByoEnvironment::Production,
            },
            organization_id: s.organization_id.clone(),
            project_id: s.project_id.clone(),
            device_id: s.device_id.clone(),
            binding_generation: s.binding_generation,
            device_assignment_generation: number(&self.context, "device_assignment_generation")?,
            policy_revision: text(&self.context, "policy_revision")?,
            recording_uuid: r.uuid.clone(),
            recording_generation: r.generation,
        })
    }
    fn route(&self, context: &Value, authorization: &Value) -> Result<ByoRoute, DeviceSdkError> {
        self.scope(context)?;
        Ok(ByoRoute {
            recording_id: text(context, "recording_id")?,
            configuration_id: text(context, "configuration_id")?,
            configuration_revision: number(context, "configuration_revision")?,
            configuration_sha256: text(authorization, "configuration_sha256")?,
            destination_ref: text(context, "destination_ref")?,
            session_id: text(context, "upload_session_id")?,
            owner_revision: number(context, "owner_revision")?,
        })
    }
    fn advance_recovery(
        &mut self,
        event: ByoRecoveryEvent,
    ) -> Result<ByoRecoveryReply, DeviceSdkError> {
        let reply = ByoRecoveryRequest {
            checkpoint: self.recovery.clone(),
            current_capture: self.capture()?,
            event,
        }
        .reduce()
        .map_err(|_| fail("BYO recovery transition rejected"))?;
        self.recovery = Some(reply.checkpoint.clone());
        self.docs["recovery"] =
            serde_json::to_value(&self.recovery).map_err(|_| fail("invalid BYO recovery"))?;
        Ok(reply)
    }
    fn phase(&self) -> Option<ByoPhase> {
        self.recovery.as_ref().map(|r| r.phase)
    }
    fn save(mut self, next: &str) -> Result<Vec<u8>, DeviceSdkError> {
        self.stage = "saved".into();
        self.next = next.into();
        let action = json!({"kind":"save","key":self.load_key,"value":self.docs});
        self.reply(action)
    }
    fn start_load(mut self, stream: bool) -> Result<Vec<u8>, DeviceSdkError> {
        self.stream = stream;
        let r = self.recording()?;
        let s = &self.input.scope;
        self.identity_key = sha(&json_bytes(
            &json!({"scope":s.scope_key,"organization":s.organization_id,"project":s.project_id,"device":s.device_id,"binding":s.binding_generation,"environment":s.environment,"origin":s.base_url,"recording":r.uuid,"generation":r.generation}),
        )?);
        self.load_key = format!(
            "byo/{}/{}/documents",
            if stream { "stream" } else { "batch" },
            self.identity_key
        );
        self.stage = "loaded".into();
        let action = json!({"kind":"load","key":self.load_key,"live":stream});
        self.reply(action)
    }
    fn run(mut self) -> Result<Vec<u8>, DeviceSdkError> {
        let action = match self.stage.as_str() {
            "refresh_initial" | "refresh_periodic" | "refresh_open" | "refresh_receipt" => {
                self.action("refresh")
            }
            "capabilities" => self.ble(wire::BYO_BLE_CAPABILITIES, vec![]),
            "discover" => self.ble(wire::BYO_BLE_LIVE_SNAPSHOT, vec![]),
            "inspect_live" => self.ble(wire::BYO_BLE_LIVE_SNAPSHOT, self.recording_identity()?),
            "selection" => {
                let mut caps = self.capabilities.clone();
                caps["upload_modes"] = if self.stream {
                    json!(["whole_file", "http_segments", "ws_relay"])
                } else {
                    json!(["whole_file"])
                };
                caps["durable_source"] = json!(true);
                caps["durable_receipt"] = json!(true);
                self.http("batch", "/capabilities".into(), Some(caps), false)
            }
            "select_source" => {
                let mut id = self.recording_identity()?;
                id.push(1);
                self.ble(
                    if self.stream {
                        wire::BYO_BLE_LIVE_SNAPSHOT
                    } else {
                        wire::BYO_BLE_INSPECT
                    },
                    id,
                )
            }
            "create_context" => {
                let body = self
                    .docs
                    .get("create_request")
                    .cloned()
                    .ok_or_else(|| fail("missing durable BYO CREATE request"))?;
                self.http(
                    if self.stream { "stream" } else { "batch" },
                    "".into(),
                    Some(body),
                    true,
                )
            }
            "prepare" => self.http(
                "batch",
                format!("{}/prepare", self.endpoint()?),
                Some(json!({})),
                false,
            ),
            "upload" => self.http(
                "batch",
                format!("{}/upload", self.endpoint()?),
                Some(json!({})),
                false,
            ),
            "renew" => {
                let body = self
                    .docs
                    .get("renewal")
                    .cloned()
                    .ok_or_else(|| fail("missing durable BYO renewal"))?;
                self.http(
                    "batch",
                    format!("{}/recover", self.endpoint()?),
                    Some(body),
                    true,
                )
            }
            "open" => {
                let mut bundle = json!({"context":self.context,"authorization":self.authorization});
                if let Some(receipt) = self.status.get("receipt").filter(|r| r.is_object()) {
                    bundle["receipt"] = receipt.clone();
                    if let Some(permit) = self.status.get("recovery").and_then(|r| r.get("permit"))
                    {
                        bundle["recovery"] = permit.clone();
                    }
                } else if let Some(recovery) = self.upload.get("recovery") {
                    bundle["recovery"] = recovery.clone();
                }
                self.ble(wire::BYO_BLE_OPEN, json_bytes(&bundle)?)
            }
            "file_start" => {
                json!({"kind":"file_start","key":format!("byo/{}/ciphertext",self.identity_key)})
            }
            "download" => {
                let remaining = self
                    .source_length
                    .checked_sub(self.offset)
                    .ok_or_else(|| fail("invalid BYO offset"))?;
                self.chunk_count = remaining.min(4096);
                let mut body = self.offset.to_le_bytes().to_vec();
                body.extend_from_slice(&[0; 4]);
                body.extend_from_slice(&(self.chunk_count as u16).to_le_bytes());
                self.ble(wire::BYO_BLE_READ, body)
            }
            "append" => {
                json!({"kind":"file_append","offset":self.offset.to_string(),"bytes":self.bytes})
            }
            "file_finish" => {
                json!({"kind":"file_finish","length":self.source_length.to_string(),"sha256":self.source_hash})
            }
            "put" => {
                json!({"kind":"put","target":self.upload.get("upload").cloned().ok_or_else(||fail("missing BYO upload instructions"))?})
            }
            "complete" => self.http(
                "batch",
                format!("{}/complete", self.endpoint()?),
                Some(json!({"manifest":self.manifest})),
                true,
            ),
            "complete_wait" => json!({"kind":"wait","milliseconds":5000}),
            "receipt" => {
                let mut bundle = json!({"receipt":self.docs["receipt"]});
                if let Some(permit) = self.status.get("recovery").and_then(|r| r.get("permit")) {
                    bundle["recovery"] = permit.clone();
                }
                self.ble(wire::BYO_BLE_RECEIPT, json_bytes(&bundle)?)
            }
            "confirm" => self.ble(wire::BYO_BLE_CONFIRM, self.bytes.clone()),
            "missing_status" => self.http("batch", self.endpoint()?, None, false),
            "remove_file" => {
                json!({"kind":"file_remove","key":format!("byo/{}/ciphertext",self.identity_key)})
            }
            "result" => {
                json!({"kind":"result","value":{"recordingId":text(&self.context,"recording_id")?,"uploadSessionId":text(&self.context,"upload_session_id")?}})
            }
            "catalog" => self.ble(wire::BYO_BLE_LIST, self.cursor.to_le_bytes().to_vec()),
            "catalog_result" => json!({"kind":"result","value":self.catalog}),
            "live_context" => {
                let mut body = self.recording_identity()?;
                body.extend_from_slice(&json_bytes(&self.context)?);
                self.ble(wire::BYO_BLE_LIVE_CONTEXT, body)
            }
            "socket_open" => {
                json!({"kind":"socket_open","session":text(&self.context,"upload_session_id")?})
            }
            "socket_close" => self.action("socket_close"),
            "stream_snapshot" => self.ble(wire::BYO_BLE_LIVE_SNAPSHOT, self.recording_identity()?),
            "live_read" => {
                let mut body = self.recording_identity()?;
                body.extend_from_slice(&(self.offset + self.bytes.len() as u32).to_le_bytes());
                body.extend_from_slice(
                    &((self.chunk_count - self.bytes.len() as u32).min(4096) as u16).to_le_bytes(),
                );
                self.ble(wire::BYO_BLE_LIVE_READ, body)
            }
            "socket_exchange" => {
                json!({"kind":"socket_exchange","segment":self.segment,"bytes":self.bytes,"session":text(&self.context,"upload_session_id")?})
            }
            "segment_grant" => self.http(
                "stream",
                format!("{}/grants", self.endpoint()?),
                Some(self.segment.clone()),
                false,
            ),
            "segment_file" => {
                json!({"kind":"file_start","key":format!("byo/{}/segment",self.identity_key)})
            }
            "segment_append" => json!({"kind":"file_append","offset":"0","bytes":self.bytes}),
            "segment_flush" => {
                json!({"kind":"file_finish","length":self.bytes.len().to_string(),"sha256":sha(&self.bytes)})
            }
            "segment_put" => json!({"kind":"put","target":self.upload}),
            "segment_confirm" => self.http(
                "stream",
                format!("{}/confirm", self.endpoint()?),
                Some(self.segment.clone()),
                true,
            ),
            "live_ack" => {
                let mut body = self.recording_identity()?;
                body.extend_from_slice(&self.offset.to_le_bytes());
                self.ble(wire::BYO_BLE_LIVE_ACK, body)
            }
            "live_wait" => json!({"kind":"wait","milliseconds":100}),
            "socket_backoff" => {
                json!({"kind":"wait","milliseconds":self.retry_action["milliseconds"]})
            }
            "stream_status" => self.http("stream", self.endpoint()?, None, false),
            "stream_renew" => self.http(
                "stream",
                format!("{}/recover", self.endpoint()?),
                Some(self.docs["renewal"].clone()),
                true,
            ),
            "handoff" => self.http(
                "stream",
                format!("{}/handoff", self.endpoint()?),
                Some(self.docs["handoff"].clone()),
                true,
            ),
            "live_successor" => {
                let mut body = self.recording_identity()?;
                body.extend_from_slice(&json_bytes(&self.docs["successor"])?);
                self.ble(wire::BYO_BLE_LIVE_SUCCESSOR, body)
            }
            _ => return Err(fail("invalid BYO state")),
        };
        self.reply(action)
    }
    fn goto(mut self, stage: &str) -> Result<Vec<u8>, DeviceSdkError> {
        self.stage = stage.into();
        self.run()
    }
    fn renewable(mut self, after: &str, random: &str) -> Result<Vec<u8>, DeviceSdkError> {
        let state = self
            .recovery
            .as_ref()
            .ok_or_else(|| fail("BYO renewal without state"))?;
        if state.renewal_operation.is_none() {
            let revision = state.renewal_revision;
            self.advance_recovery(ByoRecoveryEvent::BeginRenewal {
                operation: random.into(),
                expected_revision: revision,
            })?;
        }
        let state = self.recovery.as_ref().unwrap();
        self.docs["renewal"] = json!({"operation_id":state.renewal_operation,"expected_revision":state.renewal_revision});
        self.renew_after = after.into();
        self.save("renew")
    }
    fn context_ready(mut self) -> Result<Vec<u8>, DeviceSdkError> {
        self.scope(&self.context)?;
        self.docs["context"] = self.context.clone();
        if self.stream {
            return self.save("live_context");
        }
        if number(&self.context, "ciphertext_length")? != self.source_length
            || text(&self.context, "ciphertext_sha256")? != self.source_hash
        {
            return Err(fail("BYO ciphertext identity conflict"));
        }
        if self.recovery.is_none() {
            self.advance_recovery(ByoRecoveryEvent::Create)?;
        } else {
            self.advance_recovery(ByoRecoveryEvent::Restart)?;
        }
        if self.phase() == Some(ByoPhase::Complete) {
            return self.goto("result");
        }
        self.advance_recovery(ByoRecoveryEvent::SourceFinalized {
            bytes: u64::from(self.source_length),
            sha256: self.source_hash.clone(),
        })?;
        self.save("prepare")
    }
    fn verified_status(mut self, status: Value) -> Result<Vec<u8>, DeviceSdkError> {
        self.status = status;
        if let Some(receipt) = self
            .status
            .get("receipt")
            .filter(|v| v.is_object())
            .cloned()
        {
            if let Some(previous) = self.docs.get("receipt").filter(|v| v.is_object())
                && previous != &receipt
            {
                return Err(fail("BYO receipt changed"));
            }
            self.docs["receipt"] = receipt;
            return self.save("refresh_receipt");
        }
        if self
            .status
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|s| ["failed", "blocked"].contains(&s))
        {
            return Err(fail("BYO verification rejected"));
        }
        if self.polls >= 24 {
            return Err(fail("BYO verification pending"));
        }
        self.polls += 1;
        self.goto("complete_wait")
    }
    fn segment_accepted(mut self) -> Result<Vec<u8>, DeviceSdkError> {
        self.offset = self
            .offset
            .checked_add(self.chunk_count)
            .ok_or_else(|| fail("BYO offset overflow"))?;
        self.index += 1;
        self.bytes.clear();
        self.goto("live_ack")
    }
    fn fallback(mut self) -> Result<Vec<u8>, DeviceSdkError> {
        self.fallback = true;
        self.docs["fallback"] = json!(true);
        self.save("socket_close")
    }
    fn consume(mut self, event: Value, now: u64, random: &str) -> Result<Vec<u8>, DeviceSdkError> {
        if now < self.started || now > 9_007_199_254_740_991 {
            return Err(fail("BYO clock is outside its exact range"));
        }
        if let Some(error) = event.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if code == "operation_cancelled" {
                return Err(fail("BYO upload cancelled"));
            }
            if self.stage == "socket_open" && self.transport.is_empty() {
                self.transport = "http".into();
                self.docs["transport"] = json!("http");
                return self.save("stream_snapshot");
            }
            if ["socket_exchange", "socket_open"].contains(&self.stage.as_str())
                && self.transport == "ws"
            {
                let retries = self
                    .docs
                    .get("reconnects")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if retries < 3 {
                    self.docs["reconnects"] = json!(retries + 1);
                    self.retry_action = json!({"milliseconds":1000_u64<<retries});
                    return self.save("socket_backoff");
                }
                return self.fallback();
            }
            if [
                "live_read",
                "segment_grant",
                "segment_put",
                "segment_confirm",
            ]
            .contains(&self.stage.as_str())
            {
                return self.fallback();
            }
            if code == "context_expired" && self.stage != "refresh_initial" {
                self.next = self.stage.clone();
                return self.goto("refresh_periodic");
            }
            if code == "device_rejected"
                && self.stage == "inspect_live"
                && self.input.mode == "sync"
            {
                return self.start_load(false);
            }
            if code == "expired" && self.stage == "upload" {
                return self.renewable("upload", random);
            }
            if code == "device_rejected"
                && self.stage == "open"
                && self.docs.get("open_renewed") != Some(&json!(true))
            {
                self.docs["open_renewed"] = json!(true);
                return self.renewable("upload", random);
            }
            return Err(fail(&format!("BYO effect failed: {code}")));
        }
        let value = event.get("ok").cloned().unwrap_or(Value::Null);
        match self.stage.as_str() {
            "refresh_initial" => {
                self.refreshed = now;
                if self.input.mode == "list" {
                    self.goto("catalog")
                } else {
                    self.goto("capabilities")
                }
            }
            "refresh_periodic" => {
                self.refreshed = now;
                let next = self.next.clone();
                self.goto(&next)
            }
            "refresh_open" => {
                self.refreshed = now;
                self.goto("open")
            }
            "refresh_receipt" => {
                self.refreshed = now;
                self.goto("receipt")
            }
            "capabilities" => {
                self.capabilities = parse(&value)?;
                if self.recording.is_none() {
                    self.goto("discover")
                } else if self.input.mode == "stream"
                    || self.capabilities["upload_modes"]
                        .as_array()
                        .is_some_and(|m| m.contains(&json!("http_segments")))
                {
                    self.goto("inspect_live")
                } else {
                    self.start_load(false)
                }
            }
            "discover" => {
                let facts = parse(&value)?;
                if boolean(&facts, "closed")? {
                    return Err(fail("no active BYO recording"));
                }
                let r = Recording {
                    uuid: text(&facts, "recording_uuid")?,
                    generation: number(&facts, "recording_generation")?,
                };
                if r.generation == 0 || !uuid(&r.uuid) {
                    return Err(fail("invalid active BYO recording"));
                }
                self.recording = Some(r);
                self.fallback = facts.get("stream_selected") == Some(&json!(true));
                self.start_load(true)
            }
            "inspect_live" => {
                let facts = parse(&value)?;
                let selected = facts.get("stream_selected") == Some(&json!(true));
                self.fallback = selected;
                let stream = selected || self.input.mode == "stream";
                self.start_load(stream)
            }
            "loaded" => {
                self.docs = if value.is_null() {
                    json!({})
                } else {
                    object(&value)?;
                    value
                };
                if self
                    .docs
                    .get("identity")
                    .is_some_and(|v| v != &json!(self.identity_key))
                {
                    return Err(fail("BYO durable scope conflict"));
                }
                self.docs["identity"] = json!(self.identity_key);
                if self.stream && self.docs.get("selected_customer") == Some(&json!(true)) {
                    self.fallback = true;
                }
                self.recovery = match self.docs.get("recovery").filter(|v| !v.is_null()) {
                    Some(v) => Some(input(v.clone())?),
                    None => None,
                };
                if let Some(seed) = self
                    .docs
                    .get("successor")
                    .filter(|v| v.is_object())
                    .cloned()
                {
                    self.context = seed["context"].clone();
                    self.scope(&self.context)?;
                    return self.begin_batch_successor(seed);
                }
                self.goto("selection")
            }
            "saved" => {
                let next = self.next.clone();
                self.goto(&next)
            }
            "selection" => {
                self.status = data(&value)?;
                if self.docs.get("selected_customer") != Some(&json!(true))
                    && self.docs.get("context").is_none()
                    && !self.fallback
                    && self.status["destination"]["kind"] != json!("customer")
                {
                    return self.reply(json!({"kind":"error","code":"not_selected"}));
                }
                if self.stream {
                    let modes = self.capabilities["upload_modes"]
                        .as_array()
                        .ok_or_else(|| fail("invalid BYO upload modes"))?;
                    if !modes.contains(&json!("http_segments")) {
                        return Err(fail("BYO segments unsupported"));
                    }
                    let allowed = self.status["upload_modes"]
                        .as_array()
                        .ok_or_else(|| fail("invalid customer BYO modes"))?;
                    if self.docs.get("selected_customer") != Some(&json!(true))
                        && !self.fallback
                        && (!allowed.contains(&json!("whole_file"))
                            || !allowed.contains(&json!("http_segments")))
                    {
                        return Err(fail("BYO modes not qualified"));
                    }
                }
                self.docs["selected_customer"] = json!(true);
                self.save("select_source")
            }
            "select_source" => {
                self.facts = parse(&value)?;
                if !self.stream && self.facts.get("missing") == Some(&json!(true)) {
                    if self.phase() != Some(ByoPhase::CleanupPending)
                        || !self.docs["receipt"].is_object()
                    {
                        return Err(fail("BYO source missing without cleanup proof"));
                    }
                    self.context = self.docs["context"].clone();
                    self.scope(&self.context)?;
                    return self.goto("missing_status");
                }
                if text(&self.facts, "recording_uuid")? != self.recording()?.uuid
                    || number(&self.facts, "recording_generation")? != self.recording()?.generation
                {
                    return Err(fail("BYO source changed"));
                }
                if !self.stream {
                    self.source_length = number(&self.facts, "ciphertext_length")?;
                    self.source_hash = text(&self.facts, "ciphertext_sha256")?;
                    if !(293..=134217728).contains(&self.source_length)
                        || !digest(&self.source_hash)
                    {
                        return Err(fail("invalid BYO source"));
                    }
                }
                if let Some(context) = self
                    .docs
                    .get("context")
                    .filter(|v| v.is_object())
                    .cloned()
                    .or_else(|| {
                        self.facts
                            .get("stream_context")
                            .filter(|v| v.is_object())
                            .cloned()
                    })
                {
                    self.context = context;
                    return self.context_ready();
                }
                let body = if self.stream {
                    json!({"recording_uuid":self.recording()?.uuid,"recording_generation":self.recording()?.generation,"channel":"ble","source_mode":"durable","limits_profile":"byo-stream-128m-4h-v1"})
                } else {
                    let mut facts = self.facts.clone();
                    facts["channel"] = json!("ble");
                    facts
                };
                if let Some(old) = self.docs.get("create_request")
                    && old != &body
                {
                    return Err(fail("BYO uncertain CREATE changed identity"));
                }
                self.docs["create_request"] = body;
                self.save("create_context")
            }
            "create_context" => {
                let created = data(&value)?;
                self.context = created["context"].clone();
                self.scope(&self.context)?;
                self.docs["context"] = self.context.clone();
                self.docs.as_object_mut().unwrap().remove("create_request");
                self.context_ready()
            }
            "prepare" => {
                self.upload = data(&value)?;
                self.authorization = self.upload["authorization"].clone();
                object(&self.authorization)?;
                self.status = self.upload["status"].clone();
                object(&self.status)?;
                self.docs["authorization"] = self.authorization.clone();
                if self.phase() == Some(ByoPhase::New) {
                    let route = self.route(&self.context, &self.authorization)?;
                    self.advance_recovery(ByoRecoveryEvent::Bind {
                        route,
                        transport: ByoTransport::WholeFile,
                    })?;
                }
                if self
                    .recovery
                    .as_ref()
                    .is_some_and(|r| r.renewal_operation.is_some())
                {
                    return self.renewable("upload", random);
                }
                self.save("upload")
            }
            "renew" => {
                let reply = data(&value)?;
                let op = text(&self.docs["renewal"], "operation_id")?;
                if text(&reply, "operation_id")? != op {
                    return Err(fail("BYO renewal identity mismatch"));
                }
                let rev = number(&reply, "revision")?;
                self.docs["renewal_response"] = reply;
                self.advance_recovery(ByoRecoveryEvent::RenewalCommitted {
                    operation: op,
                    revision: rev,
                })?;
                let next = self.renew_after.clone();
                self.save(&next)
            }
            "upload" => {
                self.upload = data(&value)?;
                self.status = self.upload["status"].clone();
                object(&self.status)?;
                self.goto("refresh_open")
            }
            "open" => {
                let opened = parse(&value)?;
                self.manifest = opened["manifest"].clone();
                object(&self.manifest)?;
                if self
                    .docs
                    .get("manifest")
                    .is_some_and(|m| m != &self.manifest)
                {
                    return Err(fail("BYO accepted manifest changed"));
                }
                self.docs["manifest"] = self.manifest.clone();
                if self.phase() == Some(ByoPhase::HttpWholeFile) {
                    if self.status["receipt"].is_object()
                        || self.docs.get("assembled") == Some(&json!(true))
                        || !self.upload["upload"].is_object()
                    {
                        self.advance_recovery(ByoRecoveryEvent::VerificationPending)?;
                        return self.save("complete");
                    }
                    self.offset = 0;
                    return self.save("file_start");
                }
                if self.status["receipt"].is_object() {
                    let status = self.status.clone();
                    return self.verified_status(status);
                }
                self.save("complete")
            }
            "file_start" => self.goto("download"),
            "download" => {
                self.bytes = bytes(&value)?;
                if self.bytes.len() != self.chunk_count as usize {
                    return Err(fail("BYO range length mismatch"));
                }
                self.goto("append")
            }
            "append" => {
                if value.as_str() != Some(&(self.offset + self.chunk_count).to_string()) {
                    return Err(fail("BYO append not durable"));
                }
                self.offset += self.chunk_count;
                self.bytes.fill(0);
                self.bytes.clear();
                if self.offset == self.source_length {
                    self.goto("file_finish")
                } else if now - self.refreshed >= 30000 {
                    self.next = "download".into();
                    self.goto("refresh_periodic")
                } else {
                    self.goto("download")
                }
            }
            "file_finish" => self.goto("put"),
            "put" => {
                self.advance_recovery(ByoRecoveryEvent::VerificationPending)?;
                self.save("complete")
            }
            "complete" => {
                let status = data(&value)?;
                self.verified_status(status)
            }
            "complete_wait" => self.goto("complete"),
            "receipt" => {
                self.bytes = bytes(&value)?;
                if self.bytes.len() != 32 {
                    return Err(fail("device did not verify BYO receipt"));
                }
                let hash = self
                    .bytes
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                if self
                    .docs
                    .get("receipt_sha256")
                    .is_some_and(|s| s != &json!(hash))
                {
                    return Err(fail("BYO receipt digest conflict"));
                }
                self.docs["receipt_sha256"] = json!(hash);
                if self.phase() == Some(ByoPhase::Verifying) {
                    self.advance_recovery(ByoRecoveryEvent::ReceiptVerified {
                        sha256: hash.clone(),
                    })?;
                }
                self.save("receipt_persisted")
            }
            "confirm" => {
                self.advance_recovery(ByoRecoveryEvent::CleanupFinished)?;
                self.save("remove_file")
            }
            "missing_status" => {
                let status = data(&value)?;
                if status["receipt"] != self.docs["receipt"]
                    || !self
                        .advance_recovery(ByoRecoveryEvent::Inspect)?
                        .may_cleanup
                {
                    return Err(fail("BYO missing-source receipt mismatch"));
                }
                self.advance_recovery(ByoRecoveryEvent::CleanupFinished)?;
                self.save("remove_file")
            }
            "remove_file" => self.goto("result"),
            "catalog" => {
                let reply = parse(&value)?;
                let next = number(&reply, "next")?;
                self.pages += 1;
                if let Some(entry) = reply.get("recording").filter(|v| !v.is_null()) {
                    let r = Recording {
                        uuid: text(entry, "recording_uuid")?,
                        generation: number(entry, "recording_generation")?,
                    };
                    if !uuid(&r.uuid) {
                        return Err(fail("invalid BYO catalog identity"));
                    }
                    if !self.catalog.contains(&r) {
                        if self.catalog.len() >= 4096 {
                            return Err(fail("BYO catalog exceeds bound"));
                        }
                        self.catalog.push(r);
                    }
                }
                if next == 0 {
                    return self.goto("catalog_result");
                }
                if next <= self.cursor || self.pages >= 4097 {
                    return Err(fail("BYO catalog cursor did not advance"));
                }
                self.cursor = next;
                if now - self.refreshed >= 30000 {
                    self.next = "catalog".into();
                    self.goto("refresh_periodic")
                } else {
                    self.goto("catalog")
                }
            }
            "live_context" => {
                self.fallback |= self.docs.get("fallback") == Some(&json!(true))
                    || self.docs.get("transport").is_some();
                if self.fallback {
                    return self.goto("stream_snapshot");
                }
                if self.status["upload_modes"]
                    .as_array()
                    .is_some_and(|m| m.contains(&json!("ws_relay")))
                {
                    self.goto("socket_open")
                } else {
                    self.transport = "http".into();
                    self.docs["transport"] = json!("http");
                    self.save("stream_snapshot")
                }
            }
            "socket_open" => {
                self.transport = "ws".into();
                self.docs["transport"] = json!("ws");
                let next = if self.bytes.is_empty() {
                    "stream_snapshot"
                } else {
                    "socket_exchange"
                };
                self.save(next)
            }
            "stream_snapshot" => {
                if now - self.started >= 14400000 {
                    return Err(fail("BYO live limit exceeded"));
                }
                self.facts = parse(&value)?;
                if text(&self.facts, "recording_uuid")? != self.recording()?.uuid
                    || number(&self.facts, "recording_generation")? != self.recording()?.generation
                    || boolean(&self.facts, "failed")?
                {
                    return Err(fail("BYO active source changed"));
                }
                let length = number(&self.facts, "ciphertext_length")?;
                let closed = boolean(&self.facts, "closed")?;
                if length < self.offset || length > 134217728 {
                    return Err(fail("BYO live source limit exceeded"));
                }
                if boolean(&self.facts, "overflow")?
                    || number(&self.facts, "retained_offset")? > self.offset
                {
                    self.fallback = true;
                    self.docs["fallback"] = json!(true);
                }
                if closed && (self.fallback || length == self.offset) {
                    return self.goto("socket_close");
                }
                self.chunk_count = (length - self.offset).min(16384);
                if !self.fallback && self.chunk_count > 0 && (self.chunk_count == 16384 || closed) {
                    self.bytes.clear();
                    return self.goto("live_read");
                }
                if now - self.refreshed >= 30000 {
                    self.next = "live_wait".into();
                    self.goto("refresh_periodic")
                } else {
                    self.goto("live_wait")
                }
            }
            "live_read" => {
                let chunk = bytes(&value)?;
                let expected = (self.chunk_count - self.bytes.len() as u32).min(4096);
                if chunk.len() != expected as usize {
                    return Err(fail("BYO live range mismatch"));
                }
                self.bytes.extend(chunk);
                if self.bytes.len() < self.chunk_count as usize {
                    return self.goto("live_read");
                }
                self.segment = json!({"index":self.index,"offset":self.offset,"length":self.chunk_count,"sha256":sha(&self.bytes)});
                let next = if self.transport == "ws" {
                    "socket_exchange"
                } else {
                    "segment_grant"
                };
                self.goto(next)
            }
            "socket_exchange" => {
                let ack = parse(&value)?;
                if ack["type"] != json!("ack")
                    || ack["session_id"] != self.context["upload_session_id"]
                    || ack["segment"] != self.segment
                {
                    return self.fallback();
                }
                self.segment_accepted()
            }
            "segment_grant" => {
                let result = data(&value)?;
                let proof = &result["result"];
                if proof["segment"] != self.segment {
                    return self.fallback();
                }
                if proof["state"] == json!("confirmed") {
                    return self.segment_accepted();
                }
                if proof["state"] != json!("write_authorized") || !proof["grant"].is_object() {
                    return self.fallback();
                }
                self.upload = proof["grant"].clone();
                self.goto("segment_file")
            }
            "segment_file" => self.goto("segment_append"),
            "segment_append" => {
                if value.as_str() != Some(&self.chunk_count.to_string()) {
                    return Err(fail("BYO segment append not durable"));
                }
                self.goto("segment_flush")
            }
            "segment_flush" => self.goto("segment_put"),
            "segment_put" => self.goto("segment_confirm"),
            "segment_confirm" => {
                let result = data(&value)?;
                if result["result"]["state"] != json!("confirmed")
                    || result["result"]["segment"] != self.segment
                {
                    return self.fallback();
                }
                self.segment_accepted()
            }
            "live_ack" => self.goto("live_wait"),
            "live_wait" => self.goto("stream_snapshot"),
            "socket_backoff" => self.goto("socket_open"),
            "socket_close" => {
                if boolean(&self.facts, "closed")? {
                    self.goto("stream_status")
                } else {
                    self.goto("live_wait")
                }
            }
            "stream_status" => {
                let status = data(&value)?;
                if status.get("recovery_required") == Some(&json!(true)) {
                    let rev = number(&status, "recovery_revision")?;
                    if self.docs["renewal"]["expected_revision"] != json!(rev) {
                        self.docs["renewal"] =
                            json!({"operation_id":random,"expected_revision":rev});
                    }
                    return self.save("stream_renew");
                }
                self.stream_handoff(status)
            }
            "stream_renew" => self.goto("stream_status"),
            "handoff" => {
                let status = data(&value)?;
                self.accept_successor(status)
            }
            "live_successor" => {
                let seed = self.docs["successor"].clone();
                self.begin_batch_successor(seed)
            }
            _ => Err(fail("unexpected BYO callback stage")),
        }
    }
    fn stream_handoff(mut self, status: Value) -> Result<Vec<u8>, DeviceSdkError> {
        if status["phase"] == json!("handed_off") {
            return self.accept_successor(status);
        }
        let length = number(&self.facts, "ciphertext_length")?;
        let hash = text(&self.facts, "ciphertext_sha256")?;
        if !(293..=134217728).contains(&length) || !digest(&hash) {
            return Err(fail("BYO source unavailable for handoff"));
        }
        let mode = status
            .get("pending")
            .filter(|p| p["operation"] == json!("handoff"))
            .and_then(|p| p.get("mode"))
            .and_then(Value::as_str)
            .or_else(|| {
                self.docs
                    .get("handoff")
                    .and_then(|p| p.get("mode"))
                    .and_then(Value::as_str)
            })
            .unwrap_or(if !self.fallback && self.offset == length {
                "assembled"
            } else {
                "whole_file"
            });
        if !["assembled", "whole_file"].contains(&mode) {
            return Err(fail("invalid BYO handoff mode"));
        }
        let body = json!({"mode":mode,"final":{"ciphertext_length":length,"ciphertext_sha256":hash,"segment_count":length.div_ceil(16384)}});
        if self.docs.get("handoff").is_some_and(|old| old != &body) {
            return Err(fail("BYO handoff changed"));
        }
        self.docs["handoff"] = body;
        self.save("handoff")
    }
    fn accept_successor(mut self, status: Value) -> Result<Vec<u8>, DeviceSdkError> {
        let successor = status["successor"].clone();
        self.scope(&successor)?;
        let mode = text(&status, "handoff_mode")?;
        if !["assembled", "whole_file"].contains(&mode.as_str())
            || self.context["upload_session_id"] == successor["upload_session_id"]
            || number(&successor, "owner_revision")?
                != number(&self.context, "owner_revision")?
                    .checked_add(1)
                    .ok_or_else(|| fail("BYO owner overflow"))?
        {
            return Err(fail("BYO successor fence mismatch"));
        }
        for key in [
            "organization_id",
            "project_id",
            "device_id",
            "binding_generation",
            "device_assignment_generation",
            "policy_revision",
            "configuration_id",
            "configuration_revision",
            "destination_ref",
            "recording_id",
            "recording_uuid",
            "recording_generation",
        ] {
            if self.context.get(key) != successor.get(key) {
                return Err(fail("BYO successor changed destination"));
            }
        }
        let seed = json!({"context":successor,"mode":mode});
        if self.docs.get("successor").is_some_and(|old| old != &seed) {
            return Err(fail("BYO successor changed"));
        }
        self.docs["successor"] = seed;
        self.save("live_successor")
    }
    fn begin_batch_successor(mut self, seed: Value) -> Result<Vec<u8>, DeviceSdkError> {
        self.stream = false;
        self.context = seed["context"].clone();
        self.scope(&self.context)?;
        self.source_length = number(&self.context, "ciphertext_length")?;
        self.source_hash = text(&self.context, "ciphertext_sha256")?;
        self.load_key = format!("byo/batch/{}/documents", self.identity_key);
        self.stage = "successor_loaded".into();
        self.next = seed["mode"].as_str().unwrap_or("").into();
        let action = json!({"kind":"load","key":self.load_key,"live":false});
        self.reply(action)
    }
}

pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "startByoMachine"
            | "advanceByoMachine"
            | "planByoBleRequest"
            | "acceptByoBleReply"
            | "planByoIdentity"
            | "validateByoPut"
            | "byoHttpPolicy"
            | "planByoSocketFrame"
            | "byoLimits"
            | "acceptByoContextChallenge"
            | "acceptByoContextResult"
            | "planByoContextProof"
            | "planByoContextChallenge"
            | "planByoSocketResume"
            | "acceptByoSocketReady"
            | "byoHostPolicy"
    )
}
#[inline(never)]
pub(crate) fn execute(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "startByoMachine" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Start {
                input: ByoInput,
                now_ms: u64,
            }
            let v: Start = input(value)?;
            Machine::new(v.input, v.now_ms)?.run()
        }
        "advanceByoMachine" => {
            let v: Advance = input(value)?;
            if !uuid(&v.random_uuid) {
                return Err(fail("invalid BYO operation UUID"));
            }
            let mut machine = v.state;
            if machine.stage == "receipt_persisted" {
                return Err(fail(
                    "BYO receipt persistence requires save acknowledgement",
                ));
            }
            if machine.stage == "saved"
                && machine.next == "receipt_persisted"
                && v.event.get("error").is_none()
            {
                let hash = text(&machine.docs, "receipt_sha256")?;
                if machine.phase() == Some(ByoPhase::ReceiptVerified) {
                    machine
                        .advance_recovery(ByoRecoveryEvent::ReceiptPersisted { sha256: hash })?;
                }
                if !machine
                    .advance_recovery(ByoRecoveryEvent::Inspect)?
                    .may_cleanup
                {
                    return Err(fail("BYO cleanup not authorized"));
                }
                return machine.save("confirm");
            }
            if machine.stage == "successor_loaded" && v.event.get("error").is_none() {
                let docs = v.event.get("ok").cloned().unwrap_or(Value::Null);
                machine.docs = if docs.is_null() {
                    json!({})
                } else {
                    object(&docs)?;
                    docs
                };
                if machine
                    .docs
                    .get("context")
                    .is_some_and(|c| c != &machine.context)
                {
                    return Err(fail("BYO batch successor conflict"));
                }
                machine.docs["identity"] = json!(machine.identity_key);
                machine.docs["context"] = machine.context.clone();
                machine.docs["assembled"] = json!(machine.next == "assembled");
                machine.recovery = match machine.docs.get("recovery").filter(|v| !v.is_null()) {
                    Some(v) => Some(input(v.clone())?),
                    None => None,
                };
                return machine.context_ready();
            }
            machine.consume(v.event, v.now_ms, &v.random_uuid)
        }
        "planByoIdentity" => {
            let r: Recording = input(value)?;
            output(&identity(&r)?)
        }
        "planByoBleRequest" => plan_ble(value),
        "acceptByoBleReply" => accept_ble(value),
        "validateByoPut" => validate_put(value),
        "byoHttpPolicy" => http_policy(value),
        "planByoSocketFrame" => {
            let segment = value
                .get("segment")
                .ok_or_else(|| fail("missing BYO segment"))?;
            let bytes = bytes(&value["bytes"])?;
            let raw = json_bytes(segment)?;
            if raw.len() > 1024 || bytes.len() > 16384 {
                return Err(fail("BYO socket frame exceeds bound"));
            }
            let mut out = (raw.len() as u32).to_be_bytes().to_vec();
            out.extend(raw);
            out.extend(bytes);
            output(&out)
        }
        "byoLimits" => public_output(
            json!({"responseBytes":32768,"contextPolls":100,"contextPollMs":250,"socketTimeoutMs":30000,"requestTimeoutMs":30000,"httpAttempts":3}),
        ),
        "byoHostPolicy" => {
            let mode = text(&value, "mode")?;
            if !["list", "sync", "stream"].contains(&mode.as_str()) {
                return Err(fail("invalid BYO mode"));
            }
            let live = mode != "list" && value.get("selectedLive") == Some(&json!(true));
            let allowed = live
                && value
                    .get("control")
                    .and_then(Value::as_str)
                    .is_some_and(|name| {
                        [
                            "readAuthNonce",
                            "requestStopRecording",
                            "readRecordingState",
                        ]
                        .contains(&name)
                    });
            public_output(
                json!({"maximumSignedBlobBytes":408,"releaseOperation":wire::BYO_BLE_ABORT,"allowStopRecording":live,"allowControl":allowed}),
            )
        }
        "planByoContextChallenge" => {
            let nonce = bytes(&value["nonce"])?;
            if nonce.len() != 16 {
                return Err(fail("invalid BYO nonce"));
            }
            public_output(json!({"nonce_base64":STANDARD.encode(nonce)}))
        }
        "planByoContextProof" => {
            let proof = bytes(&value["proof"])?;
            if !(116..=366).contains(&proof.len()) {
                return Err(fail("invalid BYO context proof"));
            }
            public_output(json!({"proof_base64":STANDARD.encode(proof)}))
        }
        "acceptByoContextChallenge" => {
            let reply = data(&value["bytes"])?;
            let id = text(&reply, "context_id")?;
            let encoded = text(&reply, "challenge_base64")?;
            let challenge = STANDARD
                .decode(&encoded)
                .map_err(|_| fail("invalid BYO challenge"))?;
            if !uuid(&id) || challenge.len() != 196 || STANDARD.encode(&challenge) != encoded {
                return Err(fail("invalid BYO challenge"));
            }
            public_output(json!({"id":id,"challengeBase64":encoded,"bytes":challenge}))
        }
        "acceptByoContextResult" => {
            let reply = data(&value["bytes"])?;
            if text(&reply, "context_id")? != text(&value, "id")?
                || text(&reply, "challenge_base64")? != text(&value, "challengeBase64")?
            {
                return Err(fail("BYO context identity mismatch"));
            }
            if reply["state"] == json!("pending") {
                return public_output(json!({"pending":true}));
            }
            if reply["state"] != json!("complete") {
                return Err(fail("invalid BYO context state"));
            }
            let encoded = text(&reply, "result_base64")?;
            let result = STANDARD
                .decode(&encoded)
                .map_err(|_| fail("invalid BYO context result"))?;
            if result.len() != 264 || STANDARD.encode(&result) != encoded {
                return Err(fail("invalid BYO context result"));
            }
            public_output(json!({"bytes":result}))
        }
        "planByoSocketResume" => {
            let id = text(&value, "session")?;
            if !uuid(&id) {
                return Err(fail("invalid BYO socket session"));
            }
            public_output(json!({"type":"resume","session_id":id}))
        }
        "acceptByoSocketReady" => {
            let ready = parse(&value["bytes"])?;
            if ready["type"] != json!("ready")
                || ready["session_id"] != value["session"]
                || value["protocol"] != json!("bota-byo-stream-v1")
            {
                return Err(fail("invalid BYO socket admission"));
            }
            public_output(Value::Null)
        }
        _ => Err(fail("unknown BYO codec")),
    }
}

fn plan_ble(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    let operation =
        u8::try_from(number(&value, "operation")?).map_err(|_| fail("invalid BYO operation"))?;
    let request_id = number(&value, "requestId")?;
    let capacity = number(&value, "capacity")?.min(512) as usize;
    if capacity <= 12 {
        return Err(fail("BYO ATT capacity too small"));
    }
    let body = bytes(&value["bytes"])?;
    if body.len() > 8192 {
        return Err(fail("BYO request exceeds bound"));
    }
    let offset = number(&value, "offset")? as usize;
    let pull = value.get("pull") == Some(&json!(true));
    let end = if pull {
        offset
    } else {
        body.len().min(offset + capacity - 12)
    };
    if offset > 8192 || (offset > body.len() && !pull) {
        return Err(fail("invalid BYO request offset"));
    }
    let frame = ByoBleFrame {
        kind: if pull {
            ByoBleKind::Pull
        } else {
            ByoBleKind::Request
        },
        operation,
        status: 0,
        request_id,
        offset: offset as u16,
        total: if pull { 0 } else { body.len() as u16 },
        payload: if pull {
            vec![]
        } else {
            body[offset..end].to_vec()
        },
    };
    let bytes = encode_byo_ble(&frame, capacity)?;
    public_output(
        json!({"bytes":bytes,"end":end,"expectedOffset":if !pull&&end==body.len(){0}else{end},"attempts":3,"timeoutMs":10000,"maximumSkippedFrames":8}),
    )
}
fn accept_ble(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    let raw = bytes(&value["bytes"])?;
    let frame = decode_byo_ble(&raw)?;
    let request = number(&value, "requestId")?;
    let operation = number(&value, "operation")?;
    let expected = number(&value, "expectedOffset")?;
    if frame.kind != ByoBleKind::Response {
        return Err(fail("BYO reply kind mismatch"));
    }
    if frame.request_id < request {
        return public_output(Value::Null);
    }
    if frame.request_id != request || u32::from(frame.operation) != operation {
        return Err(fail("BYO reply owner mismatch"));
    }
    if frame.status < 2 && u32::from(frame.offset) != expected {
        return public_output(Value::Null);
    }
    let more = value.get("moreRequest") == Some(&json!(true));
    if frame.status == 3 {
        return public_output(json!({"error":"context_expired"}));
    }
    if frame.status == 2 || (!more && frame.status != 0) {
        return public_output(json!({"error":"device_rejected"}));
    }
    if more
        && (frame.status != 1
            || usize::from(frame.total) != bytes(&value["requestBytes"])?.len()
            || !frame.payload.is_empty())
    {
        return Err(fail("BYO request chunk acknowledgement mismatch"));
    }
    let expected_total = value.get("expectedTotal").and_then(Value::as_u64);
    if expected_total.is_some_and(|t| t != u64::from(frame.total))
        || (!more && expected != 0 && frame.payload.is_empty())
    {
        return Err(fail("BYO reply chunk length mismatch"));
    }
    public_output(json!({"payload":frame.payload,"offset":frame.offset,"total":frame.total}))
}
fn validate_put(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    let target = &value["target"];
    let url = text(target, "url")?;
    if target["method"] != json!("PUT")
        || !url.starts_with("https://")
        || url.contains(['@', '#', '\r', '\n'])
        || url.len() > 8192
    {
        return Err(fail("invalid BYO PUT target"));
    }
    let headers = object(&target["headers"])?;
    for (name, v) in headers {
        let v = v.as_str().ok_or_else(|| fail("invalid BYO PUT header"))?;
        if v.len() > 256 || v.contains(['\r', '\n']) {
            return Err(fail("invalid BYO PUT header"));
        }
        match name.as_str() {
            "content-type" if v == "application/octet-stream" => (),
            "x-ms-blob-type" if v == "BlockBlob" => (),
            "x-amz-checksum-sha256" if STANDARD.decode(v).is_ok_and(|d| d.len() == 32) => (),
            _ => return Err(fail("unapproved BYO PUT header")),
        }
    }
    public_output(target.clone())
}
fn http_policy(value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    let status = number(&value, "status")?;
    let attempt = number(&value, "attempt")?;
    if (200..300).contains(&status) {
        return public_output(json!({"accepted":true}));
    }
    if status == 409
        && value
            .get("body")
            .and_then(|v| v.get("error"))
            .and_then(|v| v.get("code"))
            == Some(&json!("expired"))
    {
        return public_output(json!({"error":"expired"}));
    }
    if attempt < 3 && ([425, 429].contains(&status) || status >= 500) {
        let fallback = attempt * 2000;
        let header = value
            .get("retryAfterSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            * 1000;
        let ms = u64::from(fallback).max(header);
        if ms <= 30000 {
            return public_output(json!({"retryMs":ms}));
        }
    }
    public_output(json!({"error":format!("http_{status}")}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input_value() -> Value {
        json!({"operationId":"byo-01234567-89ab-cdef-0123-456789abcdef","mode":"sync","device":{"id":"x","serialNumber":"SN123","connectionState":"connected","mtu":247},"recording":{"uuid":"01234567-89ab-cdef-0123-456789abcdef","generation":1},"scope":{"baseUrl":"https://proxy.example/v1/","scopeKey":"s","organizationId":"org_1","projectId":"prj_1","environment":"production","deviceId":"dev_1","bindingGeneration":1}})
    }
    #[test]
    fn initial_effect_has_no_native_dependency() {
        let bytes = execute(
            "startByoMachine",
            json!({"input":input_value(),"nowMs":"1"}),
        )
        .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["action"]["kind"], "refresh");
    }
    #[test]
    fn rejects_unknown_mode_and_insecure_origin() {
        let mut input = input_value();
        input["mode"] = json!("delete");
        assert!(execute("startByoMachine", json!({"input":input,"nowMs":"1"})).is_err());
        let mut input = input_value();
        input["scope"]["baseUrl"] = json!("https://user:pass@proxy.example/");
        assert!(execute("startByoMachine", json!({"input":input,"nowMs":"1"})).is_err());
    }
    #[test]
    fn framing_uses_shared_rust_wire_codec() {
        let bytes = execute(
            "planByoBleRequest",
            json!({"operation":8,"requestId":1,"capacity":20,"bytes":[1,2,3,4],"offset":0}),
        )
        .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            v["bytes"],
            json!([112, 3, 8, 0, 1, 0, 0, 0, 0, 0, 4, 0, 1, 2, 3, 4])
        );
    }
    #[test]
    fn cross_request_reply_cannot_advance() {
        assert!(execute("acceptByoBleReply",json!({"bytes":[113,3,8,0,2,0,0,0,0,0,0,0],"requestId":1,"operation":8,"expectedOffset":0,"requestBytes":[]})).is_err());
    }
    #[test]
    fn retry_policy_respects_deadline_and_expiry() {
        let v = execute(
            "byoHttpPolicy",
            json!({"status":429,"attempt":1,"retryAfterSeconds":31}),
        )
        .unwrap();
        let v: Value = serde_json::from_slice(&v).unwrap();
        assert!(v.get("retryMs").is_none());
        let v = execute(
            "byoHttpPolicy",
            json!({"status":409,"attempt":1,"body":{"error":{"code":"expired"}}}),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&v).unwrap()["error"],
            "expired"
        );
    }
    fn context() -> Value {
        json!({"organization_id":"org_1","project_id":"prj_1","device_id":"dev_1","environment":"production","binding_generation":1,"device_assignment_generation":1,"policy_revision":"1","recording_uuid":"01234567-89ab-cdef-0123-456789abcdef","recording_generation":1,"channel":"ble","upload_session_id":"11111111-2222-3333-4444-555555555555","recording_id":"rec_1","configuration_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","configuration_revision":1,"destination_ref":"dest_1","owner_revision":1,"ciphertext_length":300,"ciphertext_sha256":sha(&[3;300])})
    }
    fn encoded(v: Value) -> Value {
        json!(serde_json::to_vec(&v).unwrap())
    }
    fn next(step: Value, event: Value) -> Result<Value, DeviceSdkError> {
        let bytes = execute(
            "advanceByoMachine",
            json!({"state":step["state"],"event":event,"nowMs":"2","randomUuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}),
        )?;
        Ok(serde_json::from_slice(&bytes).unwrap())
    }
    fn start(input: Value) -> Value {
        serde_json::from_slice(
            &execute("startByoMachine", json!({"input":input,"nowMs":"1"})).unwrap(),
        )
        .unwrap()
    }
    fn batch_event(step: &Value) -> Value {
        let action = &step["action"];
        let stage = step["state"]["stage"].as_str().unwrap();
        let value = match action["kind"].as_str().unwrap() {
            "refresh" | "file_start" | "file_finish" | "put" | "file_remove" | "wait" | "save" => {
                Value::Null
            }
            "load" => Value::Null,
            "file_append" => json!("300"),
            "ble" => match stage {
                "capabilities" => encoded(json!({"upload_modes":["whole_file"]})),
                "select_source" => encoded(
                    json!({"recording_uuid":"01234567-89ab-cdef-0123-456789abcdef","recording_generation":1,"ciphertext_length":300,"ciphertext_sha256":sha(&[3;300])}),
                ),
                "open" => encoded(
                    json!({"manifest":{"ciphertext_length":300,"ciphertext_sha256":sha(&[3;300])}}),
                ),
                "download" => json!([3; 300].to_vec()),
                "receipt" => json!([4; 32].to_vec()),
                "confirm" => json!([]),
                _ => panic!("unexpected {stage}"),
            },
            "http" => match stage {
                "selection" => encoded(json!({"data":{"destination":{"kind":"customer"}}})),
                "create_context" => encoded(json!({"data":{"context":context()}})),
                "prepare" => encoded(
                    json!({"data":{"authorization":{"configuration_sha256":"ab".repeat(32)},"status":{}}}),
                ),
                "upload" => encoded(
                    json!({"data":{"status":{},"upload":{"method":"PUT","url":"https://store.example/key","headers":{"content-type":"application/octet-stream"}}}}),
                ),
                "complete" => encoded(json!({"data":{"receipt":{"signature":"device-verifies"}}})),
                _ => panic!("unexpected {stage}"),
            },
            _ => panic!("unexpected action {action}"),
        };
        json!({"ok":value})
    }
    #[test]
    fn whole_file_uses_durable_selection_and_device_verified_receipt() {
        let mut step = start(input_value());
        let mut stages = vec![];
        for _ in 0..80 {
            let stage = step["state"]["stage"].as_str().unwrap().to_owned();
            stages.push(stage.clone());
            if step["action"]["kind"] == json!("result") {
                assert_eq!(step["action"]["value"]["recordingId"], "rec_1");
                break;
            }
            let event = batch_event(&step);
            step = next(step, event).unwrap();
        }
        assert_eq!(step["action"]["kind"], "result");
        assert!(
            stages.iter().position(|s| s == "select_source")
                < stages.iter().position(|s| s == "create_context")
        );
        let receipt = stages.iter().position(|s| s == "receipt").unwrap();
        let confirm = stages.iter().position(|s| s == "confirm").unwrap();
        assert!(confirm > receipt + 2);
        assert_eq!(step["state"]["recovery"]["phase"], "Complete");
    }
    #[test]
    fn failed_receipt_save_emits_no_cleanup() {
        let mut step = start(input_value());
        for _ in 0..80 {
            if step["state"]["stage"] == json!("saved")
                && step["state"]["next"] == json!("receipt_persisted")
            {
                assert!(next(step, json!({"error":{"code":"persistence_failed"}})).is_err());
                return;
            }
            let event = batch_event(&step);
            step = next(step, event).unwrap();
        }
        panic!("did not reach receipt persistence");
    }
    #[test]
    fn catalog_requires_monotonic_cursor_and_deduplicates_identity() {
        let mut input = input_value();
        input["mode"] = json!("list");
        input["recording"] = Value::Null;
        let step = next(start(input), json!({"ok":null})).unwrap();
        let step=next(step,json!({"ok":encoded(json!({"next":5,"recording":{"recording_uuid":"01234567-89ab-cdef-0123-456789abcdef","recording_generation":1}}))})).unwrap();
        assert_eq!(step["state"]["catalog"].as_array().unwrap().len(), 1);
        assert!(next(step, json!({"ok":encoded(json!({"next":5}))})).is_err());
    }
    #[test]
    fn create_reply_commits_context_before_another_effect() {
        let mut step = start(input_value());
        for _ in 0..25 {
            if step["state"]["stage"] == json!("create_context") {
                let event = batch_event(&step);
                let step = next(step, event).unwrap();
                assert_eq!(step["action"]["kind"], "save");
                assert_eq!(step["action"]["value"]["context"], context());
                return;
            }
            let event = batch_event(&step);
            step = next(step, event).unwrap();
        }
        panic!("did not reach CREATE");
    }
    fn live_event(step: &Value, websocket: bool) -> Value {
        let action = &step["action"];
        let stage = step["state"]["stage"].as_str().unwrap();
        let value = match stage {
            "capabilities" => {
                encoded(json!({"upload_modes":["whole_file","http_segments","ws_relay"]}))
            }
            "inspect_live" => encoded(json!({"stream_selected":false})),
            "selection" if step["state"]["stream"] == json!(true) => encoded(
                json!({"data":{"destination":{"kind":"customer"},"upload_modes":if websocket{json!(["whole_file","http_segments","ws_relay"])}else{json!(["whole_file","http_segments"])}}}),
            ),
            "select_source" if step["state"]["stream"] == json!(true) => encoded(
                json!({"recording_uuid":"01234567-89ab-cdef-0123-456789abcdef","recording_generation":1,"ciphertext_length":300,"ciphertext_sha256":sha(&[3;300]),"stream_selected":true}),
            ),
            "stream_snapshot" => encoded(
                json!({"recording_uuid":"01234567-89ab-cdef-0123-456789abcdef","recording_generation":1,"ciphertext_length":300,"ciphertext_sha256":sha(&[3;300]),"failed":false,"closed":true,"overflow":false,"retained_offset":0}),
            ),
            "live_context" | "live_ack" | "live_successor" | "socket_open" | "socket_close"
            | "socket_backoff" => Value::Null,
            "live_read" => json!([3; 300].to_vec()),
            "segment_grant" => encoded(
                json!({"data":{"result":{"state":"confirmed","segment":step["state"]["segment"]}}}),
            ),
            "socket_exchange" => return json!({"error":{"code":"transport_failed"}}),
            "stream_status" => encoded(json!({"data":{"phase":"open"}})),
            "handoff" => {
                let mut successor = context();
                successor["upload_session_id"] = json!("22222222-3333-4444-5555-666666666666");
                successor["owner_revision"] = json!(2);
                encoded(
                    json!({"data":{"successor":successor,"handoff_mode":step["state"]["docs"]["handoff"]["mode"]}}),
                )
            }
            _ if action["kind"] == json!("wait") => Value::Null,
            _ => return batch_event(step),
        };
        json!({"ok":value})
    }
    #[test]
    fn live_http_ack_only_hands_off_to_fenced_batch_receipt() {
        let mut input = input_value();
        input["mode"] = json!("stream");
        let mut step = start(input);
        let mut puts = 0;
        let mut handoff = Value::Null;
        for _ in 0..120 {
            if step["action"]["kind"] == json!("result") {
                break;
            }
            if step["action"]["kind"] == json!("put") {
                puts += 1;
            }
            if step["state"]["stage"] == json!("handoff") {
                handoff = step["action"]["body"].clone();
            }
            let event = live_event(&step, false);
            step = next(step, event).unwrap();
        }
        assert_eq!(step["action"]["kind"], "result");
        assert_eq!(puts, 0);
        assert_eq!(handoff["mode"], "assembled");
        assert_eq!(step["state"]["recovery"]["phase"], "Complete");
    }
    #[test]
    fn established_socket_has_three_reconnects_then_whole_file_fence() {
        let mut input = input_value();
        input["mode"] = json!("stream");
        let mut step = start(input);
        let mut delays = vec![];
        let mut puts = 0;
        let mut mode = Value::Null;
        for _ in 0..160 {
            if step["action"]["kind"] == json!("result") {
                break;
            }
            if step["state"]["stage"] == json!("socket_backoff") {
                delays.push(step["action"]["milliseconds"].clone());
            }
            if step["action"]["kind"] == json!("put") {
                puts += 1;
            }
            if step["state"]["stage"] == json!("handoff") {
                mode = step["action"]["body"]["mode"].clone();
            }
            let event = live_event(&step, true);
            step = next(step, event).unwrap();
        }
        assert_eq!(step["action"]["kind"], "result");
        assert_eq!(
            delays,
            json!([1000, 2000, 4000]).as_array().unwrap().clone()
        );
        assert_eq!(puts, 1);
        assert_eq!(mode, "whole_file");
    }
    #[test]
    fn stop_exception_is_exact_live_control_allowlist() {
        for control in [
            "readAuthNonce",
            "requestStopRecording",
            "readRecordingState",
            "requestStartRecording",
            "deleteAllRecordings",
        ] {
            let result = execute(
                "byoHostPolicy",
                json!({"mode":"sync","selectedLive":true,"control":control}),
            )
            .unwrap();
            let result: Value = serde_json::from_slice(&result).unwrap();
            assert_eq!(
                result["allowControl"],
                json!(
                    [
                        "readAuthNonce",
                        "requestStopRecording",
                        "readRecordingState"
                    ]
                    .contains(&control)
                )
            );
            let result = execute(
                "byoHostPolicy",
                json!({"mode":"stream","selectedLive":false,"control":control}),
            )
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&result).unwrap()["allowControl"],
                false
            );
        }
    }
    #[test]
    fn retained_device_stream_owner_does_not_adopt_new_destination() {
        let mut input = input_value();
        input["mode"] = json!("stream");
        let mut step = start(input);
        step = next(step, json!({"ok":null})).unwrap();
        step = next(
            step,
            json!({"ok":encoded(json!({"upload_modes":["whole_file","http_segments"]}))}),
        )
        .unwrap();
        assert_eq!(step["state"]["stage"], "inspect_live");
        step = next(step, json!({"ok":encoded(json!({"stream_selected":true}))})).unwrap();
        step = next(step, json!({"ok":null})).unwrap();
        step=next(step,json!({"ok":encoded(json!({"data":{"destination":{"kind":"bota"},"upload_modes":["whole_file"]}}))})).unwrap();
        assert_eq!(step["action"]["kind"], "save");
        assert_eq!(step["state"]["fallback"], true);
        assert_eq!(step["state"]["next"], "select_source");
    }
    #[test]
    fn resumed_journal_keeps_full_source_recovery_even_without_old_transport() {
        let mut input = input_value();
        input["mode"] = json!("stream");
        let mut step = start(input);
        step = next(step, json!({"ok":null})).unwrap();
        step = next(
            step,
            json!({"ok":encoded(json!({"upload_modes":["whole_file","http_segments"]}))}),
        )
        .unwrap();
        step = next(
            step,
            json!({"ok":encoded(json!({"stream_selected":false}))}),
        )
        .unwrap();
        let identity = step["state"]["identity_key"].clone();
        step = next(
            step,
            json!({"ok":{"identity":identity,"selected_customer":true}}),
        )
        .unwrap();
        assert_eq!(step["state"]["fallback"], true);
        assert_eq!(step["action"]["kind"], "http");
    }
    #[test]
    fn opaque_json_rejects_integer_rounding_before_transport_or_journal() {
        assert!(json_bytes(&json!({"nested":[{"revision":9_007_199_254_740_993_u64}]})).is_err());
        let step = start(input_value());
        assert!(execute("advanceByoMachine",json!({"state":step["state"],"event":{"ok":null},"nowMs":"9007199254740993","randomUuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"})).is_err());
    }
}
