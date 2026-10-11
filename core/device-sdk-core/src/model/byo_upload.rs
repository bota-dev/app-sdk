//! Transport-independent BYO recovery. Native hosts persist each returned state
//! before starting its external effect; this module does not authorize keys,
//! install trust, verify signatures or delete files.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ByoEnvironment {
    Development,
    Gamma,
    Production,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByoCapture {
    pub environment: ByoEnvironment,
    pub organization_id: String,
    pub project_id: String,
    pub device_id: String,
    pub binding_generation: u32,
    pub device_assignment_generation: u32,
    pub policy_revision: String,
    pub recording_uuid: String,
    pub recording_generation: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByoRoute {
    pub recording_id: String,
    pub configuration_id: String,
    pub configuration_revision: u32,
    pub configuration_sha256: String,
    pub destination_ref: String,
    pub session_id: String,
    pub owner_revision: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ByoPhase {
    New,
    WebSocket,
    HttpSegments,
    WaitingForSource,
    FencePending,
    HttpWholeFile,
    Verifying,
    ReceiptVerified,
    CleanupPending,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ByoTransport {
    WebSocket,
    HttpSegments,
    WholeFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ByoHandoffMode {
    Assembled,
    WholeFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ByoRetryAction {
    ReconnectAfterMs(u32),
    WaitForCompleteSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ByoRecoveryError {
    InvalidState,
    IdentityConflict,
    SourceUnavailable,
    ReceiptMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByoRecovery {
    pub version: u32,
    pub capture: ByoCapture,
    pub route: Option<ByoRoute>,
    pub phase: ByoPhase,
    pub ws_retries: u8,
    pub source_length: Option<u64>,
    pub source_sha256: Option<String>,
    pub pending_operation: Option<String>,
    pub handoff_mode: Option<ByoHandoffMode>,
    pub receipt_sha256: Option<String>,
    #[serde(default)]
    pub renewal_revision: u32,
    #[serde(default)]
    pub renewal_operation: Option<String>,
}

fn id(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
impl ByoRoute {
    fn valid(&self) -> bool {
        id(&self.recording_id)
            && uuid(&self.configuration_id)
            && self.configuration_revision > 0
            && hash(&self.configuration_sha256)
            && id(&self.destination_ref)
            && uuid(&self.session_id)
            && self.owner_revision > 0
    }
    fn same_destination(&self, other: &Self) -> bool {
        self.recording_id == other.recording_id
            && self.configuration_id == other.configuration_id
            && self.configuration_revision == other.configuration_revision
            && self.configuration_sha256 == other.configuration_sha256
            && self.destination_ref == other.destination_ref
    }
}

impl ByoRecovery {
    pub fn new(capture: ByoCapture) -> Result<Self, ByoRecoveryError> {
        let state = Self {
            version: 1,
            capture,
            route: None,
            phase: ByoPhase::New,
            ws_retries: 0,
            source_length: None,
            source_sha256: None,
            pending_operation: None,
            handoff_mode: None,
            receipt_sha256: None,
            renewal_revision: 0,
            renewal_operation: None,
        };
        state.validate()?;
        Ok(state)
    }

    pub fn validate(&self) -> Result<(), ByoRecoveryError> {
        if self.version != 1
            || !id(&self.capture.organization_id)
            || !id(&self.capture.project_id)
            || !id(&self.capture.device_id)
            || self.capture.binding_generation == 0
            || self.capture.device_assignment_generation == 0
            || self
                .capture
                .policy_revision
                .parse::<u64>()
                .ok()
                .is_none_or(|n| n == 0 || n.to_string() != self.capture.policy_revision)
            || !uuid(&self.capture.recording_uuid)
            || self.capture.recording_generation == 0
            || self.ws_retries > 3
            || self.renewal_revision == u32::MAX
            || self.renewal_operation.as_ref().is_some_and(|s| !uuid(s))
            || (self.renewal_operation.is_some()
                && matches!(self.phase, ByoPhase::New | ByoPhase::Complete))
            || self.route.as_ref().is_some_and(|r| !r.valid())
            || (self.phase != ByoPhase::New && self.route.is_none())
            || (self.phase == ByoPhase::New && self.route.is_some())
            || (self.source_length.is_some() != self.source_sha256.is_some())
            || self
                .source_length
                .is_some_and(|n| !(293..=134_217_728).contains(&n))
            || self.source_sha256.as_ref().is_some_and(|s| !hash(s))
            || self.pending_operation.as_ref().is_some_and(|s| !id(s))
            || self.receipt_sha256.as_ref().is_some_and(|s| !hash(s))
            || (self.pending_operation.is_some() != (self.phase == ByoPhase::FencePending))
            || (self.handoff_mode.is_some() != (self.phase == ByoPhase::FencePending))
            || (self.receipt_sha256.is_some()
                != matches!(
                    self.phase,
                    ByoPhase::ReceiptVerified | ByoPhase::CleanupPending | ByoPhase::Complete
                ))
            || (self.phase == ByoPhase::FencePending
                && (self.pending_operation.is_none() || self.source_length.is_none()))
            || (matches!(
                self.phase,
                ByoPhase::HttpWholeFile
                    | ByoPhase::Verifying
                    | ByoPhase::ReceiptVerified
                    | ByoPhase::CleanupPending
                    | ByoPhase::Complete
            ) && self.source_length.is_none())
            || (matches!(
                self.phase,
                ByoPhase::ReceiptVerified | ByoPhase::CleanupPending | ByoPhase::Complete
            ) && self.receipt_sha256.is_none())
        {
            return Err(ByoRecoveryError::InvalidState);
        }
        Ok(())
    }

    pub fn authorize(&self, capture: &ByoCapture) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if &self.capture != capture {
            return Err(ByoRecoveryError::IdentityConflict);
        }
        Ok(())
    }

    /// Persist before POST /recover. An uncertain reply retries this exact UUID
    /// and revision; it must not create a second server retry window.
    pub fn begin_renewal(
        &mut self,
        operation: String,
        expected_revision: u32,
    ) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.route.is_none()
            || self.phase == ByoPhase::Complete
            || !uuid(&operation)
            || expected_revision != self.renewal_revision
            || expected_revision >= u32::MAX - 1
        {
            return Err(ByoRecoveryError::InvalidState);
        }
        if let Some(prior) = &self.renewal_operation {
            return if prior == &operation {
                Ok(())
            } else {
                Err(ByoRecoveryError::IdentityConflict)
            };
        }
        self.renewal_operation = Some(operation);
        Ok(())
    }

    /// Native code authenticates the same-session reply and stores its signed
    /// permit before this acknowledgement. Renewal is never cleanup evidence.
    pub fn renewal_committed(
        &mut self,
        operation: &str,
        revision: u32,
    ) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.renewal_operation.as_deref() != Some(operation)
            || self.renewal_revision.checked_add(1) != Some(revision)
        {
            return Err(ByoRecoveryError::IdentityConflict);
        }
        self.renewal_revision = revision;
        self.renewal_operation = None;
        Ok(())
    }

    /// A restarted socket is not the owner of the previous stream. Preserve any
    /// pending fence/receipt and reconcile it before scheduling another effect.
    pub fn after_restart(&mut self) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if matches!(self.phase, ByoPhase::WebSocket | ByoPhase::HttpSegments) {
            self.phase = ByoPhase::WaitingForSource;
        }
        Ok(())
    }

    pub fn bind(&mut self, route: ByoRoute, websocket: bool) -> Result<(), ByoRecoveryError> {
        self.bind_transport(
            route,
            if websocket {
                ByoTransport::WebSocket
            } else {
                ByoTransport::WholeFile
            },
        )
    }

    pub fn bind_transport(
        &mut self,
        route: ByoRoute,
        transport: ByoTransport,
    ) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.phase != ByoPhase::New || self.route.is_some() || !route.valid() {
            return Err(ByoRecoveryError::IdentityConflict);
        }
        if transport == ByoTransport::WholeFile && self.source_length.is_none() {
            return Err(ByoRecoveryError::SourceUnavailable);
        }
        self.route = Some(route);
        self.phase = match transport {
            ByoTransport::WebSocket => ByoPhase::WebSocket,
            ByoTransport::HttpSegments => ByoPhase::HttpSegments,
            ByoTransport::WholeFile => ByoPhase::HttpWholeFile,
        };
        Ok(())
    }

    pub fn ws_failed(&mut self) -> Result<ByoRetryAction, ByoRecoveryError> {
        self.validate()?;
        if self.phase != ByoPhase::WebSocket {
            return Err(ByoRecoveryError::InvalidState);
        }
        if self.ws_retries < 3 {
            let delay = [1_000, 2_000, 4_000][usize::from(self.ws_retries)];
            self.ws_retries += 1;
            Ok(ByoRetryAction::ReconnectAfterMs(delay))
        } else {
            self.phase = ByoPhase::WaitingForSource;
            Ok(ByoRetryAction::WaitForCompleteSource)
        }
    }

    pub fn source_finalized(&mut self, bytes: u64, digest: String) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if !(293..=134_217_728).contains(&bytes) || !hash(&digest) {
            return Err(ByoRecoveryError::SourceUnavailable);
        }
        if self.source_length.is_some()
            && (self.source_length != Some(bytes) || self.source_sha256.as_ref() != Some(&digest))
        {
            return Err(ByoRecoveryError::IdentityConflict);
        }
        self.source_length = Some(bytes);
        self.source_sha256 = Some(digest);
        Ok(())
    }

    pub fn begin_fallback(&mut self, operation: String) -> Result<(), ByoRecoveryError> {
        self.begin_handoff(operation, ByoHandoffMode::WholeFile)
    }

    pub fn begin_handoff(
        &mut self,
        operation: String,
        mode: ByoHandoffMode,
    ) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        let phase_allowed = match mode {
            ByoHandoffMode::WholeFile => self.phase == ByoPhase::WaitingForSource,
            ByoHandoffMode::Assembled => {
                matches!(self.phase, ByoPhase::WebSocket | ByoPhase::HttpSegments)
            }
        };
        if !phase_allowed
            || self.source_length.is_none()
            || !id(&operation)
            || self.renewal_operation.is_some()
        {
            return Err(ByoRecoveryError::SourceUnavailable);
        }
        self.pending_operation = Some(operation);
        self.handoff_mode = Some(mode);
        self.phase = ByoPhase::FencePending;
        Ok(())
    }

    /// Call only after the native backend adapter authenticates the committed
    /// handoff response. A pending/unknown fence is never successor authority.
    pub fn accept_handoff(
        &mut self,
        operation: &str,
        successor: ByoRoute,
    ) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        let previous = self.route.as_ref().ok_or(ByoRecoveryError::InvalidState)?;
        if self.phase != ByoPhase::FencePending
            || self.renewal_operation.is_some()
            || self.pending_operation.as_deref() != Some(operation)
            || !successor.valid()
            || !previous.same_destination(&successor)
            || previous.owner_revision.checked_add(1) != Some(successor.owner_revision)
            || previous.session_id == successor.session_id
        {
            return Err(ByoRecoveryError::IdentityConflict);
        }
        self.route = Some(successor);
        self.renewal_revision = 0;
        self.pending_operation = None;
        self.phase = match self.handoff_mode.take() {
            Some(ByoHandoffMode::Assembled) => ByoPhase::Verifying,
            _ => ByoPhase::HttpWholeFile,
        };
        Ok(())
    }

    pub fn upload_offset(&self) -> u64 {
        0
    }

    pub fn verification_pending(&mut self) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.phase != ByoPhase::HttpWholeFile
            || self.source_length.is_none()
            || self.renewal_operation.is_some()
        {
            return Err(ByoRecoveryError::InvalidState);
        }
        self.phase = ByoPhase::Verifying;
        Ok(())
    }

    /// Native code must verify the signature, exact context, accepted manifest,
    /// trust domain and expiry first. A status string is not receipt evidence.
    pub fn receipt_verified(&mut self, digest: String) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.phase != ByoPhase::Verifying || !hash(&digest) || self.renewal_operation.is_some() {
            return Err(ByoRecoveryError::ReceiptMismatch);
        }
        self.receipt_sha256 = Some(digest);
        self.phase = ByoPhase::ReceiptVerified;
        Ok(())
    }

    pub fn receipt_persisted(&mut self, digest: &str) -> Result<(), ByoRecoveryError> {
        self.validate()?;
        if self.phase != ByoPhase::ReceiptVerified
            || self.receipt_sha256.as_deref() != Some(digest)
            || self.renewal_operation.is_some()
        {
            return Err(ByoRecoveryError::ReceiptMismatch);
        }
        self.phase = ByoPhase::CleanupPending;
        Ok(())
    }

    pub fn may_cleanup(&self) -> bool {
        self.validate().is_ok()
            && self.phase == ByoPhase::CleanupPending
            && self.renewal_operation.is_none()
    }
    pub fn cleanup_finished(&mut self) -> Result<(), ByoRecoveryError> {
        if !self.may_cleanup() {
            return Err(ByoRecoveryError::InvalidState);
        }
        self.phase = ByoPhase::Complete;
        Ok(())
    }
}

