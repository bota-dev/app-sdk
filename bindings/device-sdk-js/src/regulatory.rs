use crate::{
    codecs::{input, output, public_output},
    engine::invalid,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bota_device_sdk_core::{
    error::DeviceSdkError,
    protocol::{
        RegulatoryDocument, RegulatoryReceiptAssembler, regulatory_capabilities,
        regulatory_challenge, regulatory_ready,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Request {
    Capabilities {
        bytes: Vec<u8>,
    },
    Status {
        bytes: Vec<u8>,
    },
    Challenge {
        bytes: Vec<u8>,
    },
    Prepare {
        document: String,
        serial: String,
        nonce: String,
        mtu: u16,
    },
    Notification {
        bytes: Vec<u8>,
    },
    Receipt {
        bytes: Vec<u8>,
    },
    Clear,
}
#[derive(Default)]
pub(crate) struct RegulatoryCodecs {
    document: Option<RegulatoryDocument>,
    assembler: RegulatoryReceiptAssembler,
}
impl RegulatoryCodecs {
    pub(crate) fn call(&mut self, value: Value) -> Result<Vec<u8>, DeviceSdkError> {
        match input::<Request>(value)? {
            Request::Capabilities { bytes } => {
                regulatory_capabilities(&bytes)?;
                public_output(json!({"supported":true,"protocolVersion":1}))
            }
            Request::Status { bytes } => public_output(json!({"ready": regulatory_ready(&bytes)?})),
            Request::Challenge { bytes } => {
                let nonce = regulatory_challenge(&bytes)?;
                public_output(json!(
                    nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
                ))
            }
            Request::Prepare {
                document,
                serial,
                nonce,
                mtu,
            } => {
                self.document = None;
                self.assembler = RegulatoryReceiptAssembler::default();
                if document.len() > 771
                    || nonce.len() != 32
                    || !nonce
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(invalid("invalid regulatory document"));
                }
                let challenge: [u8; 16] = (0..nonce.len())
                    .step_by(2)
                    .map(|i| {
                        u8::from_str_radix(&nonce[i..i + 2], 16)
                            .map_err(|_| invalid("invalid regulatory nonce"))
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .try_into()
                    .map_err(|_| invalid("invalid regulatory nonce"))?;
                let bytes = URL_SAFE_NO_PAD
                    .decode(&document)
                    .map_err(|_| invalid("invalid regulatory encoding"))?;
                if URL_SAFE_NO_PAD.encode(&bytes) != document {
                    return Err(invalid("noncanonical regulatory encoding"));
                }
                let parsed = RegulatoryDocument::parse(&bytes, &serial, &challenge)?;
                let frames = parsed.fragments(mtu)?;
                self.document = Some(parsed);
                output(&frames)
            }
            Request::Notification { bytes } => {
                let Some(receipt) = self.assembler.push(&bytes)? else {
                    return output(&Value::Null);
                };
                self.receipt(&receipt)
            }
            Request::Receipt { bytes } => self.receipt(&bytes),
            Request::Clear => {
                self.document = None;
                self.assembler = RegulatoryReceiptAssembler::default();
                output(&Value::Null)
            }
        }
    }
    fn receipt(&self, bytes: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| invalid("regulatory operation missing"))?;
        match document.receipt(bytes)? {
            None => output(&Value::Null),
            Some(result) => public_output(
                json!({"result":result,"acknowledgement":URL_SAFE_NO_PAD.encode(bytes),
                "countryAlpha2":document.country,"revision":document.revision.to_string(),
                "bindingGeneration":document.generation.to_string(),"configId":document.config_id.iter().map(|b|format!("{b:02x}")).collect::<String>()}),
            ),
        }
    }
}
