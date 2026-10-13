//! Compatibility file/queue policy compiled into the OTA JavaScript bundle.
use crate::{
    codecs::{input, public_output},
    engine::invalid,
};
use bota_device_sdk_core::error::DeviceSdkError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const SAFE: u64 = 9_007_199_254_740_991;
const FIELDS: &[&str] = &[
    "id",
    "recordingId",
    "deviceId",
    "recordingUuid",
    "localPath",
    "status",
    "retryCount",
    "createdAt",
    "updatedAt",
    "recoveryScope",
    "fileSizeBytes",
    "nextAttemptAt",
    "contentType",
    "contentSha256",
    "relayUpload",
    "completionPending",
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadRequest {
    task_id: String,
    recording_id: String,
    device_id: String,
    local_path: String,
    upload_url: String,
    file_size_bytes: Option<f64>,
    upload_token: Option<String>,
    complete_url: Option<String>,
    content_type: Option<String>,
    content_sha256: Option<String>,
    relay_url: Option<String>,
    relay_bearer_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct File {
    local_path: String,
    durable_units: String,
    kind: String,
    scope: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    request: UploadRequest,
    file: File,
    namespace: String,
}
#[derive(Deserialize)]
struct Queue {
    tasks: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release {
    tasks: Value,
    task_id: String,
    local_path: String,
    file: File,
    namespace: String,
    journal_write_uncertain: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    status: u16,
    response_json: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lookup {
    tasks: Value,
    task_id: String,
    local_path: String,
    recording_id: Option<String>,
    device_id: Option<String>,
    #[serde(default)]
    completed_only: bool,
    #[serde(default)]
    journal_write_uncertain: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    completed_bytes: String,
    total_bytes: String,
    expected_bytes: String,
    previous_bytes: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueFailure {
    now_ms: f64,
    created_at_ms: f64,
    retry_count: f64,
    has_provider: bool,
    credential_unavailable: bool,
    aborted: bool,
    verification_pending: bool,
    completion_pending: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueRoute {
    already_uploaded: bool,
    completion_pending: bool,
    reupload_required: bool,
    route_changed: bool,
    has_complete: bool,
    has_provider: bool,
    relay: bool,
    complete_url_and_token: bool,
    recording_id: Option<String>,
    expected_recording_id: Option<String>,
    recovery_scope: Option<String>,
    expected_recovery_scope: Option<String>,
    expires_at_ms: Option<f64>,
    now_ms: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadCredentials {
    has_credentials: bool,
    has_provider: bool,
    aborted: bool,
    completion_pending: bool,
    already_uploaded: bool,
    target_present: bool,
    expires_at_ms: Option<f64>,
    now_ms: f64,
    has_recording_uuid: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecording {
    task_recording_id: String,
    task_relay_upload: bool,
    task_completion_pending: bool,
    task_file_size_bytes: Option<f64>,
    task_content_sha256: Option<String>,
    recording_id: String,
    status: String,
    recording_file_size_bytes: Value,
    recording_content_sha256: Option<String>,
    started_at_ms: Option<f64>,
    ended_at_ms: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueSchedule {
    status: String,
    local_path: String,
    active: bool,
    cancelled: bool,
    has_credentials: bool,
    has_provider: bool,
    active_count: u32,
    next_attempt_at: Option<f64>,
    now_ms: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionPoll {
    stage: String,
    elapsed_ms: f64,
    poll: u32,
    random_fraction: f64,
    status: u16,
    code: String,
}

pub(crate) fn supports(name: &str) -> bool {
    matches!(
        name,
        "planCompatibilityUploadQueueFailure"
            | "planCompatibilityUploadQueueRoute"
            | "planCompatibilityUploadCredentials"
            | "planUploadRecoveryRecording"
            | "planCompatibilityUploadQueueSchedule"
            | "planUploadCompletionPoll"
            | "planRecordingFileUpload"
            | "sanitizeCompatibilityUploadQueue"
            | "releaseRecordingFileAdmission"
            | "recordingFileUploadResponse"
            | "recordingFileLookupAdmission"
            | "recordingFileUploadProgress"
    )
}
#[inline(never)]
pub(crate) fn call(name: &str, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
    match name {
        "planCompatibilityUploadQueueFailure" => {
            let p: QueueFailure = input(value)?;
            if !integer(p.now_ms)
                || !p.created_at_ms.is_finite()
                || p.created_at_ms.abs() > SAFE as f64
                || p.created_at_ms.fract() != 0.0
                || !integer(p.retry_count)
            {
                return Err(invalid("invalid queue retry evidence"));
            }
            let parked = p.credential_unavailable || p.aborted || p.verification_pending;
            let retry =
                p.has_provider && p.retry_count < 6.0 && p.now_ms - p.created_at_ms < 86_400_000.0;
            let count = p.retry_count + if parked { 0.0 } else { 1.0 };
            if !integer(count) {
                return Err(invalid("queue retry count exceeds its bound"));
            }
            let delays = [30_000.0, 120_000.0, 600_000.0, 3_600_000.0, 14_400_000.0];
            let next = if parked {
                Some(p.now_ms + 30_000.0)
            } else if retry {
                Some(p.now_ms + delays[(p.retry_count as usize).min(4)])
            } else {
                None
            };
            if next.is_some_and(|v| !integer(v)) {
                return Err(invalid("queue retry deadline exceeds its bound"));
            }
            public_output(
                json!({"parked":parked,"status":if parked||retry{"pending"}else{"failed"},"retryCount":count,
                "nextAttemptAt":next,"errorMessage":if p.verification_pending{"Upload verification pending"}else if parked{"Upload waiting for its original account"}else{"Upload attempt failed"},
                "completionPending":if p.verification_pending{Some(true)}else{p.completion_pending}}),
            )
        }
        "planCompatibilityUploadQueueRoute" => {
            let p: QueueRoute = input(value)?;
            if p.recording_id != p.expected_recording_id
                || p.recovery_scope != p.expected_recovery_scope
            {
                return Err(invalid("Upload recovery identity changed"));
            }
            if p.now_ms.is_some_and(|v| !integer(v)) || p.expires_at_ms.is_some_and(|v| !clock(v)) {
                return Err(invalid("invalid upload credential clock"));
            }
            let required = !p.already_uploaded && (!p.completion_pending || p.reupload_required);
            if required && p.route_changed {
                return Err(invalid("Upload recovery route changed"));
            }
            if p.completion_pending && !p.has_complete {
                return Err(invalid(
                    "Pending upload requires durable host completion acknowledgement",
                ));
            }
            if required
                && p.expires_at_ms
                    .zip(p.now_ms)
                    .is_some_and(|(expiry, now)| expiry <= now)
            {
                return Err(invalid("Upload credentials expired"));
            }
            public_output(
                json!({"uploadRequired":required,"missingCompletionAcknowledgement":!p.has_complete
                &&(p.already_uploaded||(p.has_provider&&!p.relay&&!p.complete_url_and_token))}),
            )
        }
        "planCompatibilityUploadCredentials" => {
            let p: UploadCredentials = input(value)?;
            if !integer(p.now_ms) || p.expires_at_ms.is_some_and(|v| !clock(v)) {
                return Err(invalid("invalid upload credential clock"));
            }
            let expired = p.expires_at_ms.is_some_and(|v| v <= p.now_ms);
            public_output(
                json!({"refresh":p.has_credentials && p.has_provider && !p.aborted
                && (p.completion_pending || (!p.already_uploaded && (!p.target_present || expired))),
                "recoveryAllowed":p.has_provider && p.has_recording_uuid}),
            )
        }
        "planUploadRecoveryRecording" => recovery_recording(input(value)?),
        "planCompatibilityUploadQueueSchedule" => {
            let p: QueueSchedule = input(value)?;
            if !integer(p.now_ms) || p.next_attempt_at.is_some_and(|v| !integer(v)) {
                return Err(invalid("invalid queue scheduling clock"));
            }
            let (action, wake) = if p.status != "pending"
                || p.local_path.is_empty()
                || p.active
                || p.cancelled
                || (!p.has_provider && !p.has_credentials)
            {
                ("skip", None)
            } else if p.next_attempt_at.is_some_and(|v| v > p.now_ms) {
                ("wait", p.next_attempt_at)
            } else if p.active_count >= 2 {
                ("skip", None)
            } else {
                ("run", None)
            };
            public_output(json!({"action":action,"wakeAt":wake}))
        }
        "planUploadCompletionPoll" => {
            let p: CompletionPoll = input(value)?;
            if !p.elapsed_ms.is_finite()
                || p.elapsed_ms.abs() > SAFE as f64
                || p.elapsed_ms.fract() != 0.0
                || !p.random_fraction.is_finite()
                || !(0.0..1.0).contains(&p.random_fraction)
            {
                return Err(invalid("invalid completion polling evidence"));
            }
            let exact = p.status == 425 && p.code == "upload_verification_pending";
            let exhausted = if p.stage == "before" {
                p.poll > 0 && (p.elapsed_ms >= 120_000.0 || p.poll >= 120)
            } else if p.stage == "response" {
                exact && p.elapsed_ms >= 120_000.0
            } else {
                return Err(invalid("invalid completion polling stage"));
            };
            let wait = if p.stage == "response" && exact && !exhausted {
                Some((1000.0 + (p.random_fraction * 1000.0).floor()).min(120_000.0 - p.elapsed_ms))
            } else {
                None
            };
            public_output(json!({"verificationPending":exact,"exhausted":exhausted,"waitMs":wait}))
        }
        "recordingFileUploadProgress" => {
            let p: Progress = input(value)?;
            let completed = decimal(&p.completed_bytes)?;
            let total = decimal(&p.total_bytes)?;
            if total != decimal(&p.expected_bytes)?
                || completed < decimal(&p.previous_bytes)?
                || completed > total
            {
                return Err(invalid("invalid recording upload progress evidence"));
            }
            public_output(json!({"completedBytes":completed,"totalBytes":total}))
        }
        "planRecordingFileUpload" => plan(input(value)?),
        "sanitizeCompatibilityUploadQueue" => public_output(clean(input::<Queue>(value)?.tasks)?),
        "releaseRecordingFileAdmission" => {
            let r: Release = input(value)?;
            owned(&r.file, &r.namespace, &r.local_path)?;
            if r.journal_write_uncertain {
                return Err(invalid(
                    "recording release requires durable journal completion",
                ));
            }
            let tasks = clean(r.tasks)?;
            if !tasks.as_array().unwrap().iter().any(|v| {
                v["id"] == r.task_id && v["localPath"] == r.local_path && v["status"] == "completed"
            }) {
                return Err(invalid(
                    "recording release requires exact durable completion",
                ));
            }
            public_output(json!({"allowed":true}))
        }
        "recordingFileLookupAdmission" => {
            let r: Lookup = input(value)?;
            if r.journal_write_uncertain {
                return Err(invalid(
                    "recording release requires durable journal completion",
                ));
            }
            let tasks = clean(r.tasks)?;
            let row = tasks
                .as_array()
                .unwrap()
                .iter()
                .find(|v| {
                    v["localPath"] == r.local_path
                        && (v["id"] == r.task_id
                            || r.recording_id
                                .as_ref()
                                .is_some_and(|id| v["recordingId"] == *id))
                        && r.recording_id
                            .as_ref()
                            .is_none_or(|id| v["recordingId"] == *id)
                        && r.device_id.as_ref().is_none_or(|id| v["deviceId"] == *id)
                        && (!r.completed_only || v["status"] == "completed")
                })
                .ok_or_else(|| invalid("file has no exact owned queue identity"))?;
            let original_id = row["id"].as_str().unwrap();
            if original_id.len() > 128
                || matches!(original_id, "." | "..")
                || !original_id.bytes().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b':' | b'@')
                })
            {
                return Err(invalid(
                    "recording sink identity is not a safe logical component",
                ));
            }
            public_output(
                json!({"task":row,"logicalId":format!("recording/{}",row["id"].as_str().unwrap())}),
            )
        }
        "recordingFileUploadResponse" => {
            let r: Reply = input(value)?;
            if r.response_json.len() > 16_384 {
                return Err(invalid("recording HTTP response exceeds its bound"));
            }
            let value = serde_json::from_str::<Value>(&r.response_json).ok();
            let pending = r.status == 425
                && value
                    .as_ref()
                    .and_then(|v| v.get("error"))
                    .and_then(|v| v.get("code"))
                    .and_then(Value::as_str)
                    == Some("upload_verification_pending");
            public_output(
                json!({"success":(200..=299).contains(&r.status),"verificationPending":pending,"status":r.status,
                "data":if pending {json!({"error":{"code":"upload_verification_pending"}})}else{Value::Null}}),
            )
        }
        _ => Err(invalid("unknown recording upload codec")),
    }
}
fn plan(value: Plan) -> Result<Vec<u8>, DeviceSdkError> {
    let r = value.request;
    owned(&value.file, &value.namespace, &r.local_path)?;
    if [&r.task_id, &r.recording_id, &r.device_id]
        .iter()
        .any(|v| v.is_empty() || v.len() > 256)
    {
        return Err(invalid("invalid recording upload identity"));
    }
    let total = decimal(&value.file.durable_units)?;
    if r.file_size_bytes
        .is_some_and(|n| !integer(n) || n as u64 != total)
    {
        return Err(invalid("stored recording length changed"));
    }
    let relay = r.relay_url.is_some();
    let url = r.relay_url.as_ref().unwrap_or(&r.upload_url);
    https(url)?;
    let content_type = if relay {
        "application/octet-stream"
    } else {
        r.content_type.as_deref().unwrap_or("audio/opus")
    };
    if content_type.is_empty() || content_type.bytes().any(|c| matches!(c, 0 | 10 | 13)) {
        return Err(invalid("invalid recording content type"));
    }
    let mut headers = json!({"Content-Type":content_type});
    if relay && let Some(token) = &r.relay_bearer_token {
        token_valid(token)?;
        headers["Authorization"] = json!(format!("Bearer {token}"));
    }
    let complete = if !relay && let (Some(url), Some(token)) = (&r.complete_url, &r.upload_token) {
        https(url)?;
        token_valid(token)?;
        let mut body = json!({"recording_id":r.recording_id});
        if let Some(hash) = r.content_sha256 {
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(invalid("invalid recording hash"));
            }
            body["content_sha256"] = json!(hash);
        }
        json!({"url":url,"method":"POST","headers":{"Content-Type":"application/json","Authorization":format!("Bearer {token}")},
            "bodyJSON":serde_json::to_string(&body).map_err(|_|invalid("invalid recording completion body"))?})
    } else {
        Value::Null
    };
    public_output(
        json!({"target":{"url":url,"method":if relay{"POST"}else{"PUT"},"headers":headers},"completion":complete,"totalBytes":total.to_string()}),
    )
}
fn recovery_recording(p: RecoveryRecording) -> Result<Vec<u8>, DeviceSdkError> {
    let file_size = match &p.recording_file_size_bytes {
        Value::Null => None,
        Value::String(v) => Some(decimal(v)? as f64),
        Value::Number(v) => Some(
            v.as_f64()
                .ok_or_else(|| invalid("Invalid upload recovery file size"))?,
        ),
        _ => return Err(invalid("Invalid upload recovery file size")),
    };
    if file_size.is_some_and(|v| !integer(v)) || p.task_file_size_bytes.is_some_and(|v| !integer(v))
    {
        return Err(invalid("Invalid upload recovery file size"));
    }
    let hash_changed = p
        .task_content_sha256
        .as_deref()
        .zip(p.recording_content_sha256.as_deref())
        .is_some_and(|(expected, actual)| {
            !expected.is_empty() && !actual.is_empty() && expected != actual
        });
    let size_changed = p
        .task_file_size_bytes
        .zip(file_size)
        .is_some_and(|(expected, actual)| expected != actual);
    if p.recording_id != p.task_recording_id
        || (!p.task_relay_upload && (hash_changed || size_changed))
    {
        return Err(invalid("Upload recovery identity or evidence changed"));
    }
    if !["pending", "uploaded", "integrity_failure"].contains(&p.status.as_str()) {
        return Err(invalid("Recording unavailable for recovery"));
    }
    if p.started_at_ms.is_some_and(|v| !clock(v)) || p.ended_at_ms.is_some_and(|v| !clock(v)) {
        return Err(invalid("invalid recording duration clock"));
    }
    let duration = p
        .started_at_ms
        .zip(p.ended_at_ms)
        .filter(|(start, end)| end >= start)
        .map(|(start, end)| ((end - start) / 1000.0).floor());
    let uploaded = p.status == "uploaded" || (p.task_completion_pending && p.status == "pending");
    public_output(json!({"alreadyUploaded":uploaded,"needsTarget":!uploaded,
        "reuploadRequired":p.status == "integrity_failure","durationSeconds":duration}))
}
fn clock(value: f64) -> bool {
    value.is_finite() && value.abs() <= SAFE as f64 && value.fract() == 0.0
}
fn owned(file: &File, namespace: &str, path: &str) -> Result<(), DeviceSdkError> {
    if namespace.is_empty()
        || file.scope != namespace
        || file.kind != "file"
        || file.local_path != path
        || path.is_empty()
    {
        return Err(invalid("recording file is outside the captured SDK scope"));
    }
    decimal(&file.durable_units)?;
    Ok(())
}
fn integer(v: f64) -> bool {
    v.is_finite() && v >= 0.0 && v <= SAFE as f64 && v.fract() == 0.0
}
fn decimal(v: &str) -> Result<u64, DeviceSdkError> {
    if v.is_empty() || (v.len() > 1 && v.starts_with('0')) || !v.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(invalid("invalid stored recording length"));
    }
    v.parse::<u64>()
        .ok()
        .filter(|n| *n <= SAFE)
        .ok_or_else(|| invalid("stored recording length exceeds public number bounds"))
}
fn token_valid(v: &str) -> Result<(), DeviceSdkError> {
    if v.is_empty() || v.len() > 16_384 || !v.bytes().all(|c| (33..=126).contains(&c)) {
        Err(invalid("invalid recording upload token"))
    } else {
        Ok(())
    }
}
fn https(v: &str) -> Result<(), DeviceSdkError> {
    let rest = v
        .strip_prefix("https://")
        .ok_or_else(|| invalid("recording uploads require HTTPS"))?;
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || v.contains(['#', '\\'])
        || v.bytes().any(|c| c <= 32 || c >= 127)
    {
        return Err(invalid("invalid recording HTTPS target"));
    }
    Ok(())
}
fn clean(value: Value) -> Result<Value, DeviceSdkError> {
    let rows = value
        .as_array()
        .ok_or_else(|| invalid("invalid compatibility upload queue"))?;
    let mut ids = BTreeSet::new();
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let row = row
            .as_object()
            .ok_or_else(|| invalid("invalid compatibility upload queue row"))?;
        for key in ["id", "recordingId", "deviceId"] {
            if row
                .get(key)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(invalid("invalid upload queue identity"));
            }
        }
        if !ids.insert(row["id"].as_str().unwrap()) {
            return Err(invalid("duplicate upload queue identity"));
        }
        for key in ["localPath", "createdAt", "updatedAt"] {
            if row.get(key).and_then(Value::as_str).is_none() {
                return Err(invalid("invalid upload queue metadata"));
            }
        }
        if !row
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| ["pending", "uploading", "completed", "failed"].contains(&s))
            || !row
                .get("retryCount")
                .and_then(Value::as_f64)
                .is_some_and(integer)
        {
            return Err(invalid("invalid upload queue status"));
        }
        for key in [
            "recordingUuid",
            "recoveryScope",
            "contentType",
            "contentSha256",
        ] {
            if row.get(key).is_some_and(|v| !v.is_string()) {
                return Err(invalid("invalid upload queue string field"));
            }
        }
        for key in ["fileSizeBytes", "nextAttemptAt"] {
            if row
                .get(key)
                .is_some_and(|v| !v.as_f64().is_some_and(integer))
            {
                return Err(invalid("invalid upload queue number field"));
            }
        }
        for key in ["relayUpload", "completionPending"] {
            if row.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(invalid("invalid upload queue boolean field"));
            }
        }
        for key in ["createdAt", "updatedAt"] {
            if !date(row[key].as_str().unwrap()) {
                return Err(invalid("invalid upload queue timestamp"));
            }
        }
        let mut clean: serde_json::Map<String, Value> = row
            .iter()
            .filter(|(key, _)| FIELDS.contains(&key.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        clean.insert(
            "relayUpload".into(),
            row.get("relayUpload")
                .cloned()
                .unwrap_or_else(|| json!(row.get("relay").is_some_and(Value::is_object))),
        );
        result.push(Value::Object(clean));
    }
    Ok(Value::Array(result))
}
fn date(v: &str) -> bool {
    if !v.is_ascii()
        || v.len() < 20
        || &v[4..5] != "-"
        || &v[7..8] != "-"
        || &v[10..11] != "T"
        || &v[13..14] != ":"
        || &v[16..17] != ":"
    {
        return false;
    }
    let n = |s: &str| {
        if s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse::<u16>().ok()
        } else {
            None
        }
    };
    let (Some(y), Some(m), Some(d), Some(h), Some(min), Some(sec)) = (
        n(&v[..4]),
        n(&v[5..7]),
        n(&v[8..10]),
        n(&v[11..13]),
        n(&v[14..16]),
        n(&v[17..19]),
    ) else {
        return false;
    };
    let leap = y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
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
        || h > 23
        || min > 59
        || sec > 59
    {
        return false;
    }
    let mut tail = &v[19..];
    if let Some(frac) = tail.strip_prefix('.') {
        let count = frac.bytes().take_while(|c| c.is_ascii_digit()).count();
        if count == 0 {
            return false;
        }
        tail = &frac[count..];
    }
    tail == "Z"
        || (tail.len() == 6
            && matches!(&tail[..1], "+" | "-")
            && &tail[3..4] == ":"
            && n(&tail[1..3]).is_some_and(|v| v <= 23)
            && n(&tail[4..6]).is_some_and(|v| v <= 59))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_credentials_follow_exact_pending_identity_and_expiry() {
        let base = json!({"hasCredentials":true,"hasProvider":true,"aborted":false,"completionPending":false,
            "alreadyUploaded":false,"targetPresent":true,"expiresAtMs":100,"nowMs":100,"hasRecordingUuid":true});
        assert_eq!(
            codec("planCompatibilityUploadCredentials", base.clone())["refresh"],
            true
        );
        let mut uploaded = base.clone();
        uploaded["alreadyUploaded"] = json!(true);
        assert_eq!(
            codec("planCompatibilityUploadCredentials", uploaded.clone())["refresh"],
            false
        );
        uploaded["completionPending"] = json!(true);
        assert_eq!(
            codec("planCompatibilityUploadCredentials", uploaded)["refresh"],
            true
        );
        let mut aborted = base;
        aborted["aborted"] = json!(true);
        aborted["hasRecordingUuid"] = json!(false);
        let v = codec("planCompatibilityUploadCredentials", aborted);
        assert_eq!(v["refresh"], false);
        assert_eq!(v["recoveryAllowed"], false);
        let route = json!({"alreadyUploaded":false,"completionPending":false,"reuploadRequired":false,"routeChanged":false,
            "hasComplete":true,"hasProvider":true,"relay":false,"completeUrlAndToken":false,"recordingId":"rec_1",
            "expectedRecordingId":"rec_1","recoveryScope":"scope","expectedRecoveryScope":"scope","expiresAtMs":100,"nowMs":100});
        assert!(call("planCompatibilityUploadQueueRoute", route.clone()).is_err());
        let mut completed = route.clone();
        completed["alreadyUploaded"] = json!(true);
        assert_eq!(
            codec("planCompatibilityUploadQueueRoute", completed)["uploadRequired"],
            false
        );
        let mut foreign = route;
        foreign["recordingId"] = json!("rec_other");
        foreign["expiresAtMs"] = Value::Null;
        assert!(call("planCompatibilityUploadQueueRoute", foreign).is_err());
    }
    #[test]
    fn recording_recovery_admits_exact_evidence_and_never_reputs_pending() {
        let base = json!({"taskRecordingId":"rec_1","taskRelayUpload":false,"taskCompletionPending":true,
            "taskFileSizeBytes":4,"taskContentSha256":"hash","recordingId":"rec_1","status":"pending",
            "recordingFileSizeBytes":"4","recordingContentSha256":"hash","startedAtMs":1000,"endedAtMs":3500});
        let v = codec("planUploadRecoveryRecording", base.clone());
        assert_eq!(v["alreadyUploaded"], true);
        assert_eq!(v["needsTarget"], false);
        assert_eq!(v["durationSeconds"], 2.0);
        for wire in [
            json!("04"),
            json!("4.0"),
            json!(true),
            json!(-1),
            json!(9007199254740992_u64),
            json!(5),
        ] {
            let mut invalid = base.clone();
            invalid["recordingFileSizeBytes"] = wire;
            assert!(call("planUploadRecoveryRecording", invalid).is_err());
        }
        let mut repair = base.clone();
        repair["status"] = json!("integrity_failure");
        repair["endedAtMs"] = json!(500);
        let v = codec("planUploadRecoveryRecording", repair);
        assert_eq!(v["reuploadRequired"], true);
        assert_eq!(v["needsTarget"], true);
        assert!(v["durationSeconds"].is_null());
        let mut unavailable = base.clone();
        unavailable["status"] = json!("deleted");
        assert!(call("planUploadRecoveryRecording", unavailable).is_err());
        let mut relay = base;
        relay["taskRelayUpload"] = json!(true);
        relay["recordingFileSizeBytes"] = json!(5);
        relay["recordingContentSha256"] = json!("other");
        assert_eq!(
            codec("planUploadRecoveryRecording", relay)["alreadyUploaded"],
            true
        );
    }
    #[test]
    fn queue_retry_parking_and_schedule_are_bounded() {
        let base = json!({"nowMs":100_000,"createdAtMs":0,"retryCount":0,"hasProvider":true,"credentialUnavailable":false,"aborted":false,"verificationPending":false,"completionPending":null});
        let v = codec("planCompatibilityUploadQueueFailure", base.clone());
        assert_eq!(v["retryCount"], 1.0);
        assert_eq!(v["nextAttemptAt"], 130_000.0);
        let mut pending = base.clone();
        pending["verificationPending"] = json!(true);
        let v = codec("planCompatibilityUploadQueueFailure", pending);
        assert_eq!(v["retryCount"], 0.0);
        assert_eq!(v["completionPending"], true);
        assert_eq!(v["status"], "pending");
        let mut exhausted = base;
        exhausted["retryCount"] = json!(6);
        let v = codec("planCompatibilityUploadQueueFailure", exhausted);
        assert_eq!(v["status"], "failed");
        assert!(v["nextAttemptAt"].is_null());
        let mut schedule = json!({"status":"pending","localPath":"owned","active":false,"cancelled":false,"hasCredentials":false,"hasProvider":true,"activeCount":2,"nextAttemptAt":null,"nowMs":1});
        assert_eq!(
            codec("planCompatibilityUploadQueueSchedule", schedule.clone())["action"],
            "skip"
        );
        schedule["nextAttemptAt"] = json!(100);
        assert_eq!(
            codec("planCompatibilityUploadQueueSchedule", schedule)["action"],
            "wait"
        );
    }
    #[test]
    fn completion_poll_needs_exact_pending_and_stops_at_budget() {
        let base = json!({"stage":"response","elapsedMs":119_900,"poll":1,"randomFraction":0.5,"status":425,"code":"upload_verification_pending"});
        assert_eq!(
            codec("planUploadCompletionPoll", base.clone())["waitMs"],
            100.0
        );
        let mut exhausted = base.clone();
        exhausted["elapsedMs"] = json!(120_000);
        assert_eq!(
            codec("planUploadCompletionPoll", exhausted)["exhausted"],
            true
        );
        let mut wrong = base;
        wrong["code"] = json!("other");
        let v = codec("planUploadCompletionPoll", wrong);
        assert_eq!(v["verificationPending"], false);
        assert!(v["waitMs"].is_null());
        let before = json!({"stage":"before","elapsedMs":1000,"poll":120,"randomFraction":0,"status":0,"code":""});
        assert_eq!(codec("planUploadCompletionPoll", before)["exhausted"], true);
    }
    #[test]
    fn queue_route_never_reputs_pending_or_accepts_missing_commit() {
        let base = json!({"alreadyUploaded":false,"completionPending":true,"reuploadRequired":false,"routeChanged":false,"hasComplete":true,"hasProvider":true,"relay":false,"completeUrlAndToken":false});
        assert_eq!(
            codec("planCompatibilityUploadQueueRoute", base.clone())["uploadRequired"],
            false
        );
        let mut repair = base.clone();
        repair["reuploadRequired"] = json!(true);
        assert_eq!(
            codec("planCompatibilityUploadQueueRoute", repair)["uploadRequired"],
            true
        );
        let mut missing = base;
        missing["hasComplete"] = json!(false);
        assert!(call("planCompatibilityUploadQueueRoute", missing).is_err());
    }
    fn task() -> Value {
        json!({"id":"task","recordingId":"rec_1","deviceId":"dev_1","localPath":"owned-path","status":"completed","retryCount":0,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00.001Z"})
    }
    fn file() -> Value {
        json!({"localPath":"owned-path","durableUnits":"900","kind":"file","scope":"account/project"})
    }
    fn request() -> Value {
        json!({"taskId":"attempt","recordingId":"rec_1","deviceId":"dev_1","localPath":"owned-path","fileSizeBytes":900,"uploadUrl":"https://s3.example.com/file?signature=1","completeUrl":"https://api.example.com/complete","uploadToken":"up_exact","contentSha256":"aa".repeat(32)})
    }
    fn codec(name: &str, v: Value) -> Value {
        serde_json::from_slice(&call(name, v).unwrap()).unwrap()
    }
    #[test]
    fn metadata_only_and_strict_types() {
        let mut t = task();
        t["uploadToken"] = json!("secret");
        t["uploadUrl"] = json!("signed");
        t["relay"] = json!({"bearerToken":"secret"});
        let v = codec("sanitizeCompatibilityUploadQueue", json!({"tasks":[t]}));
        assert!(v[0].get("uploadToken").is_none());
        assert!(v[0].get("relay").is_none());
        assert_eq!(v[0]["relayUpload"], true);
        for val in [
            json!(true),
            json!(-1),
            json!(0.5),
            json!(9007199254740992_u64),
        ] {
            let mut t = task();
            t["retryCount"] = val;
            assert!(call("sanitizeCompatibilityUploadQueue", json!({"tasks":[t]})).is_err());
        }
    }
    #[test]
    fn no_duplicate_or_invalid_dates() {
        let t = task();
        assert!(
            call(
                "sanitizeCompatibilityUploadQueue",
                json!({"tasks":[t.clone(),t]})
            )
            .is_err()
        );
        let mut t = task();
        t["updatedAt"] = json!("2026-02-30T00:00:00Z");
        assert!(call("sanitizeCompatibilityUploadQueue", json!({"tasks":[t]})).is_err());
    }
    #[test]
    fn plan_exact_size_relay_and_completion() {
        let v = codec(
            "planRecordingFileUpload",
            json!({"request":request(),"file":file(),"namespace":"account/project"}),
        );
        assert_eq!(v["target"]["method"], "PUT");
        assert_eq!(v["totalBytes"], "900");
        let body: Value =
            serde_json::from_str(v["completion"]["bodyJSON"].as_str().unwrap()).unwrap();
        assert_eq!(body["recording_id"], "rec_1");
        let mut r = request();
        r["relayUrl"] = json!("https://api.example.com/relay");
        r["relayBearerToken"] = json!("app-token");
        let v = codec(
            "planRecordingFileUpload",
            json!({"request":r,"file":file(),"namespace":"account/project"}),
        );
        assert_eq!(v["target"]["method"], "POST");
        assert!(v["completion"].is_null());
        assert_eq!(v["target"]["headers"]["Authorization"], "Bearer app-token");
    }
    #[test]
    fn wrong_file_or_scope_cannot_upload_or_release() {
        let mut f = file();
        f["durableUnits"] = json!("901");
        assert!(
            call(
                "planRecordingFileUpload",
                json!({"request":request(),"file":f,"namespace":"account/project"})
            )
            .is_err()
        );
        assert!(
            call(
                "planRecordingFileUpload",
                json!({"request":request(),"file":file(),"namespace":"other"})
            )
            .is_err()
        );
        for uncertain in [false, true] {
            let mut t = task();
            if !uncertain {
                t["status"] = json!("pending");
            }
            assert!(call("releaseRecordingFileAdmission",json!({"tasks":[t],"taskId":"task","localPath":"owned-path","file":file(),"namespace":"account/project","journalWriteUncertain":uncertain})).is_err());
        }
    }
    #[test]
    fn exact_pending_only_and_completed_release() {
        assert_eq!(
            codec(
                "recordingFileUploadResponse",
                json!({"status":425,"responseJson":"{\"error\":{\"code\":\"upload_verification_pending\"}}"})
            )["verificationPending"],
            true
        );
        assert_eq!(
            codec(
                "recordingFileUploadResponse",
                json!({"status":425,"responseJson":"{}"})
            )["verificationPending"],
            false
        );
        assert_eq!(
            codec(
                "releaseRecordingFileAdmission",
                json!({"tasks":[task()],"taskId":"task","localPath":"owned-path","file":file(),"namespace":"account/project","journalWriteUncertain":false})
            )["allowed"],
            true
        );
    }
}
