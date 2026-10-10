//! Bounded, versioned native checkpoint. Contains metadata only; native hosts
//! persist it atomically before acting. Not an authorization or a BLE document.
use super::{
    ByoCapture, ByoEnvironment, ByoHandoffMode, ByoPhase, ByoRecovery, ByoRecoveryError, ByoRoute,
};

const INVALID: ByoRecoveryError = ByoRecoveryError::InvalidState;
fn text(out: &mut Vec<u8>, value: &str) {
    out.push(value.len() as u8);
    out.extend_from_slice(value.as_bytes());
}
fn num(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}
struct Reader<'a>(&'a [u8]);
impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> Result<&[u8], ByoRecoveryError> {
        if n > self.0.len() {
            return Err(INVALID);
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Ok(head)
    }
    fn byte(&mut self) -> Result<u8, ByoRecoveryError> {
        Ok(self.bytes(1)?[0])
    }
    fn num(&mut self) -> Result<u32, ByoRecoveryError> {
        Ok(u32::from_be_bytes(
            self.bytes(4)?.try_into().map_err(|_| INVALID)?,
        ))
    }
    fn text(&mut self) -> Result<String, ByoRecoveryError> {
        let n = usize::from(self.byte()?);
        if n > 128 {
            return Err(INVALID);
        }
        Ok(std::str::from_utf8(self.bytes(n)?)
            .map_err(|_| INVALID)?
            .to_owned())
    }
    fn flag(&mut self) -> Result<bool, ByoRecoveryError> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(INVALID),
        }
    }
}
impl ByoRecovery {
    pub fn phase_code(&self) -> u8 {
        match self.phase {
            ByoPhase::New => 0,
            ByoPhase::WebSocket => 1,
            ByoPhase::HttpSegments => 2,
            ByoPhase::WaitingForSource => 3,
            ByoPhase::FencePending => 4,
            ByoPhase::HttpWholeFile => 5,
            ByoPhase::Verifying => 6,
            ByoPhase::ReceiptVerified => 7,
            ByoPhase::CleanupPending => 8,
            ByoPhase::Complete => 9,
        }
    }
    pub fn encode_checkpoint(&self) -> Result<Vec<u8>, ByoRecoveryError> {
        self.validate()?;
        let mut out = b"BYOR\x02".to_vec();
        out.push(self.phase_code());
        out.push(self.ws_retries);
        out.push(match self.capture.environment {
            ByoEnvironment::Development => 0,
            ByoEnvironment::Gamma => 1,
            ByoEnvironment::Production => 2,
        });
        for s in [
            &self.capture.organization_id,
            &self.capture.project_id,
            &self.capture.device_id,
        ] {
            text(&mut out, s);
        }
        num(&mut out, self.capture.binding_generation);
        num(&mut out, self.capture.device_assignment_generation);
        text(&mut out, &self.capture.policy_revision);
        text(&mut out, &self.capture.recording_uuid);
        num(&mut out, self.capture.recording_generation);
        out.push(u8::from(self.route.is_some()));
        if let Some(r) = &self.route {
            text(&mut out, &r.recording_id);
            text(&mut out, &r.configuration_id);
            num(&mut out, r.configuration_revision);
            text(&mut out, &r.configuration_sha256);
            text(&mut out, &r.destination_ref);
            text(&mut out, &r.session_id);
            num(&mut out, r.owner_revision);
        }
        out.push(u8::from(self.source_length.is_some()));
        if let (Some(n), Some(hash)) = (self.source_length, &self.source_sha256) {
            out.extend_from_slice(&n.to_be_bytes());
            text(&mut out, hash);
        }
        out.push(u8::from(self.pending_operation.is_some()));
        if let Some(op) = &self.pending_operation {
            text(&mut out, op);
            out.push(match self.handoff_mode {
                Some(ByoHandoffMode::Assembled) => 1,
                _ => 2,
            });
        }
        out.push(u8::from(self.receipt_sha256.is_some()));
        if let Some(hash) = &self.receipt_sha256 {
            text(&mut out, hash);
        }
        num(&mut out, self.renewal_revision);
        out.push(u8::from(self.renewal_operation.is_some()));
        if let Some(operation) = &self.renewal_operation {
            text(&mut out, operation);
        }
        Ok(out)
    }
    pub fn decode_checkpoint(bytes: &[u8]) -> Result<Self, ByoRecoveryError> {
        if bytes.len() > 2048 {
            return Err(INVALID);
        }
        let mut r = Reader(bytes);
        if r.bytes(4)? != b"BYOR" {
            return Err(INVALID);
        }
        let format = r.byte()?;
        if format != 1 && format != 2 {
            return Err(INVALID);
        }
        let phase = match r.byte()? {
            0 => ByoPhase::New,
            1 => ByoPhase::WebSocket,
            2 => ByoPhase::HttpSegments,
            3 => ByoPhase::WaitingForSource,
            4 => ByoPhase::FencePending,
            5 => ByoPhase::HttpWholeFile,
            6 => ByoPhase::Verifying,
            7 => ByoPhase::ReceiptVerified,
            8 => ByoPhase::CleanupPending,
            9 => ByoPhase::Complete,
            _ => return Err(INVALID),
        };
        let ws_retries = r.byte()?;
        let environment = match r.byte()? {
            0 => ByoEnvironment::Development,
            1 => ByoEnvironment::Gamma,
            2 => ByoEnvironment::Production,
            _ => return Err(INVALID),
        };
        let capture = ByoCapture {
            environment,
            organization_id: r.text()?,
            project_id: r.text()?,
            device_id: r.text()?,
            binding_generation: r.num()?,
            device_assignment_generation: r.num()?,
            policy_revision: r.text()?,
            recording_uuid: r.text()?,
            recording_generation: r.num()?,
        };
        let route = if r.flag()? {
            Some(ByoRoute {
                recording_id: r.text()?,
                configuration_id: r.text()?,
                configuration_revision: r.num()?,
                configuration_sha256: r.text()?,
                destination_ref: r.text()?,
                session_id: r.text()?,
                owner_revision: r.num()?,
            })
        } else {
            None
        };
        let (source_length, source_sha256) = if r.flag()? {
            (
                Some(u64::from_be_bytes(
                    r.bytes(8)?.try_into().map_err(|_| INVALID)?,
                )),
                Some(r.text()?),
            )
        } else {
            (None, None)
        };
        let (pending_operation, handoff_mode) = if r.flag()? {
            let op = r.text()?;
            let mode = match r.byte()? {
                1 => ByoHandoffMode::Assembled,
                2 => ByoHandoffMode::WholeFile,
                _ => return Err(INVALID),
            };
            (Some(op), Some(mode))
        } else {
            (None, None)
        };
        let receipt_sha256 = if r.flag()? { Some(r.text()?) } else { None };
        let renewal_revision = if format == 2 { r.num()? } else { 0 };
        let renewal_operation = if format == 2 && r.flag()? {
            Some(r.text()?)
        } else {
            None
        };
        if !r.0.is_empty() {
            return Err(INVALID);
        }
        let state = Self {
            version: 1,
            capture,
            route,
            phase,
            ws_retries,
            source_length,
            source_sha256,
            pending_operation,
            handoff_mode,
            receipt_sha256,
            renewal_revision,
            renewal_operation,
        };
        state.validate()?;
        Ok(state)
    }
}
