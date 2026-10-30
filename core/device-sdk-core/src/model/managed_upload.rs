//! Customer-proxy encrypted-v2 policy. Hosts execute HTTP and durable IO only.
//! Signed documents are relayed; their trust and decryption remain device/server owned.
use crate::protocol::{LocalWifiCheckpoint, LocalWifiRecovery};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SAFE: u64 = 9_007_199_254_740_991;
const DATE_MAX: u64 = 253_402_300_799_999;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManagedUploadError {
    InvalidInput,
    IdentityConflict,
    Journal,
    InvalidDocument,
    Pending,
    Expired,
    State,
}
impl ManagedUploadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput => "BOTA_UPLOAD_INVALID_INPUT",
            Self::IdentityConflict => "BOTA_UPLOAD_IDENTITY_CONFLICT",
            Self::Journal => "BOTA_UPLOAD_JOURNAL",
            Self::InvalidDocument => "BOTA_UPLOAD_INVALID_DOCUMENT",
            Self::Pending => "BOTA_UPLOAD_PENDING",
            Self::Expired => "BOTA_UPLOAD_EXPIRED",
            Self::State => "BOTA_UPLOAD_STATE",
        }
    }
}
type Result<T> = std::result::Result<T, ManagedUploadError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadScope {
    pub api_origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base_path: Option<String>,
    pub account_id: String,
    pub project_id: String,
    pub organization_id: String,
    pub environment: String,
    pub end_user_id: String,
    pub device_id: String,
    pub binding_generation: u32,
    pub serial_number: String,
    pub native_device_id: String,
    pub scope_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadRecording {
    pub uuid: String,
    pub generation: u32,
    pub ciphertext_length: String,
    pub ciphertext_sha256: String,
    pub started_at_ms: String,
    pub duration_ms: String,
    pub plaintext_length: String,
    pub storage_format: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markers_required: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_wifi_raw_value_hex: Option<String>,
    pub raw_value_hex: String,
    pub flags: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadCheckpoint {
    pub version: u32,
    pub upload_session_id: String,
    pub owner_revision: u32,
    pub revision: u32,
    pub next_ciphertext_offset: String,
    pub prefix_sha256: String,
    pub highest_contiguous_sequence: Option<u32>,
    pub transport_session_id: String,
    pub sink_registration_id: String,
    pub window_packets: u16,
    pub data_payload_bytes: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadEntry {
    pub recording_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_revision: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadInput {
    pub operation_id: String,
    pub scope: ManagedUploadScope,
    pub recording: ManagedUploadRecording,
    pub capability: ManagedUploadCapability,
    pub checkpoint: Option<ManagedUploadCheckpoint>,
    pub prior_journal_entry: Option<ManagedUploadEntry>,
    pub journal_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadJournal {
    pub version: u8,
    pub identity: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<ManagedUploadEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_prior_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_nonce_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_nonce_base64: Option<String>,
    /// Only verified recovery parents; retained across crashes until completion.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_recovery_parents: Vec<ManagedUploadEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUploadEvidence {
    pub ciphertext_length: String,
    pub ciphertext_sha256: Vec<u8>,
    pub manifest_length: u16,
    pub manifest_sha256: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManagedUploadSession {
    pub profile: String,
    pub session_id: String,
    pub owner_revision: u32,
    pub policy: String,
    pub authorization_base64: String,
    pub authorization_sha256: String,
    pub expires_at: String,
    pub state: Option<String>,
    pub channel: Option<String>,
    pub ciphertext_length: Option<u64>,
    pub ciphertext_sha256: Option<String>,
    pub plaintext_length: Option<u64>,
    pub completion_receipt_base64: Option<String>,
    pub completion_receipt_sha256: Option<String>,
    pub marker_completion_receipt_base64: Option<String>,
    pub marker_completion_receipt_sha256: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManagedUploadContext {
    pub context_id: String,
    pub state: String,
    pub challenge_base64: String,
    pub result_base64: Option<String>,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ManagedUploadEvent {
    Identity,
    Inspect {
        record: Option<ManagedUploadJournal>,
    },
    SaveJournal {
        previous: Option<ManagedUploadJournal>,
        entry: Option<ManagedUploadEntry>,
        phase: String,
        authorization_nonce_sha256: Option<String>,
        recovery_nonce_base64: Option<String>,
        recovered_from: Option<ManagedUploadEntry>,
    },
    LocalWifiRecovery {
        record: ManagedUploadJournal,
        checkpoint: LocalWifiCheckpoint,
    },
    RollbackRejectedCreate {
        record: ManagedUploadJournal,
        entry: Option<ManagedUploadEntry>,
    },
    CompleteJournal {
        record: ManagedUploadJournal,
        expected: ManagedUploadEntry,
        receipt_delivered: bool,
    },
    CreateRecording,
    AcceptRecording {
        response_json: String,
    },
    CreateSession {
        entry: ManagedUploadEntry,
        nonce: Vec<u8>,
    },
    NonceHash {
        nonce: Vec<u8>,
    },
    AcceptPointer {
        recording_id: String,
        response_json: String,
    },
    Session {
        entry: ManagedUploadEntry,
        response_json: String,
        restore: bool,
    },
    RestoreDecision {
        entry: ManagedUploadEntry,
        response_json: String,
        now_ms: u64,
        authorization_nonce_sha256: Option<String>,
        recovery_nonce_base64: Option<String>,
        nonce: Option<Vec<u8>>,
        hop: u8,
    },
    RecoverSession {
        entry: ManagedUploadEntry,
        nonce: Vec<u8>,
        expired: bool,
    },
    AcceptRecovery {
        parent: ManagedUploadEntry,
        response_json: String,
        visited: Vec<String>,
    },
    Authorization {
        response_json: String,
        marker_response_json: Option<String>,
    },
    VerifyEvidence {
        evidence: ManagedUploadEvidence,
    },
    Manifest {
        entry: ManagedUploadEntry,
        evidence: ManagedUploadEvidence,
        bytes: Vec<u8>,
        needed: bool,
    },
    Markers {
        entry: ManagedUploadEntry,
        evidence: ManagedUploadEvidence,
        documents: Vec<Vec<u8>>,
    },
    MarkerBatch {
        entry: ManagedUploadEntry,
        evidence: ManagedUploadEvidence,
        count: u32,
    },
    MarkerDocument {
        index: u32,
        count: u32,
        bytes: Vec<u8>,
        expected_sha256: Vec<u8>,
        durable_length: String,
    },
    MarkerAdmissionPlan {
        entry: ManagedUploadEntry,
    },
    Staging {
        response_json: String,
        expires_at: String,
        now_ms: u64,
    },
    StagingRequest {
        entry: ManagedUploadEntry,
        evidence: ManagedUploadEvidence,
        expires_at: String,
        now_ms: u64,
    },
    HttpResponse {
        status: u16,
        response_json: String,
    },
    Finalize {
        entry: ManagedUploadEntry,
        response_json: String,
        evidence: ManagedUploadEvidence,
    },
    ContextInitial {
        response_json: String,
    },
    ContextCreate {
        nonce: Vec<u8>,
    },
    LocalControlGrant {
        nonce: Vec<u8>,
        session_id: String,
    },
    ContextProof {
        initial: ManagedUploadContext,
        proof: Vec<u8>,
    },
    ContextResult {
        initial: ManagedUploadContext,
        response_json: String,
    },
    HttpPolicy {
        status: Option<u16>,
        transport_failure: bool,
        attempt: u8,
    },
    MarkerAdmission {
        status: u16,
        state: Option<String>,
    },
    Limits,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedUploadRequest {
    pub input: ManagedUploadInput,
    pub event: ManagedUploadEvent,
}
#[derive(Clone, Debug, Serialize)]
pub struct ManagedUploadReply {
    pub value: Value,
}

impl ManagedUploadEntry {
    fn validate(&self) -> Result<()> {
        if !self.recording_id.starts_with("rec_")
            || self.recording_id.len() < 5
            || self.recording_id.len() > 256
            || !self.recording_id.bytes().all(id_byte)
            || self.session_id.as_ref().is_some_and(|v| !uuid(v))
            || self.session_id.is_some() != self.owner_revision.is_some()
            || self
                .owner_revision
                .is_some_and(|v| v == 0 || v > i32::MAX as u32)
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        Ok(())
    }
    fn agrees(&self, other: &Self) -> bool {
        self.recording_id == other.recording_id
            && self
                .session_id
                .as_ref()
                .is_none_or(|v| Some(v) == other.session_id.as_ref())
            && self
                .owner_revision
                .is_none_or(|v| Some(v) == other.owner_revision)
    }
}
impl ManagedUploadInput {
    fn channel(&self) -> &'static str {
        if self.capability.local_wifi_raw_value_hex.is_some() {
            "local_wifi"
        } else {
            "ble"
        }
    }

    pub fn journal_key(&self) -> Result<String> {
        hash_json(&json!([
            self.scope.scope_key,
            self.scope.device_id,
            self.scope.binding_generation,
            self.recording.uuid,
            self.recording.generation,
            self.recording.ciphertext_length,
            self.recording.ciphertext_sha256
        ]))
    }
    pub fn identity(&self, transport: bool) -> Result<String> {
        let mut scope = self.scope.clone();
        if !transport {
            scope.native_device_id.clear();
        }
        let mut recording = self.recording.clone();
        if recording.markers_required == Some(false) {
            recording.markers_required = None;
        }
        hash_json(&json!({"scope":scope,"recording":recording}))
    }
    fn base(&self) -> &str {
        self.scope.api_base_path.as_deref().unwrap_or("/v1")
    }
    fn sessions(&self, entry: &ManagedUploadEntry) -> String {
        format!(
            "{}/recordings/{}/encrypted-upload-v2/sessions",
            self.base(),
            entry.recording_id
        )
    }
    fn session_path(&self, entry: &ManagedUploadEntry) -> Result<String> {
        entry.validate()?;
        Ok(format!(
            "{}/{}",
            self.sessions(entry),
            entry.session_id.as_ref().ok_or(ManagedUploadError::State)?
        ))
    }
    fn validate(&self) -> Result<()> {
        let s = &self.scope;
        let r = &self.recording;
        if self.operation_id.is_empty()
            || self.operation_id.len() > 128
            || !https_url(&s.api_origin, true)
            || ![
                &s.account_id,
                &s.project_id,
                &s.environment,
                &s.end_user_id,
                &s.device_id,
                &s.serial_number,
                &s.native_device_id,
            ]
            .iter()
            .all(|v| scope_id(v))
            || s.scope_key.is_empty()
            || s.scope_key.len() > 4096
            || s.binding_generation == 0
            || (!s.organization_id.is_empty()
                && (s.organization_id.len() > 256 || !s.organization_id.bytes().all(id_byte)))
            || !base_path(self.base())
            || !uuid(&r.uuid)
            || r.generation == 0
            || r.storage_format != 3
            || !hex(&r.ciphertext_sha256, 32)
            || !hex(&self.capability.raw_value_hex, 24)
        {
            return Err(ManagedUploadError::InvalidInput);
        }
        if let Some(local) = &self.capability.local_wifi_raw_value_hex {
            if !hex(local, 16) || r.markers_required == Some(true) || self.checkpoint.is_some() {
                return Err(ManagedUploadError::InvalidInput);
            }
            crate::protocol::decode_local_wifi_capabilities(&unhex(local)?, 185)
                .map_err(|_| ManagedUploadError::InvalidInput)?;
        }
        let length = decimal(&r.ciphertext_length, SAFE)?;
        let start = decimal(&r.started_at_ms, DATE_MAX)?;
        let duration = decimal(&r.duration_ms, DATE_MAX)?;
        decimal(&r.plaintext_length, SAFE)?;
        if length == 0 || duration > DATE_MAX - start {
            return Err(ManagedUploadError::InvalidInput);
        }
        if self
            .journal_key
            .as_ref()
            .is_some_and(|key| self.journal_key().ok().as_ref() != Some(key))
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        if let Some(e) = &self.prior_journal_entry {
            e.validate()?;
        }
        if let Some(c) = &self.checkpoint
            && (c.version != 1
                || !uuid(&c.upload_session_id)
                || c.owner_revision == 0
                || c.owner_revision > i32::MAX as u32
                || !hex(&c.prefix_sha256, 32)
                || c.sink_registration_id.is_empty()
                || c.sink_registration_id.len() > 128
                || c.window_packets == 0
                || c.data_payload_bytes == 0
                || decimal(&c.next_ciphertext_offset, u64::MAX)? > length
                || decimal(&c.transport_session_id, u64::MAX)? == 0)
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        Ok(())
    }
    fn checkpoint_agrees(&self, entry: Option<&ManagedUploadEntry>) -> Result<()> {
        if let Some(c) = &self.checkpoint {
            let e = entry.ok_or(ManagedUploadError::IdentityConflict)?;
            let revision = e
                .owner_revision
                .ok_or(ManagedUploadError::IdentityConflict)?;
            if c.owner_revision > revision
                || (c.owner_revision == revision)
                    != (Some(&c.upload_session_id) == e.session_id.as_ref())
            {
                return Err(ManagedUploadError::IdentityConflict);
            }
        }
        Ok(())
    }
    fn verify(&self, evidence: &ManagedUploadEvidence) -> Result<()> {
        if evidence.ciphertext_length != self.recording.ciphertext_length
            || evidence.ciphertext_sha256 != unhex(&self.recording.ciphertext_sha256)?
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        Ok(())
    }
    fn validate_journal(&self, record: &ManagedUploadJournal) -> Result<()> {
        if ![1, 2].contains(&record.version)
            || record.identity != self.identity(record.version == 1)?
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        if ![
            "ready",
            "recording_create_unknown",
            "session_create_unknown",
        ]
        .contains(&record.phase.as_str())
            || record
                .imported_prior_sha256
                .as_ref()
                .is_some_and(|v| !hex(v, 32))
            || record.authorization_nonce_sha256.as_ref().is_some_and(|v| {
                !hex(v, 32)
                    || record
                        .entry
                        .as_ref()
                        .and_then(|e| e.session_id.as_ref())
                        .is_none()
            })
        {
            return Err(ManagedUploadError::Journal);
        }
        if let Some(e) = &record.entry {
            e.validate()?;
        }
        if !record.local_recovery_parents.is_empty() {
            let current = record.entry.as_ref().ok_or(ManagedUploadError::Journal)?;
            if self.capability.local_wifi_raw_value_hex.is_none()
                || record.local_recovery_parents.len() > 64
            {
                return Err(ManagedUploadError::Journal);
            }
            let mut revision = 0;
            let mut sessions = std::collections::BTreeSet::new();
            for parent in &record.local_recovery_parents {
                parent.validate()?;
                let id = parent
                    .session_id
                    .as_ref()
                    .ok_or(ManagedUploadError::Journal)?;
                let owner = parent.owner_revision.ok_or(ManagedUploadError::Journal)?;
                if parent.recording_id != current.recording_id
                    || owner <= revision
                    || Some(owner) >= current.owner_revision
                    || Some(id) == current.session_id.as_ref()
                    || !sessions.insert(id)
                {
                    return Err(ManagedUploadError::Journal);
                }
                revision = owner;
            }
        }
        if let Some(nonce) = &record.recovery_nonce_base64 {
            if record.phase != "ready"
                || record
                    .entry
                    .as_ref()
                    .and_then(|e| e.session_id.as_ref())
                    .is_none()
            {
                return Err(ManagedUploadError::Journal);
            }
            document(nonce, 16, None)?;
        }
        Ok(())
    }
}
impl ManagedUploadSession {
    fn pointer(&self) -> Result<()> {
        if self.profile != "encrypted_upload_v2"
            || !uuid(&self.session_id)
            || self.owner_revision == 0
            || self.owner_revision > i32::MAX as u32
            || !["legacy_allowed", "v2_preferred", "v2_required"].contains(&self.policy.as_str())
        {
            return Err(ManagedUploadError::InvalidDocument);
        }
        Ok(())
    }
    fn identity(&self, input: &ManagedUploadInput, entry: &ManagedUploadEntry) -> Result<()> {
        self.pointer()?;
        if Some(&self.session_id) != entry.session_id.as_ref()
            || Some(self.owner_revision) != entry.owner_revision
            || self.channel.as_deref() != Some(input.channel())
            || self.ciphertext_length != Some(decimal(&input.recording.ciphertext_length, SAFE)?)
            || self.ciphertext_sha256.as_ref() != Some(&input.recording.ciphertext_sha256)
        {
            return Err(ManagedUploadError::IdentityConflict);
        }
        Ok(())
    }
    fn actions(&self) -> Result<(bool, bool)> {
        match self.state.as_deref() {
            Some("staging") => Ok((true, true)),
            Some("staged") => Ok((false, true)),
            Some("ready" | "processing" | "published") => Ok((false, false)),
            Some("expired") => Err(ManagedUploadError::Expired),
            _ => Err(ManagedUploadError::State),
        }
    }
}

impl ManagedUploadRequest {
    pub fn reduce(&self) -> Result<ManagedUploadReply> {
        let input = &self.input;
        input.validate()?;
        let value = match &self.event {
            ManagedUploadEvent::Identity => {
                json!({"journalKey":input.journal_key()?,"identity":input.identity(false)?})
            }
            ManagedUploadEvent::Inspect { record } => {
                let mut migrated = record.clone();
                if let Some(r) = &mut migrated {
                    input.validate_journal(r)?;
                    if r.phase != "ready" {
                        return Err(ManagedUploadError::Pending);
                    }
                    let entry = r.entry.as_ref().ok_or(ManagedUploadError::Journal)?;
                    if let Some(prior) = &input.prior_journal_entry
                        && !prior.agrees(entry)
                        && r.imported_prior_sha256.as_ref() != Some(&hash_json(prior)?)
                    {
                        return Err(ManagedUploadError::IdentityConflict);
                    }
                    r.version = 2;
                    r.identity = input.identity(false)?;
                }
                let entry = migrated
                    .as_ref()
                    .and_then(|v| v.entry.clone())
                    .or_else(|| input.prior_journal_entry.clone());
                input.checkpoint_agrees(entry.as_ref())?;
                json!({"journalKey":input.journal_key()?,"identity":input.identity(false)?,"record":migrated,"entry":entry})
            }
            ManagedUploadEvent::SaveJournal {
                previous,
                entry,
                phase,
                authorization_nonce_sha256,
                recovery_nonce_base64,
                recovered_from,
            } => {
                if let Some(p) = previous {
                    input.validate_journal(p)?;
                }
                if let Some(e) = entry {
                    e.validate()?;
                }
                let imported = previous
                    .as_ref()
                    .and_then(|p| p.imported_prior_sha256.clone())
                    .or(input
                        .prior_journal_entry
                        .as_ref()
                        .map(hash_json)
                        .transpose()?);
                let auth = authorization_nonce_sha256.clone().or_else(|| {
                    previous
                        .as_ref()
                        .filter(|p| {
                            p.entry.as_ref().and_then(|e| e.session_id.as_ref())
                                == entry.as_ref().and_then(|e| e.session_id.as_ref())
                        })
                        .and_then(|p| p.authorization_nonce_sha256.clone())
                });
                let mut parents = previous
                    .as_ref()
                    .map(|p| p.local_recovery_parents.clone())
                    .unwrap_or_default();
                if let Some(parent) = recovered_from {
                    let next = entry.as_ref().ok_or(ManagedUploadError::Journal)?;
                    if previous.as_ref().and_then(|p| p.entry.as_ref()) != Some(parent)
                        || parent.recording_id != next.recording_id
                        || parent.session_id.is_none()
                        || next.session_id.is_none()
                        || parent.session_id == next.session_id
                        || parent.owner_revision.is_none()
                        || next.owner_revision <= parent.owner_revision
                    {
                        return Err(ManagedUploadError::IdentityConflict);
                    }
                    if input.capability.local_wifi_raw_value_hex.is_some() {
                        parents.push(parent.clone());
                    }
                } else if previous.as_ref().and_then(|p| p.entry.as_ref()) != entry.as_ref() {
                    parents.clear();
                }
                let r = ManagedUploadJournal {
                    version: 2,
                    identity: input.identity(false)?,
                    phase: phase.clone(),
                    entry: entry.clone(),
                    imported_prior_sha256: imported,
                    authorization_nonce_sha256: auth,
                    recovery_nonce_base64: recovery_nonce_base64.clone(),
                    local_recovery_parents: parents,
                };
                input.validate_journal(&r)?;
                json!({"record":r})
            }
            ManagedUploadEvent::LocalWifiRecovery { record, checkpoint } => {
                input.validate_journal(record)?;
                let current = record.entry.as_ref().ok_or(ManagedUploadError::Journal)?;
                if input.capability.local_wifi_raw_value_hex.is_none()
                    || checkpoint.recording_uuid != uuid_array(&input.recording.uuid)?
                    || checkpoint.recording_generation != input.recording.generation
                    || checkpoint.ciphertext_length
                        != decimal(&input.recording.ciphertext_length, SAFE)?
                    || checkpoint.ciphertext_sha256.as_slice()
                        != unhex(&input.recording.ciphertext_sha256)?
                {
                    return Err(ManagedUploadError::IdentityConflict);
                }
                let session = uuid_array(
                    current
                        .session_id
                        .as_ref()
                        .ok_or(ManagedUploadError::Journal)?,
                )?;
                let owner = current.owner_revision.ok_or(ManagedUploadError::Journal)?;
                if checkpoint.upload_session_uuid == session && checkpoint.owner_revision == owner {
                    json!({"recovery":null})
                } else {
                    let mut authorized = false;
                    for parent in &record.local_recovery_parents {
                        if checkpoint.upload_session_uuid
                            == uuid_array(
                                parent
                                    .session_id
                                    .as_ref()
                                    .ok_or(ManagedUploadError::Journal)?,
                            )?
                            && Some(checkpoint.owner_revision) == parent.owner_revision
                        {
                            authorized = true;
                            break;
                        }
                    }
                    if !authorized {
                        return Err(ManagedUploadError::IdentityConflict);
                    }
                    json!({"recovery":LocalWifiRecovery {
                        previous_upload_session_uuid:checkpoint.upload_session_uuid,
                        previous_owner_revision:checkpoint.owner_revision,
                        upload_session_uuid:session,owner_revision:owner,
                    }})
                }
            }
            ManagedUploadEvent::RollbackRejectedCreate { record, entry } => {
                input.validate_journal(record)?;
                let phase = if entry.is_none() {
                    "recording_create_unknown"
                } else {
                    "session_create_unknown"
                };
                if record.phase != phase || &record.entry != entry {
                    return Err(ManagedUploadError::IdentityConflict);
                }
                json!({"remove":entry.is_none()})
            }
            ManagedUploadEvent::CompleteJournal {
                record,
                expected,
                receipt_delivered,
            } => {
                input.validate_journal(record)?;
                if !receipt_delivered {
                    return Err(ManagedUploadError::State);
                }
                if record.phase != "ready" || record.entry.as_ref() != Some(expected) {
                    return Err(ManagedUploadError::IdentityConflict);
                }
                json!({"remove":true})
            }
            ManagedUploadEvent::CreateRecording => {
                let start = decimal(&input.recording.started_at_ms, DATE_MAX)?;
                let end = start + decimal(&input.recording.duration_ms, DATE_MAX)?;
                plan(
                    format!("{}/recordings", input.base()),
                    json!({"device_id":input.scope.device_id,
                    "recording_uuid":input.recording.uuid,"recording_generation":input.recording.generation,
                    "end_user_id":input.scope.end_user_id,"upload_method":if input.channel() == "ble" { "ble" } else { "unknown" },"streaming":false,
                    "metadata":{"started_at":iso_date(start),"ended_at":iso_date(end)}}),
                )?
            }
            ManagedUploadEvent::AcceptRecording { response_json } => {
                #[derive(Deserialize)]
                struct Created {
                    id: String,
                }
                let v: Created = decode(response_json)?;
                let e = ManagedUploadEntry {
                    recording_id: v.id,
                    session_id: None,
                    owner_revision: None,
                };
                e.validate()?;
                json!({"entry":e})
            }
            ManagedUploadEvent::CreateSession { entry, nonce } => {
                entry.validate()?;
                if entry.session_id.is_some() || nonce.len() != 16 {
                    return Err(ManagedUploadError::State);
                }
                let mut body = json!({"device_id":input.scope.device_id,"binding_generation":input.scope.binding_generation,
                    "recording_uuid":input.recording.uuid,"recording_generation":input.recording.generation,
                    "storage_format":"bota_enc_v2","channel":input.channel(),"capabilities_base64":base64(&unhex(&input.capability.raw_value_hex)?),
                    "auth_nonce_base64":base64(nonce),"ciphertext_length":decimal(&input.recording.ciphertext_length,SAFE)?,
                    "ciphertext_sha256":input.recording.ciphertext_sha256});
                if let Some(local) = &input.capability.local_wifi_raw_value_hex {
                    body["local_wifi_capabilities_base64"] = json!(base64(&unhex(local)?));
                }
                plan(input.sessions(entry), body)?
            }
            ManagedUploadEvent::NonceHash { nonce } => {
                if nonce.len() != 16 {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                json!({"sha256":hash(nonce)})
            }
            ManagedUploadEvent::AcceptPointer {
                recording_id,
                response_json,
            } => json!({"entry":pointer(recording_id,response_json)?}),
            ManagedUploadEvent::Session {
                entry,
                response_json,
                restore,
            } => {
                let s: ManagedUploadSession = decode(response_json)?;
                s.pointer()?;
                date(&s.expires_at)?;
                let (upload, manifest) = if *restore {
                    s.identity(input, entry)?;
                    s.actions()?
                } else {
                    (true, true)
                };
                json!({"session":s,"uploadCiphertext":upload,"needsManifest":manifest})
            }
            ManagedUploadEvent::RestoreDecision {
                entry,
                response_json,
                now_ms,
                authorization_nonce_sha256,
                recovery_nonce_base64,
                nonce,
                hop,
            } => {
                let s: ManagedUploadSession = decode(response_json)?;
                s.identity(input, entry)?;
                let pre = matches!(s.state.as_deref(), Some("created" | "staging" | "staged"));
                let expired = s.state.as_deref() == Some("expired")
                    || (pre && date(&s.expires_at)? <= *now_ms);
                let check_nonce = recovery_nonce_base64.is_some()
                    || expired
                    || (pre && authorization_nonce_sha256.is_some());
                let selected = if let Some(v) = recovery_nonce_base64 {
                    Some(document(v, 16, None)?)
                } else {
                    nonce.clone()
                };
                if selected.as_ref().is_some_and(|v| v.len() != 16) {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                let changed = selected
                    .as_ref()
                    .zip(authorization_nonce_sha256.as_ref())
                    .is_some_and(|(n, h)| hash(n) != *h);
                let recover = recovery_nonce_base64.is_some() || expired || changed;
                if recover && (input.capability.flags & 0x37f != 0x37f || *hop >= 3) {
                    return Err(ManagedUploadError::Expired);
                }
                json!({"checkNonce":check_nonce,"recover":recover,"expired":expired,"nonce":selected})
            }
            ManagedUploadEvent::RecoverSession {
                entry,
                nonce,
                expired,
            } => {
                if nonce.len() != 16 || input.capability.flags & 0x37f != 0x37f {
                    return Err(ManagedUploadError::Expired);
                }
                let mut body = json!({"owner_revision":entry.owner_revision.ok_or(ManagedUploadError::State)?,
                    "auth_nonce_base64":base64(nonce),"capabilities_base64":base64(&unhex(&input.capability.raw_value_hex)?)});
                if !expired {
                    body["reason"] = json!("nonce_changed");
                }
                let mut value = plan(format!("{}/recover", input.session_path(entry)?), body)?;
                value["nonceSha256"] = json!(hash(nonce));
                value["recoveryNonceBase64"] = json!(base64(nonce));
                value
            }
            ManagedUploadEvent::AcceptRecovery {
                parent,
                response_json,
                visited,
            } => {
                let e = pointer(&parent.recording_id, response_json)?;
                if e.owner_revision <= parent.owner_revision
                    || e.session_id.as_ref().is_some_and(|id| visited.contains(id))
                {
                    return Err(ManagedUploadError::IdentityConflict);
                }
                json!({"entry":e})
            }
            ManagedUploadEvent::Authorization {
                response_json,
                marker_response_json,
            } => {
                let s: ManagedUploadSession = decode(response_json)?;
                s.pointer()?;
                date(&s.expires_at)?;
                let mut bytes =
                    document(&s.authorization_base64, 408, Some(&s.authorization_sha256))?;
                if input.recording.markers_required == Some(true) {
                    #[derive(Deserialize)]
                    struct Admission {
                        profile: String,
                        context_base64: String,
                        authorization_base64: String,
                        authorization_sha256: String,
                    }
                    let a: Admission = decode(
                        marker_response_json
                            .as_ref()
                            .ok_or(ManagedUploadError::InvalidDocument)?,
                    )?;
                    if a.profile != "recording-markers/1" {
                        return Err(ManagedUploadError::InvalidDocument);
                    }
                    bytes.extend(document(&a.context_base64, 176, None)?);
                    bytes.extend(document(
                        &a.authorization_base64,
                        280,
                        Some(&a.authorization_sha256),
                    )?);
                }
                json!({"bytes":bytes})
            }
            ManagedUploadEvent::VerifyEvidence { evidence } => {
                input.verify(evidence)?;
                json!({})
            }
            ManagedUploadEvent::Manifest {
                entry,
                evidence,
                bytes,
                needed,
            } => {
                input.verify(evidence)?;
                if bytes.len() != 580
                    || evidence.manifest_length != 580
                    || evidence.manifest_sha256 != Sha256::digest(bytes).as_slice()
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                if !needed {
                    json!({"skip":true})
                } else {
                    plan(
                        format!("{}/manifest", input.session_path(entry)?),
                        json!({
                    "owner_revision":entry.owner_revision,"manifest_base64":base64(bytes),"manifest_sha256":hash(bytes)}),
                    )?
                }
            }
            ManagedUploadEvent::Markers {
                entry,
                evidence,
                documents,
            } => {
                input.verify(evidence)?;
                if input.recording.markers_required != Some(true)
                    || !(2..=4097).contains(&documents.len())
                    || documents[0].len() != 200
                    || documents[1..]
                        .iter()
                        .any(|d| !(216..=402).contains(&d.len()))
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                plan(
                    format!("{}/markers/batch", input.session_path(entry)?),
                    json!({"owner_revision":entry.owner_revision,
                    "seal_base64":base64(&documents[0]),"pages_base64":documents[1..].iter().map(|v|base64(v)).collect::<Vec<_>>()}),
                )?
            }
            ManagedUploadEvent::MarkerBatch {
                entry,
                evidence,
                count,
            } => {
                input.verify(evidence)?;
                if input.recording.markers_required != Some(true) || !(2..=4097).contains(count) {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                json!({"path":format!("{}/markers/batch",input.session_path(entry)?),"ownerRevision":entry.owner_revision})
            }
            ManagedUploadEvent::MarkerDocument {
                index,
                count,
                bytes,
                expected_sha256,
                durable_length,
            } => {
                if input.recording.markers_required != Some(true)
                    || !(2..=4097).contains(count)
                    || index >= count
                    || (if *index == 0 {
                        bytes.len() != 200
                    } else {
                        !(216..=402).contains(&bytes.len())
                    })
                    || decimal(durable_length, SAFE)? != bytes.len() as u64
                    || expected_sha256 != Sha256::digest(bytes).as_slice()
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                json!({"base64":base64(bytes)})
            }
            ManagedUploadEvent::MarkerAdmissionPlan { entry } => plan(
                format!("{}/markers/authorization", input.session_path(entry)?),
                json!({"owner_revision":entry.owner_revision,"request_uuid":entry.session_id}),
            )?,
            ManagedUploadEvent::Staging {
                response_json,
                expires_at,
                now_ms,
            } => {
                if date(expires_at)? <= *now_ms {
                    return Err(ManagedUploadError::Expired);
                }
                #[derive(Deserialize)]
                struct Target {
                    url: String,
                    method: String,
                    headers: std::collections::BTreeMap<String, String>,
                }
                let t: Target = decode(response_json)?;
                if t.method != "PUT"
                    || !https_url(&t.url, false)
                    || t.headers.iter().any(|(k, v)| {
                        k.is_empty()
                            || !k.bytes().all(|c| {
                                c.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&c)
                            })
                            || v.bytes().any(|c| matches!(c, 0 | 10 | 13))
                            || ["authorization", "cookie", "proxy-authorization"]
                                .contains(&k.to_ascii_lowercase().as_str())
                    })
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                json!({"url":t.url,"method":t.method,"headers":t.headers})
            }
            ManagedUploadEvent::StagingRequest {
                entry,
                evidence,
                expires_at,
                now_ms,
            } => {
                input.verify(evidence)?;
                if date(expires_at)? <= *now_ms {
                    return Err(ManagedUploadError::Expired);
                }
                plan(
                    format!("{}/staging-url", input.session_path(entry)?),
                    json!({"owner_revision":entry.owner_revision}),
                )?
            }
            ManagedUploadEvent::HttpResponse {
                status,
                response_json,
            } => {
                let value = serde_json::from_str::<Value>(response_json).ok();
                let missing = *status == 409
                    && value
                        .as_ref()
                        .and_then(|v| v.get("error"))
                        .and_then(|v| v.get("code"))
                        .and_then(Value::as_str)
                        == Some("encrypted_upload_v2_staging_missing");
                json!({"success":(200..=299).contains(status),"authorizationRejected":([401,403].contains(status)),"stagingMissing":missing})
            }
            ManagedUploadEvent::Finalize {
                entry,
                response_json,
                evidence,
            } => {
                input.verify(evidence)?;
                let s: ManagedUploadSession = decode(response_json)?;
                s.identity(input, entry)?;
                s.actions()?;
                if s.state.as_deref() != Some("published") {
                    json!({"published":false,"waitMs":2000,"maximumPolls":60})
                } else {
                    if s.plaintext_length != Some(decimal(&input.recording.plaintext_length, SAFE)?)
                    {
                        return Err(ManagedUploadError::InvalidDocument);
                    }
                    let mut receipt = document(
                        s.completion_receipt_base64
                            .as_deref()
                            .ok_or(ManagedUploadError::InvalidDocument)?,
                        336,
                        Some(
                            s.completion_receipt_sha256
                                .as_deref()
                                .ok_or(ManagedUploadError::InvalidDocument)?,
                        ),
                    )?;
                    if input.recording.markers_required == Some(true) {
                        receipt.extend(document(
                            s.marker_completion_receipt_base64
                                .as_deref()
                                .ok_or(ManagedUploadError::InvalidDocument)?,
                            296,
                            Some(
                                s.marker_completion_receipt_sha256
                                    .as_deref()
                                    .ok_or(ManagedUploadError::InvalidDocument)?,
                            ),
                        )?);
                    }
                    json!({"published":true,"receipt":receipt})
                }
            }
            ManagedUploadEvent::ContextInitial { response_json } => {
                let c: ManagedUploadContext = decode(response_json)?;
                if !uuid(&c.context_id)
                    || !["challenge", "pending", "complete"].contains(&c.state.as_str())
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                date(&c.expires_at)?;
                json!({"initial":c,"challenge":document(&c.challenge_base64,196,None)?})
            }
            ManagedUploadEvent::LocalControlGrant { nonce, session_id } => {
                let session = session_id
                    .parse::<u64>()
                    .map_err(|_| ManagedUploadError::InvalidDocument)?;
                if input.channel() != "local_wifi"
                    || session == 0
                    || session.to_string() != *session_id
                    || nonce.len() != 16
                    || nonce.iter().all(|b| *b == 0)
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                plan(
                    format!(
                        "{}/devices/{}/local-wifi/control-grant",
                        input.base(),
                        input.scope.device_id
                    ),
                    json!({"binding_generation":input.scope.binding_generation,"session_id":session_id,"auth_nonce_base64":base64(nonce)}),
                )?
            }
            ManagedUploadEvent::ContextCreate { nonce } => {
                if nonce.len() != 16 {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                plan(
                    format!(
                        "{}/devices/{}/encrypted-upload-v2/contexts",
                        input.base(),
                        input.scope.device_id
                    ),
                    json!({"nonce_base64":base64(nonce)}),
                )?
            }
            ManagedUploadEvent::ContextProof { initial, proof } => {
                if !(116..=366).contains(&proof.len()) || !uuid(&initial.context_id) {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                plan(
                    format!(
                        "{}/devices/{}/encrypted-upload-v2/contexts/{}/proof",
                        input.base(),
                        input.scope.device_id,
                        initial.context_id
                    ),
                    json!({"proof_base64":base64(proof)}),
                )?
            }
            ManagedUploadEvent::ContextResult {
                initial,
                response_json,
            } => {
                let c: ManagedUploadContext = decode(response_json)?;
                if c.context_id != initial.context_id
                    || c.challenge_base64 != initial.challenge_base64
                    || c.expires_at != initial.expires_at
                    || !["pending", "complete"].contains(&c.state.as_str())
                    || (c.state == "pending" && c.result_base64.is_some())
                {
                    return Err(ManagedUploadError::InvalidDocument);
                }
                if c.state == "complete" {
                    json!({"complete":true,"result":document(c.result_base64.as_deref().ok_or(ManagedUploadError::InvalidDocument)?,264,None)?})
                } else {
                    json!({"complete":false,"waitMs":250,"maximumPolls":100})
                }
            }
            ManagedUploadEvent::HttpPolicy {
                status,
                transport_failure,
                attempt,
            } => json!({"retry":*attempt<2
                && (*transport_failure||status.is_some_and(|s|s==429||(500..=599).contains(&s))),"waitMs":250}),
            ManagedUploadEvent::MarkerAdmission { status, state } => {
                json!({"create":*status==404&&matches!(state.as_deref(),None|Some(""|"created"|"staging"|"staged"))})
            }
            ManagedUploadEvent::Limits => {
                json!({"responseBytes":1_048_576,"requestTimeoutMs":30_000,
                "drainTimeoutMs":60_000,"maximumRecoveryHops":3,"maximumPolls":60,"contextMaximumPolls":100})
            }
        };
        Ok(ManagedUploadReply { value })
    }
}

fn pointer(recording_id: &str, response: &str) -> Result<ManagedUploadEntry> {
    #[derive(Deserialize)]
    struct Pointer {
        profile: String,
        session_id: String,
        owner_revision: u32,
    }
    let p: Pointer = decode(response)?;
    if p.profile != "encrypted_upload_v2" {
        return Err(ManagedUploadError::InvalidDocument);
    }
    let e = ManagedUploadEntry {
        recording_id: recording_id.into(),
        session_id: Some(p.session_id),
        owner_revision: Some(p.owner_revision),
    };
    e.validate()?;
    Ok(e)
}
fn plan(path: String, body: Value) -> Result<Value> {
    Ok(
        json!({"path":path,"bodyJSON":serde_json::to_string(&body).map_err(|_|ManagedUploadError::InvalidDocument)?}),
    )
}
fn decode<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T> {
    if s.len() > 1_048_576 {
        return Err(ManagedUploadError::InvalidDocument);
    }
    serde_json::from_str(s).map_err(|_| ManagedUploadError::InvalidDocument)
}
fn hash_json<T: Serialize>(v: &T) -> Result<String> {
    let value = serde_json::to_value(v).map_err(|_| ManagedUploadError::InvalidInput)?;
    Ok(hash(
        &serde_json::to_vec(&value).map_err(|_| ManagedUploadError::InvalidInput)?,
    ))
}
fn hash(v: &[u8]) -> String {
    Sha256::digest(v)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
fn decimal(v: &str, max: u64) -> Result<u64> {
    if v.is_empty() || (v.len() > 1 && v.starts_with('0')) || !v.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ManagedUploadError::InvalidInput);
    }
    v.parse::<u64>()
        .ok()
        .filter(|n| *n <= max)
        .ok_or(ManagedUploadError::InvalidInput)
}
fn id_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
}
fn scope_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 256
        && v != "."
        && v != ".."
        && v.bytes()
            .all(|c| id_byte(c) || matches!(c, b'.' | b':' | b'@'))
}
fn base_path(v: &str) -> bool {
    v.is_empty()
        || (v.starts_with('/')
            && v[1..]
                .split('/')
                .all(|s| !s.is_empty() && s.bytes().all(id_byte)))
}
fn hex(v: &str, n: usize) -> bool {
    v.len() == 2 * n
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn unhex(v: &str) -> Result<Vec<u8>> {
    if !v.len().is_multiple_of(2) || !hex(v, v.len() / 2) {
        return Err(ManagedUploadError::InvalidInput);
    }
    Ok(v.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| {
            let n = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
            n(v[0]) * 16 + n(v[1])
        })
        .collect())
}
fn uuid_array(v: &str) -> Result<[u8; 16]> {
    if !uuid(v) {
        return Err(ManagedUploadError::InvalidDocument);
    }
    unhex(&v.replace('-', ""))?
        .try_into()
        .map_err(|_| ManagedUploadError::InvalidDocument)
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
fn https_url(v: &str, origin: bool) -> bool {
    let Some(rest) = v.strip_prefix("https://") else {
        return false;
    };
    if rest.is_empty() || v.bytes().any(|c| c <= 32 || c >= 127) || rest.contains(['@', '#', '\\'])
    {
        return false;
    }
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if authority.is_empty()
        || !authority
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':' | b'[' | b']'))
    {
        return false;
    }
    !origin || rest == authority
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let a = c[0];
        let b = *c.get(1).unwrap_or(&0);
        let d = *c.get(2).unwrap_or(&0);
        s.push(TABLE[(a >> 2) as usize] as char);
        s.push(TABLE[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        s.push(if c.len() > 1 {
            TABLE[(((b & 15) << 2) | (d >> 6)) as usize] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            TABLE[(d & 63) as usize] as char
        } else {
            '='
        });
    }
    s
}
fn document(v: &str, size: usize, expected: Option<&str>) -> Result<Vec<u8>> {
    if v.len() != size.div_ceil(3) * 4 {
        return Err(ManagedUploadError::InvalidDocument);
    }
    let n = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        b'=' => Some(0),
        _ => None,
    };
    let mut out = Vec::with_capacity(size);
    for c in v.as_bytes().as_chunks::<4>().0 {
        let a = n(c[0]).ok_or(ManagedUploadError::InvalidDocument)?;
        let b = n(c[1]).ok_or(ManagedUploadError::InvalidDocument)?;
        let d = n(c[2]).ok_or(ManagedUploadError::InvalidDocument)?;
        let e = n(c[3]).ok_or(ManagedUploadError::InvalidDocument)?;
        out.push((a << 2) | (b >> 4));
        if c[2] != b'=' {
            out.push((b << 4) | (d >> 2));
        }
        if c[3] != b'=' {
            out.push((d << 6) | e);
        }
    }
    if out.len() != size
        || base64(&out) != v
        || expected.is_some_and(|h| !hex(h, 32) || hash(&out) != h)
    {
        return Err(ManagedUploadError::InvalidDocument);
    }
    Ok(out)
}
// RFC3339 UTC/offset parsing is shared policy; hosts supply only their clock.
fn date(v: &str) -> Result<u64> {
    let invalid = || ManagedUploadError::InvalidDocument;
    if v.len() < 20 {
        return Err(invalid());
    }
    let number = |s: &str| {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            Err(invalid())
        } else {
            s.parse::<i64>().map_err(|_| invalid())
        }
    };
    if !v.is_ascii()
        || &v[4..5] != "-"
        || &v[7..8] != "-"
        || &v[10..11] != "T"
        || &v[13..14] != ":"
        || &v[16..17] != ":"
    {
        return Err(invalid());
    }
    let y = number(&v[0..4])?;
    let m = number(&v[5..7])?;
    let d = number(&v[8..10])?;
    let hour = number(&v[11..13])?;
    let minute = number(&v[14..16])?;
    let second = number(&v[17..19])?;
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&m)
        || d < 1
        || d > days[(m - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid());
    }
    let mut tail = &v[19..];
    let mut ms = 0;
    if let Some(part) = tail.strip_prefix('.') {
        let len = part.bytes().take_while(|c| c.is_ascii_digit()).count();
        if len == 0 {
            return Err(invalid());
        }
        let frac = &part[..len];
        let first = &frac[..frac.len().min(3)];
        ms = number(first)? * 10_i64.pow((3 - first.len()) as u32);
        tail = &part[len..];
    }
    let offset = if tail == "Z" {
        0
    } else {
        if tail.len() != 6 || !matches!(&tail[..1], "+" | "-") || &tail[3..4] != ":" {
            return Err(invalid());
        }
        let h = number(&tail[1..3])?;
        let min = number(&tail[4..6])?;
        if h > 23 || min > 59 {
            return Err(invalid());
        }
        (h * 60 + min) * if tail.starts_with('-') { -1 } else { 1 }
    };
    let year = y - i64::from(m <= 2);
    let era = year.div_euclid(400);
    let yo = year - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let day = era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * mp + 2) / 5 + d - 1 - 719468;
    let result = (day * 86400 + hour * 3600 + minute * 60 + second - offset * 60) * 1000 + ms;
    u64::try_from(result).map_err(|_| invalid())
}
fn iso_date(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yo = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yo + era * 400;
    let day = doe - (365 * yo + yo / 4 - yo / 100);
    let mp = (5 * day + 2) / 153;
    let d = day - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    let seconds = (ms / 1000) % 86400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        ms % 1000
    )
}