/// Metadata-only native ABI request. Signature verification, authenticated
/// backend replies and durable storage remain native host responsibilities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByoRecoveryRequest {
    pub checkpoint: Option<ByoRecovery>,
    pub current_capture: ByoCapture,
    pub event: ByoRecoveryEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ByoRecoveryEvent {
    Create,
    Inspect,
    Restart,
    Bind {
        route: ByoRoute,
        transport: ByoTransport,
    },
    WebSocketFailed,
    StreamUnavailable,
    SourceFinalized {
        bytes: u64,
        sha256: String,
    },
    BeginHandoff {
        operation: String,
        mode: ByoHandoffMode,
    },
    HandoffCommitted {
        operation: String,
        successor: ByoRoute,
    },
    VerificationPending,
    ReceiptVerified {
        sha256: String,
    },
    ReceiptPersisted {
        sha256: String,
    },
    CleanupFinished,
    BeginRenewal {
        operation: String,
        expected_revision: u32,
    },
    RenewalCommitted {
        operation: String,
        revision: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByoRecoveryReply {
    pub checkpoint: ByoRecovery,
    pub retry_after_ms: Option<u32>,
    pub may_cleanup: bool,
}

impl ByoRecoveryRequest {
    pub fn reduce(&self) -> Result<ByoRecoveryReply, ByoRecoveryError> {
        let mut next = match &self.checkpoint {
            Some(state) => {
                state.authorize(&self.current_capture)?;
                state.clone()
            }
            None if matches!(self.event, ByoRecoveryEvent::Create) => {
                ByoRecovery::new(self.current_capture.clone())?
            }
            None => return Err(ByoRecoveryError::InvalidState),
        };
        let mut retry_after_ms = None;
        match &self.event {
            ByoRecoveryEvent::Create if self.checkpoint.is_none() => (),
            ByoRecoveryEvent::Create => return Err(ByoRecoveryError::InvalidState),
            ByoRecoveryEvent::Inspect => (),
            ByoRecoveryEvent::Restart => next.after_restart()?,
            ByoRecoveryEvent::Bind { route, transport } => {
                next.bind_transport(route.clone(), *transport)?
            }
            ByoRecoveryEvent::WebSocketFailed => {
                if let ByoRetryAction::ReconnectAfterMs(delay) = next.ws_failed()? {
                    retry_after_ms = Some(delay);
                }
            }
            ByoRecoveryEvent::StreamUnavailable => {
                if !matches!(next.phase, ByoPhase::WebSocket | ByoPhase::HttpSegments) {
                    return Err(ByoRecoveryError::InvalidState);
                }
                next.phase = ByoPhase::WaitingForSource;
            }
            ByoRecoveryEvent::SourceFinalized { bytes, sha256 } => {
                next.source_finalized(*bytes, sha256.clone())?
            }
            ByoRecoveryEvent::BeginHandoff { operation, mode } => {
                next.begin_handoff(operation.clone(), *mode)?
            }
            ByoRecoveryEvent::HandoffCommitted {
                operation,
                successor,
            } => next.accept_handoff(operation, successor.clone())?,
            ByoRecoveryEvent::VerificationPending => next.verification_pending()?,
            ByoRecoveryEvent::ReceiptVerified { sha256 } => {
                next.receipt_verified(sha256.clone())?
            }
            ByoRecoveryEvent::ReceiptPersisted { sha256 } => next.receipt_persisted(sha256)?,
            ByoRecoveryEvent::CleanupFinished => next.cleanup_finished()?,
            ByoRecoveryEvent::BeginRenewal {
                operation,
                expected_revision,
            } => next.begin_renewal(operation.clone(), *expected_revision)?,
            ByoRecoveryEvent::RenewalCommitted {
                operation,
                revision,
            } => next.renewal_committed(operation, *revision)?,
        }
        next.validate()?;
        Ok(ByoRecoveryReply {
            may_cleanup: next.may_cleanup(),
            checkpoint: next,
            retry_after_ms,
        })
    }
}
