use super::{Result, invalid, uuid};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Profile {
    pub chunk_aad_prefix: String,
    pub manifest_aad_prefix: String,
    maximum_mapping_drift_ppm: u64,
    maximum_channel_gaps_per_chunk: usize,
}
pub(super) fn profile() -> &'static Profile {
    static VALUE: OnceLock<Profile> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(include_str!("../../../../../protocol/manifest/speech-capture-v2.json")).expect("checked stereo capture profile"))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Channel { pub source_id: String, pub role: String }
pub(super) fn channels(value: &[Channel; 2]) -> Result<()> {
    for (index, channel) in value.iter().enumerate() {
        if channel.role != ["local", "remote"][index] || channel.source_id.is_empty() || channel.source_id.len() > 80 ||
            !channel.source_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') { return Err(invalid()); }
    }
    if value[0].source_id == value[1].source_id { return Err(invalid()); }
    Ok(())
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Gap { offset: u32, samples: u32 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Mapping {
    pub source_clock_id: String, pub source_epoch: u32, pub first_sample: u64, pub samples: u32,
    pub sample_rate: u32, pub revision: u32, pub discontinuity: bool, gaps: Vec<Gap>,
}
impl Mapping {
    pub fn aad(&self, capture_samples: u64) -> Result<Vec<u8>> {
        let mut out = uuid(&self.source_clock_id)?;
        if self.source_epoch == 0 || self.revision == 0 || !(8000..=192000).contains(&self.sample_rate) || self.samples > 192000 ||
            self.first_sample > u64::from(self.sample_rate) * 7200 || self.first_sample + u64::from(self.samples) > u64::from(self.sample_rate) * 7200 ||
            self.gaps.len() > profile().maximum_channel_gaps_per_chunk { return Err(invalid()); }
        let mut end = 0_u64; let mut missing = 0_u64;
        for gap in &self.gaps {
            if gap.samples == 0 || u64::from(gap.offset) < end || u64::from(gap.offset) + u64::from(gap.samples) > capture_samples { return Err(invalid()); }
            end = u64::from(gap.offset) + u64::from(gap.samples); missing += u64::from(gap.samples);
        }
        let actual = u64::from(self.samples) * 48000;
        let expected = capture_samples * u64::from(self.sample_rate);
        let permitted = u64::from(self.sample_rate) + expected * profile().maximum_mapping_drift_ppm / 1_000_000;
        if self.samples == 0 && missing != capture_samples || self.samples > 0 && !self.discontinuity && actual.abs_diff(expected) > permitted { return Err(invalid()); }
        out.extend(self.source_epoch.to_be_bytes()); out.extend(self.first_sample.to_be_bytes());
        out.extend(self.samples.to_be_bytes()); out.extend(self.sample_rate.to_be_bytes()); out.extend(self.revision.to_be_bytes());
        out.push(u8::from(self.discontinuity)); out.push(self.gaps.len() as u8); out.extend([0_u8; 4]);
        for gap in &self.gaps { out.extend(gap.offset.to_be_bytes()); out.extend(gap.samples.to_be_bytes()); }
        Ok(out)
    }
    pub fn follows(&self, previous: &Self) -> Result<()> {
        let same = self.source_clock_id == previous.source_clock_id && self.source_epoch == previous.source_epoch;
        let previous_end = previous.first_sample + u64::from(previous.samples);
        if same && (self.first_sample < previous_end || self.revision < previous.revision) ||
            (!same || self.first_sample != previous_end || self.sample_rate != previous.sample_rate) &&
                (!self.discontinuity || self.revision <= previous.revision) { return Err(invalid()); }
        Ok(())
    }
}
