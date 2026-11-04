//! One-use personal WiFi encryption. The backend delivers the same random key
//! over authenticated HTTPS and in a signed, device-targeted HPKE envelope.
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as p,
};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::IntegrityFailed, Operation::Provision, false)
        .with_detail("secure WiFi configuration authentication failed")
}

pub struct WifiProvisioning {
    tx: [u8; 44],
    rx: [u8; 44],
    request: u64,
    action: u8,
    sent: bool,
    finished: bool,
}
impl Drop for WifiProvisioning {
    fn drop(&mut self) {
        self.tx.zeroize();
        self.rx.zeroize();
    }
}
impl WifiProvisioning {
    pub fn new(
        mut key: [u8; 32],
        grant: &[u8],
        request: u64,
        action: u8,
    ) -> Result<Self, DeviceSdkError> {
        let result = (|| {
            if key == [0; 32]
                || request == 0
                || ![1, 2].contains(&action)
                || wifi_provisioning_version(grant).is_err()
                || grant[8..14] != [0, 16, 0, 1, 0, 3]
                || grant[14] > 2
                || grant[15] != action
                || grant[52] != 4
            {
                return Err(invalid());
            }
            let hkdf = Hkdf::<Sha256>::new(Some(&Sha256::digest(grant)), &key);
            let mut result = Self {
                tx: [0; 44],
                rx: [0; 44],
                request,
                action,
                sent: false,
                finished: false,
            };
            hkdf.expand(p::WIFI_PROVISIONING_APP_INFO, &mut result.tx)
                .map_err(|_| invalid())?;
            hkdf.expand(p::WIFI_PROVISIONING_DEVICE_INFO, &mut result.rx)
                .map_err(|_| invalid())?;
            Ok(result)
        })();
        key.zeroize();
        result
    }
    fn header(&self, kind: u8) -> [u8; 12] {
        let mut h = [0xb2, kind, self.action, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        h[4..].copy_from_slice(&self.request.to_le_bytes());
        h
    }
    pub fn seal_credentials(
        &mut self,
        ssid: &str,
        password: &str,
    ) -> Result<Vec<u8>, DeviceSdkError> {
        if self.sent || self.finished {
            return Err(invalid());
        }
        // A failed attempt also retires the key; never reuse a one-shot nonce.
        self.sent = true;
        if ssid.len() > 32
            || password.len() > 64
            || ssid.contains('\0')
            || password.contains('\0')
            || (self.action == 1 && ssid.is_empty())
            || (self.action == 2 && (!ssid.is_empty() || !password.is_empty()))
        {
            self.finished = true;
            return Err(invalid());
        }
        let mut plaintext = Zeroizing::new(Vec::with_capacity(98));
        plaintext.extend_from_slice(&[ssid.len() as u8, password.len() as u8]);
        plaintext.extend_from_slice(ssid.as_bytes());
        plaintext.extend_from_slice(password.as_bytes());
        let header = self.header(1);
        let aad = [p::WIFI_PROVISIONING_AAD, &header].concat();
        let cipher = ChaCha20Poly1305::new_from_slice(&self.tx[..32]).map_err(|_| invalid())?;
        let nonce: [u8; 12] = self.tx[32..].try_into().map_err(|_| invalid())?;
        let encrypted = cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| invalid());
        self.tx.zeroize();
        match encrypted {
            Ok(body) => Ok([header.as_slice(), &body].concat()),
            Err(e) => {
                self.finished = true;
                Err(e)
            }
        }
    }
    pub fn open_result(&mut self, wire: &[u8]) -> Result<u8, DeviceSdkError> {
        let valid = self.sent && !self.finished;
        self.finished = true;
        let result = (|| {
            if !valid || wire.len() != 29 || wire[..12] != self.header(2) {
                return Err(invalid());
            }
            let aad = [p::WIFI_PROVISIONING_AAD, &wire[..12]].concat();
            let cipher = ChaCha20Poly1305::new_from_slice(&self.rx[..32]).map_err(|_| invalid())?;
            let nonce: [u8; 12] = self.rx[32..].try_into().map_err(|_| invalid())?;
            let plain = Zeroizing::new(
                cipher
                    .decrypt(
                        (&nonce).into(),
                        Payload {
                            msg: &wire[12..],
                            aad: &aad,
                        },
                    )
                    .map_err(|_| invalid())?,
            );
            if plain.len() != 1 || plain[0] > 4 {
                return Err(invalid());
            }
            Ok(plain[0])
        })();
        self.rx.zeroize();
        result
    }
}

pub fn wifi_provisioning_grant_chunks(
    grant: &[u8],
    capacity: usize,
) -> Result<Vec<Vec<u8>>, DeviceSdkError> {
    if wifi_provisioning_version(grant).is_err() || !(20..=512).contains(&capacity) {
        return Err(invalid());
    }
    Ok(grant
        .chunks(capacity - 6)
        .enumerate()
        .map(|(i, bytes)| {
            let mut frame = vec![0xb2, 0];
            frame.extend_from_slice(&((i * (capacity - 6)) as u16).to_le_bytes());
            frame.extend_from_slice(&(grant.len() as u16).to_le_bytes());
            frame.extend_from_slice(bytes);
            frame
        })
        .collect())
}

/// Version is explicit; v3 adds binding proof without changing credential frames.
pub fn wifi_provisioning_version(grant: &[u8]) -> Result<u8, DeviceSdkError> {
    match grant.len() {
        509 if &grant[..8] == p::WIFI_PROVISIONING_MAGIC => Ok(2),
        541 if &grant[..8] == p::WIFI_PROVISIONING_V3_MAGIC => Ok(3),
        _ => Err(invalid()),
    }
}
pub fn validate_wifi_provisioning_capability(bytes: &[u8]) -> Result<u8, DeviceSdkError> {
    match bytes {
        [0xb2, 2, 7, 0, 253, 1, 126, 0] => Ok(2),
        [0xb2, 3, 7, 0, 29, 2, 126, 0] => Ok(3),
        _ => Err(DeviceSdkError::new(
            ErrorCode::UnsupportedCapability,
            Operation::Provision,
            false,
        )
        .with_detail("device requires supported secure WiFi provisioning firmware")),
    }
}
