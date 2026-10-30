//! Private host RPCs over the shared local transfer receiver. Secrets are only
//! returned by the explicit ephemeral link operation, never receiver journals.
use crate::{
    codecs::{input, output, public_output},
    engine::invalid,
    v2,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bota_device_sdk_core::{
    error::DeviceSdkError, generated::protocol as p, protocol::*,
    workflow::EncryptedUploadV2BatchRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Default)]
pub(crate) struct LocalWifiCodecs {
    next: u32,
    receivers: BTreeMap<u32, LocalWifiTransferReceiver>,
    controls: BTreeMap<u32, LocalWifiControl>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum Request {
    ControlCreate {
        session_id: u64,
        response_json: String,
    },
    ControlSeal {
        id: u32,
        bytes: Vec<u8>,
    },
    ControlOpen {
        id: u32,
        bytes: Vec<u8>,
    },
    ControlFree {
        id: u32,
    },
    Capabilities {
        bytes: Vec<u8>,
        att_mtu: u16,
    },
    Create {
        request: EncryptedUploadV2BatchRequest,
        authorization_sha256: [u8; 32],
    },
    Prepared {
        id: u32,
        bytes: Vec<u8>,
    },
    Manifest {
        id: u32,
        bytes: Vec<u8>,
    },
    Prefix {
        id: u32,
        checkpoint: Option<LocalWifiCheckpoint>,
    },
    Rebase {
        id: u32,
        checkpoint: LocalWifiCheckpoint,
        recovery: LocalWifiRecovery,
    },
    Resume {
        id: u32,
        checkpoint: Option<LocalWifiCheckpoint>,
        proof: LocalWifiFileProof,
    },
    Response {
        id: u32,
        response: LocalWifiHttpResponse,
    },
    Chunk {
        id: u32,
        length: usize,
    },
    Flushed {
        id: u32,
        proof: LocalWifiFileProof,
    },
    Saved {
        id: u32,
        checkpoint: LocalWifiCheckpoint,
    },
    ReaderClosed {
        id: u32,
    },
    Finish {
        id: u32,
    },
    Eof {
        id: u32,
        bytes: Vec<u8>,
    },
    Cancel {
        id: u32,
    },
    Free {
        id: u32,
    },
    Link {
        command: u8,
        session_id: u64,
    },
    LinkState {
        bytes: Vec<u8>,
        session_id: u64,
        command: u8,
    },
    Event {
        bytes: Vec<u8>,
        session_id: u64,
    },
}
impl LocalWifiCodecs {
    pub(crate) fn call(&mut self, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        let mut fields = value
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("invalid local WiFi request"))?;
        let op = fields
            .remove("op")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| invalid("missing local WiFi operation"))?;
        match input(json!({op:fields}))? {
            Request::ControlCreate {
                session_id,
                mut response_json,
            } => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Grant {
                    format: String,
                    control_key_base64: String,
                    envelope_base64: String,
                    expires_in_seconds: u32,
                }
                let parsed = serde_json::from_str::<Grant>(&response_json);
                response_json.clear();
                let mut grant = parsed.map_err(|_| invalid("invalid control material"))?;
                let mut key = STANDARD
                    .decode(&grant.control_key_base64)
                    .map_err(|_| invalid("invalid control material"))?;
                let canonical_key = STANDARD.encode(&key) == grant.control_key_base64;
                grant.control_key_base64.clear();
                let result = (|| {
                    let envelope = STANDARD
                        .decode(&grant.envelope_base64)
                        .map_err(|_| invalid("invalid control material"))?;
                    if grant.format != "bota-local-wifi-control-v1"
                        || grant.expires_in_seconds != 300
                        || !canonical_key
                        || key.len() != 32
                        || envelope.len() != 509
                        || &envelope[..8] != b"BOTAWFC1"
                        || envelope[8..14] != [0, 16, 0, 1, 0, 3]
                        || envelope[14] > 2
                        || envelope[15] != 1
                        || STANDARD.encode(&envelope) != grant.envelope_base64
                        || self.controls.len() >= 16
                    {
                        return Err(invalid("invalid control material"));
                    }
                    let control = LocalWifiControl::new(
                        key.as_slice()
                            .try_into()
                            .map_err(|_| invalid("invalid control key"))?,
                        Sha256::digest(&envelope).into(),
                        session_id,
                        false,
                    )?;
                    self.next = self
                        .next
                        .checked_add(1)
                        .ok_or_else(|| invalid("control handles exhausted"))?;
                    self.controls.insert(self.next, control);
                    public_output(
                        json!({"id":self.next,"envelope":envelope,"blobKind":p::ENCRYPTED_UPLOAD_V2_BLOB_KIND_LOCAL_WIFI_CONTROL}),
                    )
                })();
                key.fill(0);
                result
            }
            Request::ControlSeal { id, bytes } => output(
                &self
                    .controls
                    .get_mut(&id)
                    .ok_or_else(|| invalid("unknown control session"))?
                    .seal(&bytes)?,
            ),
            Request::ControlOpen { id, bytes } => {
                let result = self
                    .controls
                    .get_mut(&id)
                    .ok_or_else(|| invalid("unknown control session"))?
                    .open(&bytes);
                if result.is_err() {
                    self.controls.remove(&id);
                }
                output(&result?)
            }
            Request::ControlFree { id } => {
                self.controls.remove(&id);
                output(&())
            }
            Request::Capabilities { bytes, att_mtu } => {
                let c = decode_local_wifi_capabilities(&bytes, att_mtu)?;
                public_output(json!({"bandMask":c.band_mask}))
            }
            Request::Create {
                request,
                authorization_sha256,
            } => {
                v2::validate_request(&request)?;
                if !request.local_wifi || self.receivers.len() >= 16 {
                    return Err(invalid("local WiFi receiver unavailable"));
                }
                let prepare = LocalWifiPrepare {
                    transport_session_id: request.transport_session_id,
                    upload_session_uuid: request.upload_session_uuid,
                    recording_uuid: *request.recording.as_bytes(),
                    recording_generation: request.recording_generation,
                    owner_revision: request.owner_revision,
                    authorization_sha256,
                };
                let frame = encode_local_wifi_prepare(&prepare)?;
                let receiver = LocalWifiTransferReceiver::new(LocalWifiTransferConfig {
                    prepare,
                    ciphertext_length: request.ciphertext_length,
                    ciphertext_sha256: request.ciphertext_sha256,
                })?;
                self.next = self
                    .next
                    .checked_add(1)
                    .ok_or_else(|| invalid("local WiFi handle exhausted"))?;
                self.receivers.insert(self.next, receiver);
                public_output(json!({"id":self.next,"frame":frame}))
            }
            Request::Prepared { id, bytes } => {
                self.get(id)?.prepared(&bytes)?;
                output(&())
            }
            Request::Manifest { id, bytes } => output(&self.get(id)?.manifest(&bytes)?),
            Request::Prefix { id, checkpoint } => {
                output(&self.get(id)?.resume_prefix(checkpoint.as_ref())?)
            }
            Request::Rebase {
                id,
                checkpoint,
                recovery,
            } => output(&self.get(id)?.rebase_checkpoint(&checkpoint, &recovery)?),
            Request::Resume {
                id,
                checkpoint,
                proof,
            } => output(&self.get(id)?.resume(checkpoint, proof)?),
            Request::Response { id, response } => {
                self.get(id)?.response(response)?;
                output(&())
            }
            Request::Chunk { id, length } => output(&self.get(id)?.chunk(length)?),
            Request::Flushed { id, proof } => output(&self.get(id)?.flushed(proof)?),
            Request::Saved { id, checkpoint } => {
                self.get(id)?.saved(&checkpoint)?;
                output(&())
            }
            Request::ReaderClosed { id } => {
                self.get(id)?.reader_closed()?;
                output(&())
            }
            Request::Finish { id } => output(&self.get(id)?.finish()?),
            Request::Eof { id, bytes } => {
                #[derive(Serialize)]
                struct Completed<'a> {
                    evidence: bota_device_sdk_core::workflow::EncryptedUploadV2TransferEvidence,
                    manifest: &'a [u8],
                }
                let r = self.get(id)?;
                let evidence = r.eof(&bytes)?;
                output(&Completed {
                    evidence,
                    manifest: r.manifest_bytes(),
                })
            }
            Request::Cancel { id } => {
                self.get(id)?.cancel();
                output(&())
            }
            Request::Free { id } => {
                self.receivers
                    .remove(&id)
                    .ok_or_else(|| invalid("unknown local WiFi receiver"))?;
                output(&())
            }
            Request::Link {
                command,
                session_id,
            } => output(&encode_local_wifi_link(command, session_id)?),
            Request::LinkState {
                bytes,
                session_id,
                command,
            } => {
                let link = decode_local_wifi_link_state(&bytes)?;
                if link.common.transport_session_id != session_id
                    || link.request_message_type != command
                    || link.result != 0
                {
                    return Err(invalid("local WiFi link rejected or stale"));
                }
                if let Some(m) = link.material {
                    // Explicit ephemeral delivery to the platform port; not a public notification.
                    public_output(
                        json!({"state":link.link_state,"material":{"ssid":m.ssid,"password":m.password,
                        "ipv4":m.ipv4,"port":m.port,"expiresInSeconds":m.expires_in_seconds,
                        "tlsSpkiSha256":m.tls_spki_sha256,"downloadToken":m.download_token}}),
                    )
                } else {
                    public_output(json!({"state":link.link_state}))
                }
            }
            Request::Event { bytes, session_id } => {
                let kind = match bytes.first() {
                    Some(&p::LOCAL_WIFI_PREPARED) | Some(&p::LOCAL_WIFI_EOF) => {
                        let e = decode_local_wifi_evidence(&bytes)?;
                        if e.common.transport_session_id != session_id {
                            return Err(invalid("stale local WiFi event"));
                        }
                        if e.common.message_type == p::LOCAL_WIFI_PREPARED {
                            "prepared"
                        } else {
                            "eof"
                        }
                    }
                    Some(&p::LOCAL_WIFI_LINK_STATE) => {
                        let l = decode_local_wifi_link_state(&bytes)?;
                        if l.common.transport_session_id != session_id {
                            return Err(invalid("stale local WiFi link"));
                        }
                        "link"
                    }
                    _ => match decode_encrypted_upload_v2_transfer(&bytes)? {
                        EncryptedUploadV2Transfer::ManifestChunk(c)
                            if c.common.transport_session_id == session_id =>
                        {
                            "manifest"
                        }
                        EncryptedUploadV2Transfer::Error { common, result, .. }
                            if common.transport_session_id == session_id =>
                        {
                            return Err(bota_device_sdk_core::error::DeviceSdkError::new(
                                bota_device_sdk_core::error::ErrorCode::ProtocolRejected,
                                bota_device_sdk_core::error::Operation::TransferRecording,
                                false,
                            )
                            .with_protocol_status(result));
                        }
                        _ => return Err(invalid("unexpected local WiFi event")),
                    },
                };
                output(&kind)
            }
        }
    }
    fn get(&mut self, id: u32) -> Result<&mut LocalWifiTransferReceiver, DeviceSdkError> {
        self.receivers
            .get_mut(&id)
            .ok_or_else(|| invalid("unknown local WiFi receiver"))
    }
}
