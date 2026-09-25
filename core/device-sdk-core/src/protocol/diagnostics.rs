use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol::*,
};

use super::cursor::Cursor;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceDiagnosticsBatch {
    pub schema_version: u8,
    pub events: Vec<DeviceDiagnosticEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceDiagnosticEvent {
    pub event_id: String,
    pub event_type: String,
    pub reason_code: String,
    pub uptime_ms: u32,
    pub signature: String,
    pub firmware_build_id: String,
    pub subsystem: String,
    pub state_before_event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<DiagnosticReport>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticReport {
    pub fault: DiagnosticFault,
    pub execution: DiagnosticExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<DiagnosticRuntime>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breadcrumbs: Vec<DiagnosticBreadcrumb>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticFault {
    pub cpu_id: u8,
    pub cpu_emu: String,
    pub core_emu: String,
    pub hsb_emu: String,
    pub audio_emu: String,
    pub wireless_emu: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticExecution {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rets: Option<String>,
    pub pc_trace: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticRuntime {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_free_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_stack_remaining_bytes: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticBreadcrumb {
    pub delta_ms: i32,
    pub code: String,
    pub arg0: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticCommand<'a> {
    List,
    Acknowledge(&'a str),
}

pub fn encode_diagnostic_command(
    command: DiagnosticCommand<'_>,
) -> Result<Vec<u8>, DeviceSdkError> {
    match command {
        DiagnosticCommand::List => Ok(vec![DEVICE_DIAGNOSTICS_CMD_LIST]),
        DiagnosticCommand::Acknowledge(event_id) => {
            if event_id.len() != 16 || !is_lower_hex(event_id.as_bytes()) {
                return Err(
                    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false)
                        .with_detail("diagnostic event_id must be 16 lowercase hex characters"),
                );
            }
            let id = u64::from_str_radix(event_id, 16).expect("validated 16 hex digits");
            let mut packet = vec![DEVICE_DIAGNOSTICS_CMD_ACK];
            packet.extend(id.to_le_bytes());
            Ok(packet)
        }
    }
}

#[derive(Clone, Debug)]
struct Metadata {
    event_id: String,
    event_type: String,
    reason_code: String,
    uptime_ms: u32,
    signature: Option<String>,
}

#[derive(Clone, Debug)]
struct DetailAssembly {
    bytes: [u8; DIAGNOSTIC_DETAIL_FIXED_LENGTH],
    received: usize,
}

/// One read's assembler. Reset before every new LIST, cancellation, or reconnect.
/// The u8 index bounds each map to 256 entries; detail storage is at most 45,056 bytes.
#[derive(Clone, Debug, Default)]
pub struct DeviceDiagnosticsDecoder {
    events: BTreeMap<u8, Metadata>,
    details: BTreeMap<u8, DetailAssembly>,
}

impl DeviceDiagnosticsDecoder {
    /// Empty input explicitly resets. No event is published before a complete END.
    /// Any malformed diagnostics packet discards the entire pending read.
    pub fn push(
        &mut self,
        packet: &[u8],
    ) -> Result<Option<DeviceDiagnosticsBatch>, DeviceSdkError> {
        if packet.is_empty() {
            self.reset();
            return Ok(None);
        }
        let result = self.push_packet(packet);
        if result.is_err() {
            self.reset();
        }
        result
    }

    pub fn reset(&mut self) {
        self.events.clear();
        self.details.clear();
    }

    fn push_packet(
        &mut self,
        packet: &[u8],
    ) -> Result<Option<DeviceDiagnosticsBatch>, DeviceSdkError> {
        if packet.len() > DIAGNOSTIC_MAX_PACKET_BYTES {
            return Err(invalid("diagnostic packet exceeds 20 bytes"));
        }
        let cursor = Cursor::new(packet);
        match packet[0] {
            DEVICE_DIAGNOSTICS_EVT_META => {
                cursor.require_exact(DIAGNOSTIC_META_FIXED_LENGTH)?;
                let index = cursor.u8(DIAGNOSTIC_META_INDEX_OFFSET)?;
                if self.events.contains_key(&index) {
                    return Err(invalid(
                        "duplicate diagnostic metadata; reset before a new read",
                    ));
                }
                self.events.insert(
                    index,
                    Metadata {
                        event_id: format!(
                            "{:016x}",
                            cursor.u64_le(DIAGNOSTIC_META_EVENT_ID_OFFSET)?
                        ),
                        event_type: event_type(cursor.u8(DIAGNOSTIC_META_EVENT_TYPE_OFFSET)?)?
                            .into(),
                        reason_code: reason(cursor.u16_le(DIAGNOSTIC_META_REASON_OFFSET)?).into(),
                        uptime_ms: cursor.u32_le(DIAGNOSTIC_META_UPTIME_MS_OFFSET)?,
                        signature: None,
                    },
                );
            }
            DEVICE_DIAGNOSTICS_EVT_SIGNATURE => {
                cursor.require_exact(DIAGNOSTIC_SIGNATURE_FIXED_LENGTH)?;
                if let Some(event) = self
                    .events
                    .get_mut(&cursor.u8(DIAGNOSTIC_SIGNATURE_INDEX_OFFSET)?)
                {
                    event.signature = Some(format!(
                        "{:016x}",
                        cursor.u64_le(DIAGNOSTIC_SIGNATURE_SIGNATURE_OFFSET)?
                    ));
                }
            }
            DEVICE_DIAGNOSTICS_EVT_DETAIL => {
                cursor.require(DIAGNOSTIC_DETAIL_CHUNK_MINIMUM_LENGTH)?;
                let index = cursor.u8(DIAGNOSTIC_DETAIL_CHUNK_INDEX_OFFSET)?;
                let offset = usize::from(cursor.u16_le(DIAGNOSTIC_DETAIL_CHUNK_OFFSET_OFFSET)?);
                let total = usize::from(cursor.u16_le(DIAGNOSTIC_DETAIL_CHUNK_TOTAL_OFFSET)?);
                let data = cursor.tail(DIAGNOSTIC_DETAIL_CHUNK_PAYLOAD_OFFSET)?;
                if total != DIAGNOSTIC_DETAIL_FIXED_LENGTH
                    || data.is_empty()
                    || offset + data.len() > total
                {
                    return Err(invalid("invalid diagnostic detail chunk"));
                }
                if offset == 0 {
                    if self.details.contains_key(&index) {
                        return Err(invalid("duplicate diagnostic detail"));
                    }
                    self.details.insert(
                        index,
                        DetailAssembly {
                            bytes: [0; DIAGNOSTIC_DETAIL_FIXED_LENGTH],
                            received: 0,
                        },
                    );
                }
                let detail = self
                    .details
                    .get_mut(&index)
                    .ok_or_else(|| invalid("out-of-order diagnostic detail"))?;
                if detail.received != offset {
                    return Err(invalid("out-of-order diagnostic detail"));
                }
                detail.bytes[offset..offset + data.len()].copy_from_slice(data);
                detail.received += data.len();
                if detail.received == total {
                    if !self.events.contains_key(&index) {
                        return Err(invalid("diagnostic detail without metadata"));
                    }
                    validate_detail(&detail.bytes)?;
                }
            }
            DEVICE_DIAGNOSTICS_EVT_END => {
                cursor.require_exact(DIAGNOSTIC_END_FIXED_LENGTH)?;
                let count = cursor.u8(DIAGNOSTIC_END_COUNT_OFFSET)?;
                let mut pending = std::mem::take(self);
                if pending.events.len() != usize::from(count)
                    || pending.details.len() != usize::from(count)
                {
                    return Err(invalid("diagnostic event count mismatch"));
                }
                let mut events = Vec::with_capacity(usize::from(count));
                for index in 0..count {
                    let meta = pending
                        .events
                        .remove(&index)
                        .ok_or_else(|| invalid("incomplete diagnostic metadata"))?;
                    let detail = pending
                        .details
                        .remove(&index)
                        .filter(|detail| detail.received == DIAGNOSTIC_DETAIL_FIXED_LENGTH)
                        .ok_or_else(|| invalid("incomplete diagnostic detail"))?;
                    let signature = meta
                        .signature
                        .ok_or_else(|| invalid("incomplete diagnostic signature"))?;
                    let cursor = Cursor::new(&detail.bytes);
                    events.push(DeviceDiagnosticEvent {
                        event_id: meta.event_id,
                        event_type: meta.event_type,
                        reason_code: meta.reason_code,
                        uptime_ms: meta.uptime_ms,
                        signature,
                        firmware_build_id: String::from_utf8(
                            cursor
                                .slice(
                                    DIAGNOSTIC_DETAIL_FIRMWARE_BUILD_ID_OFFSET,
                                    DIAGNOSTIC_DETAIL_FIRMWARE_BUILD_ID_WIDTH,
                                )?
                                .to_vec(),
                        )
                        .expect("validated lowercase hex"),
                        subsystem: subsystem(cursor.u8(DIAGNOSTIC_DETAIL_SUBSYSTEM_OFFSET)?).into(),
                        state_before_event: state(cursor.u8(DIAGNOSTIC_DETAIL_STATE_OFFSET)?)
                            .into(),
                        report: decode_report(&cursor)?,
                    });
                }
                return Ok(Some(DeviceDiagnosticsBatch {
                    schema_version: DIAGNOSTIC_DETAIL_VERSION,
                    events,
                }));
            }
            // B07A0007 also carries logs, ACK results, and capability messages.
            _ => {}
        }
        Ok(None)
    }
}

fn validate_detail(bytes: &[u8]) -> Result<(), DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require_exact(DIAGNOSTIC_DETAIL_FIXED_LENGTH)?;
    if cursor.u8(DIAGNOSTIC_DETAIL_VERSION_OFFSET)? != DIAGNOSTIC_DETAIL_VERSION {
        return Err(invalid("unsupported diagnostic detail payload"));
    }
    if !is_lower_hex(cursor.slice(
        DIAGNOSTIC_DETAIL_FIRMWARE_BUILD_ID_OFFSET,
        DIAGNOSTIC_DETAIL_FIRMWARE_BUILD_ID_WIDTH,
    )?) {
        return Err(invalid("invalid diagnostic firmware build id"));
    }
    Ok(())
}

fn decode_report(cursor: &Cursor<'_>) -> Result<Option<DiagnosticReport>, DeviceSdkError> {
    if cursor.u8(DIAGNOSTIC_DETAIL_FLAGS_OFFSET)? & DIAGNOSTIC_DETAIL_HAS_REPORT == 0 {
        return Ok(None);
    }
    let pc_count =
        usize::from(cursor.u8(DIAGNOSTIC_DETAIL_PC_COUNT_OFFSET)?).min(DIAGNOSTIC_MAX_PC_TRACE);
    let breadcrumb_count = usize::from(cursor.u8(DIAGNOSTIC_DETAIL_BREADCRUMB_COUNT_OFFSET)?)
        .min(DIAGNOSTIC_MAX_BREADCRUMBS);
    let mask = cursor.u8(DIAGNOSTIC_DETAIL_RUNTIME_MASK_OFFSET)?;
    let mut pc_trace = Vec::new();
    for index in 0..pc_count {
        if let Some(address) =
            normalized_address(cursor.u32_le(DIAGNOSTIC_DETAIL_PC_TRACE_OFFSET + index * 4)?)
        {
            pc_trace.push(address);
        }
    }
    let mut breadcrumbs = Vec::with_capacity(breadcrumb_count);
    for index in 0..breadcrumb_count {
        let offset =
            DIAGNOSTIC_DETAIL_BREADCRUMBS_OFFSET + index * DIAGNOSTIC_BREADCRUMB_FIXED_LENGTH;
        breadcrumbs.push(DiagnosticBreadcrumb {
            delta_ms: cursor.u32_le(offset + DIAGNOSTIC_BREADCRUMB_DELTA_MS_OFFSET)? as i32,
            code: breadcrumb(cursor.u16_le(offset + DIAGNOSTIC_BREADCRUMB_CODE_OFFSET)?).into(),
            arg0: cursor.u32_le(offset + DIAGNOSTIC_BREADCRUMB_ARG0_OFFSET)? as i32,
        });
    }
    // Node's Buffer ASCII decoding masks the high bit, including before NUL trimming.
    let task: String = cursor
        .slice(DIAGNOSTIC_DETAIL_TASK_OFFSET, DIAGNOSTIC_DETAIL_TASK_WIDTH)?
        .iter()
        .map(|byte| byte & 0x7f)
        .take_while(|byte| *byte != 0)
        .map(char::from)
        .collect();
    Ok(Some(DiagnosticReport {
        fault: DiagnosticFault {
            cpu_id: cursor.u8(DIAGNOSTIC_DETAIL_CPU_ID_OFFSET)?,
            cpu_emu: format!("{:08x}", cursor.u32_le(DIAGNOSTIC_DETAIL_CPU_EMU_OFFSET)?),
            core_emu: format!("{:08x}", cursor.u32_le(DIAGNOSTIC_DETAIL_CORE_EMU_OFFSET)?),
            hsb_emu: format!("{:08x}", cursor.u32_le(DIAGNOSTIC_DETAIL_HSB_EMU_OFFSET)?),
            audio_emu: format!("{:08x}", cursor.u32_le(DIAGNOSTIC_DETAIL_AUDIO_EMU_OFFSET)?),
            wireless_emu: format!(
                "{:08x}",
                cursor.u32_le(DIAGNOSTIC_DETAIL_WIRELESS_EMU_OFFSET)?
            ),
        },
        execution: DiagnosticExecution {
            task: (!task.is_empty()).then_some(task),
            reti: normalized_address(cursor.u32_le(DIAGNOSTIC_DETAIL_RETI_OFFSET)?),
            rets: normalized_address(cursor.u32_le(DIAGNOSTIC_DETAIL_RETS_OFFSET)?),
            pc_trace,
        },
        runtime: if mask & (DIAGNOSTIC_RUNTIME_HEAP_FREE | DIAGNOSTIC_RUNTIME_STACK_REMAINING) != 0
        {
            Some(DiagnosticRuntime {
                heap_free_bytes: (mask & DIAGNOSTIC_RUNTIME_HEAP_FREE != 0)
                    .then(|| cursor.u32_le(DIAGNOSTIC_DETAIL_HEAP_FREE_BYTES_OFFSET))
                    .transpose()?,
                task_stack_remaining_bytes: (mask & DIAGNOSTIC_RUNTIME_STACK_REMAINING != 0)
                    .then(|| cursor.u32_le(DIAGNOSTIC_DETAIL_TASK_STACK_REMAINING_BYTES_OFFSET))
                    .transpose()?,
            })
        } else {
            None
        },
        breadcrumbs,
    }))
}

fn normalized_address(value: u32) -> Option<String> {
    if value == 0 {
        return None;
    }
    let region = if value & 0x80000000 != 0 {
        "sdram"
    } else if value & 0x40000000 != 0 {
        "ram"
    } else {
        "rom"
    };
    Some(format!("{region}:{:08x}", value & 0x3fffffff))
}

fn is_lower_hex(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn event_type(value: u8) -> Result<&'static str, DeviceSdkError> {
    Ok(match value {
        DIAGNOSTIC_EVENT_RESET => "reset",
        DIAGNOSTIC_EVENT_WATCHDOG => "watchdog",
        DIAGNOSTIC_EVENT_HARD_FAULT => "hard_fault",
        DIAGNOSTIC_EVENT_STORAGE => "storage",
        DIAGNOSTIC_EVENT_POWER => "power",
        DIAGNOSTIC_EVENT_RADIO => "radio",
        DIAGNOSTIC_EVENT_SECURITY => "security",
        _ => return Err(invalid("unknown diagnostic event type")),
    })
}

fn reason(value: u16) -> &'static str {
    match value {
        DIAGNOSTIC_REASON_WATCHDOG_TIMEOUT => "watchdog_timeout",
        DIAGNOSTIC_REASON_CPU_ILLEGAL_INSTRUCTION => "cpu_illegal_instruction",
        DIAGNOSTIC_REASON_CPU_MISALIGNED_ACCESS => "cpu_misaligned_access",
        DIAGNOSTIC_REASON_CPU_STACK_OVERFLOW => "cpu_stack_overflow",
        DIAGNOSTIC_REASON_CPU_USAGE_FAULT => "cpu_usage_fault",
        DIAGNOSTIC_REASON_MEMORY_PROTECTION_FAULT => "memory_protection_fault",
        DIAGNOSTIC_REASON_INVALID_REGISTER_READ => "invalid_register_read",
        DIAGNOSTIC_REASON_INVALID_REGISTER_WRITE => "invalid_register_write",
        DIAGNOSTIC_REASON_AUDIO_SUBSYSTEM_FAULT => "audio_subsystem_fault",
        DIAGNOSTIC_REASON_WIRELESS_SUBSYSTEM_FAULT => "wireless_subsystem_fault",
        DIAGNOSTIC_REASON_FLASH_MMU_FAULT => "flash_mmu_fault",
        DIAGNOSTIC_REASON_LOW_VOLTAGE_RESET => "low_voltage_reset",
        _ => "unknown_cpu_exception",
    }
}

fn subsystem(value: u8) -> &'static str {
    match value {
        DIAGNOSTIC_SUBSYSTEM_AUDIO => "audio",
        DIAGNOSTIC_SUBSYSTEM_WIRELESS => "wireless",
        DIAGNOSTIC_SUBSYSTEM_STORAGE => "storage",
        DIAGNOSTIC_SUBSYSTEM_POWER => "power",
        DIAGNOSTIC_SUBSYSTEM_SECURITY => "security",
        _ => "system",
    }
}

fn state(value: u8) -> &'static str {
    match value {
        DIAGNOSTIC_STATE_BOOT => "boot",
        DIAGNOSTIC_STATE_DEEP_STANDBY => "deep_standby",
        DIAGNOSTIC_STATE_RECORDING => "recording",
        DIAGNOSTIC_STATE_UPLOAD_PREPARING => "upload_preparing",
        DIAGNOSTIC_STATE_UPLOADING => "uploading",
        DIAGNOSTIC_STATE_ERROR_RECOVERY => "error_recovery",
        DIAGNOSTIC_STATE_FULL_SLEEP => "full_sleep",
        _ => "unknown",
    }
}

fn breadcrumb(value: u16) -> &'static str {
    match value {
        DIAGNOSTIC_BREADCRUMB_BOOT => "boot",
        DIAGNOSTIC_BREADCRUMB_STANDBY_ENTERED => "standby_entered",
        DIAGNOSTIC_BREADCRUMB_RECORDING_STARTED => "recording_started",
        DIAGNOSTIC_BREADCRUMB_UPLOAD_PREPARING => "upload_preparing",
        DIAGNOSTIC_BREADCRUMB_UPLOAD_STARTED => "upload_started",
        DIAGNOSTIC_BREADCRUMB_ERROR_RECOVERY => "error_recovery",
        DIAGNOSTIC_BREADCRUMB_FULL_SLEEP => "full_sleep",
        _ => "state_changed",
    }
}

fn invalid(detail: &str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}
