//! Bounded caption recovery and upsert identity, separate from media admission.
use super::{
    Result, SpeechContext, SpeechRetention, SpeechSubscription, bound, identifier, invalid,
    language, number, only, scalar, string, uuid,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

const PAGE_SIZE: usize = 8;
const MAX_SEEN: usize = 1024;
pub(super) const MAX_PAGE_JSON: usize = 896 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCaptionRequest {
    pub request_id: u32,
    pub project_id: String,
    pub session_id: String,
    pub participant_id: String,
    pub member_generation: u32,
    pub subscription_revision: u32,
    pub limit: usize,
    pub cursor: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCaptionRecovery {
    pub status: &'static str,
    pub cursor: Option<String>,
    pub has_more: bool,
    pub request: Option<SpeechCaptionRequest>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCaptionUpdate {
    /// Stable upsert identity across transport and local client instances.
    pub key: String,
    pub origin: &'static str,
    pub r#final: bool,
    pub subscription_revision: u32,
    pub sequence: Option<String>,
    pub record: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechCaptionFailure {
    Unavailable,
    Unauthorized,
    StaleSubscription,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    protocol_version: u8,
    session_id: String,
    participant_id: String,
    member_generation: u32,
    subscription_revision: u32,
    history: String,
    records: Vec<Row>,
    has_more: bool,
    next_cursor: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    sequence: String,
    record: Value,
}
struct Seen {
    digest: String,
    final_: bool,
}
pub(super) struct Recovery {
    enabled: bool,
    status: &'static str,
    request_id: u32,
    pending: Option<SpeechCaptionRequest>,
    cursor: Option<String>,
    sequence: u64,
    more: bool,
    next_at: u64,
    seen: BTreeMap<String, Seen>,
    order: VecDeque<String>,
}
impl Default for Recovery {
    fn default() -> Self {
        Self {
            enabled: false,
            status: "disabled",
            request_id: 0,
            pending: None,
            cursor: None,
            sequence: 0,
            more: false,
            next_at: 0,
            seen: BTreeMap::new(),
            order: VecDeque::new(),
        }
    }
}
impl Recovery {
    pub fn enable(&mut self) {
        self.enabled = true;
        self.status = "waiting";
    }
    pub fn reset(&mut self) {
        self.pending = None;
        self.cursor = None;
        self.sequence = 0;
        self.more = false;
        self.next_at = 0;
        self.seen.clear();
        self.order.clear();
        self.status = if self.enabled { "waiting" } else { "disabled" };
    }
    pub fn close(&mut self) {
        self.reset();
        self.enabled = false;
        self.status = "closed";
    }
    pub fn hint(&mut self) {
        if self.status == "ready" || self.status == "waiting" {
            self.next_at = 0;
        }
    }
    pub fn retry(&mut self) {
        if self.status == "retrying" {
            self.status = "waiting";
        }
        self.hint();
    }
    pub fn snapshot(&self) -> SpeechCaptionRecovery {
        SpeechCaptionRecovery {
            status: self.status,
            cursor: self.cursor.clone(),
            has_more: self.more,
            request: self.pending.clone(),
        }
    }
    pub fn poll(
        &mut self,
        context: &SpeechContext,
        subscription: &SpeechSubscription,
        eligible: bool,
        now: u64,
    ) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        if context.retention == SpeechRetention::LiveOnly {
            self.status = "unavailable";
            self.pending = None;
            return Ok(());
        }
        if !eligible
            || !context.can_subscribe
            || subscription.revision == 0
            || !subscription
                .source_participant_ids
                .iter()
                .any(|id| *id != context.participant_id)
            || self.status == "stale"
            || self.pending.is_some()
            || now < self.next_at
        {
            return Ok(());
        }
        self.request_id = self.request_id.checked_add(1).ok_or_else(bound)?;
        self.status = "reading";
        self.pending = Some(SpeechCaptionRequest {
            request_id: self.request_id,
            project_id: context.project_id.clone(),
            session_id: context.session_id.clone(),
            participant_id: context.participant_id.clone(),
            member_generation: context.member_generation,
            subscription_revision: subscription.revision,
            limit: PAGE_SIZE,
            cursor: self.cursor.clone(),
        });
        Ok(())
    }
    pub fn pending(&self, id: u32) -> bool {
        self.pending.as_ref().is_some_and(|r| r.request_id == id)
    }
    pub fn failed(&mut self, id: u32, reason: &SpeechCaptionFailure, now: u64) -> bool {
        if !self.pending(id) {
            return false;
        }
        self.pending = None;
        self.status = match reason {
            SpeechCaptionFailure::Unavailable => "retrying",
            SpeechCaptionFailure::StaleSubscription => "stale",
            SpeechCaptionFailure::Unauthorized => "closed",
        };
        self.next_at = now.saturating_add(5000);
        true
    }
    pub fn page(
        &mut self,
        id: u32,
        page: Value,
        context: &SpeechContext,
        subscription: &SpeechSubscription,
        now: u64,
    ) -> Result<Vec<SpeechCaptionUpdate>> {
        if !self.pending(id) {
            return Ok(Vec::new());
        }
        let page: Page = serde_json::from_value(page).map_err(|_| invalid())?;
        if page.protocol_version != 1
            || page.session_id != context.session_id
            || page.participant_id != context.participant_id
            || page.member_generation != context.member_generation
            || page.subscription_revision != subscription.revision
            || page.history != "retained"
            || context.retention == SpeechRetention::LiveOnly
            || page.records.len() > PAGE_SIZE
            || page.next_cursor.is_empty()
            || page.next_cursor.len() > 512
            || !page
                .next_cursor
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || (page.has_more && page.records.is_empty())
            || (!page.records.is_empty() && self.cursor.as_ref() == Some(&page.next_cursor))
            || (page.records.is_empty()
                && self
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor != &page.next_cursor))
        {
            return Err(invalid());
        }
        let mut sequence = self.sequence;
        // Validate the complete page before emitting or advancing any cursor.
        for row in &page.records {
            let next = row.sequence.parse::<u64>().map_err(|_| invalid())?;
            if next <= sequence || next > i64::MAX as u64 || next.to_string() != row.sequence {
                return Err(invalid());
            }
            sequence = next;
            validate_record(context, &row.record)?;
            let source = string(&row.record, "sourceParticipantId")?;
            if source == context.participant_id
                || !subscription
                    .source_participant_ids
                    .iter()
                    .any(|id| id == source)
                || row
                    .record
                    .get("targetLanguage")
                    .is_some_and(|target| target.as_str() != Some(&subscription.target_language))
                || string(&row.record, "unitId")?
                    != format!(
                        "{}:{}:{}:{}",
                        string(&row.record, "sourceId")?,
                        number(&row.record, "sourceEpoch")?,
                        number(&row.record, "sourceFirstSeq")?,
                        number(&row.record, "sourceLastSeq")?
                    )
            {
                return Err(invalid());
            }
        }
        let mut updates = Vec::new();
        for row in page.records {
            if let Some(update) = self.upsert(
                row.record,
                true,
                "recovered",
                subscription.revision,
                Some(row.sequence),
            )? {
                updates.push(update);
            }
        }
        self.sequence = sequence;
        self.cursor = Some(page.next_cursor);
        self.more = page.has_more;
        self.pending = None;
        self.status = "ready";
        self.next_at = now.saturating_add(if self.more { 250 } else { 2000 });
        Ok(updates)
    }
    pub fn upsert(
        &mut self,
        record: Value,
        final_: bool,
        origin: &'static str,
        revision: u32,
        sequence: Option<String>,
    ) -> Result<Option<SpeechCaptionUpdate>> {
        let identity = json!([
            record["projectId"],
            record["sessionId"],
            record["sourceId"],
            record["sourceEpoch"],
            record["unitId"],
            record.get("targetLanguage")
        ]);
        let key = digest(&identity)?;
        let hash = digest(&record)?;
        if let Some(prior) = self.seen.get(&key) {
            if prior.final_ && !final_ || prior.final_ == final_ && prior.digest == hash {
                return Ok(None);
            }
            if prior.final_ && prior.digest != hash {
                return Err(invalid());
            }
        } else {
            if self.order.len() >= MAX_SEEN
                && let Some(old) = self.order.pop_front()
            {
                self.seen.remove(&old);
            }
            self.order.push_back(key.clone());
        }
        self.seen.insert(
            key.clone(),
            Seen {
                digest: hash,
                final_,
            },
        );
        Ok(Some(SpeechCaptionUpdate {
            key,
            origin,
            r#final: final_,
            subscription_revision: revision,
            sequence,
            record,
        }))
    }
}
fn digest(v: &Value) -> Result<String> {
    Ok(
        Sha256::digest(serde_json::to_vec(v).map_err(|_| invalid())?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
pub(super) fn validate_record(context: &SpeechContext, record: &Value) -> Result<()> {
    only(
        record,
        "protocolVersion projectId sessionId retention sourceId sourceEpoch sourceParticipantId sourceMemberGeneration unitId sourceFirstSeq sourceLastSeq startMs endMs sourceLanguage targetLanguage text",
    )?;
    if record.get("protocolVersion") != Some(&json!(1))
        || record.get("projectId") != Some(&json!(context.project_id))
        || record.get("sessionId") != Some(&json!(context.session_id))
        || record.get("retention") != Some(&json!(context.retention))
        || !uuid(string(record, "sourceId")?)
        || !uuid(string(record, "sourceParticipantId")?)
        || number(record, "sourceEpoch")? == 0
        || number(record, "sourceMemberGeneration")? == 0
        || !identifier(string(record, "unitId")?, 512)
        || string(record, "text")?.trim().is_empty()
        || string(record, "text")?.len() > 16384
        || !matches!(string(record, "sourceLanguage")?, "en" | "zh" | "multi")
        || number(record, "sourceFirstSeq")? == 0
        || number(record, "sourceLastSeq")? < number(record, "sourceFirstSeq")?
        || number(record, "sourceLastSeq")? > 10000
        || scalar(record, "endMs")? < scalar(record, "startMs")?
        || record
            .get("targetLanguage")
            .is_some_and(|target| target.as_str().is_none_or(|t| !language(t)))
    {
        return Err(invalid());
    }
    Ok(())
}
