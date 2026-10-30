//! Ephemeral local-control AEAD; never serializable or persisted.
use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as p,
};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroize;
const DOMAIN: &[u8] = p::LOCAL_WIFI_CONTROL_AAD;
fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::IntegrityFailed, Operation::Decode, false)
        .with_detail("local control authentication failed")
}
pub struct LocalWifiControl {
    tx: [u8; 40],
    rx: [u8; 40],
    session: u64,
    send: u32,
    receive: u32,
    device: bool,
}
impl Drop for LocalWifiControl {
    fn drop(&mut self) {
        self.tx.zeroize();
        self.rx.zeroize();
    }
}
impl LocalWifiControl {
    pub fn new(
        mut key: [u8; 32],
        transcript: [u8; 32],
        session: u64,
        device: bool,
    ) -> Result<Self, DeviceSdkError> {
        if key == [0; 32] || session == 0 {
            key.zeroize();
            return Err(invalid());
        }
        let hkdf = Hkdf::<Sha256>::new(Some(&transcript), &key);
        key.zeroize();
        let mut app = [0; 40];
        let mut peer = [0; 40];
        hkdf.expand(p::LOCAL_WIFI_CONTROL_APP_INFO, &mut app)
            .map_err(|_| invalid())?;
        hkdf.expand(p::LOCAL_WIFI_CONTROL_DEVICE_INFO, &mut peer)
            .map_err(|_| invalid())?;
        let value = if device {
            Self {
                tx: peer,
                rx: app,
                session,
                send: 0,
                receive: 0,
                device,
            }
        } else {
            Self {
                tx: app,
                rx: peer,
                session,
                send: 0,
                receive: 0,
                device,
            }
        };
        app.zeroize();
        peer.zeroize();
        Ok(value)
    }
    fn header(&self, bytes: &[u8], from_device: bool) -> Result<(), DeviceSdkError> {
        if bytes.len() < 12
            || bytes[1] != 2
            || bytes[2..4] != [0, 0]
            || bytes[4..12] != self.session.to_le_bytes()
        {
            return Err(invalid());
        }
        let valid = if from_device {
            matches!(
                bytes[0],
                p::LOCAL_WIFI_LINK_STATE | p::LOCAL_WIFI_PREPARED | p::LOCAL_WIFI_EOF
            )
        } else {
            matches!(
                bytes[0],
                p::LOCAL_WIFI_LINK_OPEN
                    | p::LOCAL_WIFI_LINK_QUERY
                    | p::LOCAL_WIFI_LINK_CLOSE
                    | p::LOCAL_WIFI_PREPARE
                    | p::LOCAL_WIFI_FINISH
            )
        };
        if !valid {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn seal(&mut self, frame: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
        self.header(frame, self.device)?;
        if frame.len() > 159 || self.send == u32::MAX {
            return Err(invalid());
        }
        let mut prefix = frame[..12].to_vec();
        prefix.extend_from_slice(&self.send.to_le_bytes());
        let mut aad = DOMAIN.to_vec();
        aad.extend_from_slice(&prefix);
        let mut nonce = [0; 12];
        nonce[..8].copy_from_slice(&self.tx[32..]);
        nonce[8..].copy_from_slice(&self.send.to_le_bytes());
        let cipher = ChaCha20Poly1305::new_from_slice(&self.tx[..32]).map_err(|_| invalid())?;
        let encrypted = cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: &frame[12..],
                    aad: &aad,
                },
            )
            .map_err(|_| invalid())?;
        self.send += 1;
        prefix.extend_from_slice(&encrypted);
        Ok(prefix)
    }
    pub fn open(&mut self, wire: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
        self.header(wire, !self.device)?;
        if !(32..=179).contains(&wire.len())
            || self.receive == u32::MAX
            || wire[12..16] != self.receive.to_le_bytes()
        {
            return Err(invalid());
        }
        let mut aad = DOMAIN.to_vec();
        aad.extend_from_slice(&wire[..16]);
        let mut nonce = [0; 12];
        nonce[..8].copy_from_slice(&self.rx[32..]);
        nonce[8..].copy_from_slice(&wire[12..16]);
        let cipher = ChaCha20Poly1305::new_from_slice(&self.rx[..32]).map_err(|_| invalid())?;
        let mut plain = cipher
            .decrypt(
                (&nonce).into(),
                Payload {
                    msg: &wire[16..],
                    aad: &aad,
                },
            )
            .map_err(|_| invalid())?;
        let mut frame = wire[..12].to_vec();
        frame.extend_from_slice(&plain);
        plain.zeroize();
        self.receive += 1;
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::protocol as p;
    use crate::protocol::encode_local_wifi_link;
    fn pair() -> (LocalWifiControl, LocalWifiControl) {
        (
            LocalWifiControl::new([7; 32], [8; 32], 41, false).unwrap(),
            LocalWifiControl::new([7; 32], [8; 32], 41, true).unwrap(),
        )
    }
    #[test]
    fn authenticates_direction_and_rejects_replay_or_mutation() {
        let (mut app, mut device) = pair();
        let query = encode_local_wifi_link(p::LOCAL_WIFI_LINK_QUERY, 41).unwrap();
        let wire = app.seal(&query).unwrap();
        assert_eq!(wire.len(), 32);
        assert!(app.open(&wire).is_err());
        assert_eq!(device.open(&wire).unwrap(), query);
        assert!(device.open(&wire).is_err());
        for offset in [0, 4, 12, 16, 31] {
            let (_, mut fresh) = pair();
            let mut wrong = wire.clone();
            wrong[offset] ^= 1;
            assert!(fresh.open(&wrong).is_err());
        }
    }
    #[test]
    fn fences_key_transcript_session_and_counter() {
        let (mut app, _) = pair();
        let wire = app
            .seal(&encode_local_wifi_link(p::LOCAL_WIFI_LINK_QUERY, 41).unwrap())
            .unwrap();
        for (key, transcript, session) in [
            ([9; 32], [8; 32], 41),
            ([7; 32], [9; 32], 41),
            ([7; 32], [8; 32], 42),
        ] {
            assert!(
                LocalWifiControl::new(key, transcript, session, true)
                    .unwrap()
                    .open(&wire)
                    .is_err()
            );
        }
        assert!(
            app.seal(&encode_local_wifi_link(p::LOCAL_WIFI_LINK_QUERY, 42).unwrap())
                .is_err()
        );
        app.send = u32::MAX;
        assert!(
            app.seal(&encode_local_wifi_link(p::LOCAL_WIFI_LINK_QUERY, 41).unwrap())
                .is_err()
        );
    }
}
