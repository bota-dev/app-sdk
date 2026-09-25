use bota_device_sdk_core::protocol::{
    CommonHeaderV2, EncryptedUploadV2Transfer, RecordingEntryV2,
    encode_encrypted_upload_v2_transfer,
};
use bota_device_sdk_ffi::*;
use std::{ptr, slice};

#[test]
fn additive_allocations_match_rust_and_the_native_header() {
    let header = include_str!("../include/bota_device_sdk.h");
    for (index, (name, id)) in [
        (
            "DECODE_ENCRYPTED_UPLOAD_V2_CATALOG",
            packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CATALOG,
        ),
        (
            "ENCODE_UPLOAD_CONTEXT_BEGIN",
            packet_kind::PROTOCOL_ENCODE_UPLOAD_CONTEXT_BEGIN,
        ),
        (
            "DECODE_UPLOAD_CONTEXT_SNAPSHOT",
            packet_kind::PROTOCOL_DECODE_UPLOAD_CONTEXT_SNAPSHOT,
        ),
        (
            "DECODE_UPLOAD_CONTEXT_DOCUMENT",
            packet_kind::PROTOCOL_DECODE_UPLOAD_CONTEXT_DOCUMENT,
        ),
        (
            "DECODE_ENCRYPTED_UPLOAD_V2_AUTHORIZATION_IDENTITY",
            packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_AUTHORIZATION_IDENTITY,
        ),
        (
            "VALIDATE_ENCRYPTED_UPLOAD_V2_ADMISSION",
            packet_kind::PROTOCOL_VALIDATE_ENCRYPTED_UPLOAD_V2_ADMISSION,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(id, 0x527 + index as u32);
        assert!(header.contains(&format!("BOTA_DEVICE_SDK_V1_PROTOCOL_{name} = 0x{id:04x};")));
    }
    for (index, (name, id)) in [
        ("CONTEXT_ATTEMPT_ID", field_id::CONTEXT_ATTEMPT_ID),
        ("CONTEXT_STATE", field_id::CONTEXT_STATE),
        ("AUTHORIZATION_CHANNELS", field_id::AUTHORIZATION_CHANNELS),
        ("MIN_CIPHERTEXT_LENGTH", field_id::MIN_CIPHERTEXT_LENGTH),
        ("MAX_CIPHERTEXT_LENGTH", field_id::MAX_CIPHERTEXT_LENGTH),
        (
            "REQUIRE_EXPIRED_SESSION_RECOVERY",
            field_id::REQUIRE_EXPIRED_SESSION_RECOVERY,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(id, 199 + index as u32);
        assert!(header.contains(&format!("BOTA_DEVICE_SDK_V1_FIELD_{name} = {id};")));
    }
}

struct Engine(*mut BotaDeviceSdkEngineV1);
impl Engine {
    fn new() -> Self {
        Self(bota_device_sdk_v1_engine_new())
    }
    fn call(
        &self,
        input: BotaDeviceSdkPacketV1,
        encode: bool,
    ) -> Result<Vec<Field>, BotaDeviceSdkStatusV1> {
        let mut output = ptr::null_mut();
        let call = if encode {
            bota_device_sdk_v1_protocol_encode
        } else {
            bota_device_sdk_v1_protocol_decode
        };
        let status = unsafe { call(self.0, &input.view(), &mut output) };
        if status != BotaDeviceSdkStatusV1::Ok {
            assert!(output.is_null());
            return Err(status);
        }
        let mut view = BotaDeviceSdkPacketViewV1::default();
        assert_eq!(
            unsafe { bota_device_sdk_v1_packet_view(output, &mut view) },
            BotaDeviceSdkStatusV1::Ok
        );
        assert_eq!(view.kind, input.view().kind);
        let fields = if view.field_count == 0 {
            vec![]
        } else {
            unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) }
                .iter()
                .map(|f| Field {
                    id: f.field_id,
                    ty: f.field_type,
                    value: f.unsigned_value,
                    bytes: if f.data.len == 0 {
                        vec![]
                    } else {
                        unsafe { slice::from_raw_parts(f.data.data, f.data.len as usize) }.to_vec()
                    },
                })
                .collect()
        };
        unsafe { bota_device_sdk_v1_packet_free(output) };
        Ok(fields)
    }
    fn catalog(&self, session: u64, bytes: Vec<u8>) -> Result<Vec<Field>, BotaDeviceSdkStatusV1> {
        self.call(packet(0x527, bytes).with_u64(128, session), false)
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { bota_device_sdk_v1_engine_free(self.0) };
    }
}
#[derive(Debug, PartialEq)]
struct Field {
    id: u32,
    ty: u32,
    value: u64,
    bytes: Vec<u8>,
}
fn packet(kind: u32, bytes: Vec<u8>) -> BotaDeviceSdkPacketV1 {
    BotaDeviceSdkPacketV1::new(kind).with_bytes(30, bytes)
}
fn get(fields: &[Field], id: u32) -> &Field {
    fields.iter().find(|f| f.id == id).unwrap()
}
fn capabilities(flags: u32) -> Vec<u8> {
    let mut bytes = vec![1, 2, 24, 0];
    bytes.extend(flags.to_le_bytes());
    for value in [408_u16, 580, 128, 8] {
        bytes.extend(value.to_le_bytes());
    }
    bytes.extend(4_u32.to_le_bytes());
    bytes.extend([8, 0, 0, 0]);
    bytes
}
fn entry(session: u64, id: u32) -> Vec<u8> {
    let mut uuid = [1; 16];
    uuid[..4].copy_from_slice(&id.to_le_bytes());
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::RecordingEntry(
        RecordingEntryV2 {
            common: CommonHeaderV2 {
                message_type: 0x48,
                flags: 0,
                transport_session_id: session,
            },
            recording_uuid: uuid,
            recording_generation: 7,
            storage_format: 3,
            completion_state: 1,
            started_at: u64::MAX,
            duration_seconds: u32::MAX,
            plaintext_length: u64::MAX - 1,
            ciphertext_length: u64::MAX,
            ciphertext_sha256: [0xa5; 32],
        },
    ))
    .unwrap()
}
fn end(session: u64, count: u32, digest: [u8; 32]) -> Vec<u8> {
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::RecordingListEnd {
        common: CommonHeaderV2 {
            message_type: 0x49,
            flags: 0,
            transport_session_id: session,
        },
        count,
        list_revision: 19,
        list_sha256: digest,
    })
    .unwrap()
}
fn snapshot(state: u8, result: u16, payload: &[u8]) -> Vec<u8> {
    let mut value = vec![0x66, 2, state, 0];
    value.extend(7_u32.to_le_bytes());
    value.extend(result.to_le_bytes());
    value.extend((payload.len() as u16).to_le_bytes());
    value.extend(payload);
    value
}
fn document(kind: u8) -> Vec<u8> {
    let length: u16 = if kind == 3 { 196 } else { 264 };
    let mut bytes = vec![0; length as usize];
    bytes[..8].copy_from_slice(if kind == 3 { b"BOTACTXQ" } else { b"BOTACTXR" });
    bytes[8..12].copy_from_slice(&[1, 0, length as u8, (length >> 8) as u8]);
    bytes
}

#[test]
fn context_begin_and_complete_snapshots_use_typed_fields() {
    let engine = Engine::new();
    let output = engine
        .call(BotaDeviceSdkPacketV1::new(0x528).with_u64(199, 7), true)
        .unwrap();
    assert_eq!(get(&output, 30).bytes, [0x65, 2, 0, 0, 7, 0, 0, 0]);
    for (state, result, payload) in [
        (0, 0, vec![]),
        (1, 0, vec![1; 16]),
        (2, 0, vec![3; 116]),
        (2, 0, vec![4; 366]),
        (3, 0, vec![]),
        (4, 6, vec![]),
    ] {
        let output = engine
            .call(packet(0x529, snapshot(state, result, &payload)), false)
            .unwrap();
        assert_eq!(
            output.iter().map(|f| f.id).collect::<Vec<_>>(),
            [199, 200, 24, 33]
        );
        assert_eq!(get(&output, 199).value, 7);
        assert_eq!(get(&output, 200).value, state as u64);
        assert_eq!(get(&output, 24).value, result as u64);
        assert_eq!(get(&output, 33).bytes, payload);
    }
    for attempt in [0, u32::MAX as u64 + 1] {
        assert!(
            engine
                .call(
                    BotaDeviceSdkPacketV1::new(0x528).with_u64(199, attempt),
                    true
                )
                .is_err()
        );
    }
    for bytes in [
        snapshot(1, 0, &[0; 16]),
        snapshot(2, 0, &[1; 115]),
        snapshot(2, 0, &[1; 367]),
        snapshot(4, 0, &[]),
        snapshot(3, 1, &[]),
        snapshot(5, 0, &[]),
        snapshot(1, 0, &[1; 16])[..12].to_vec(),
    ] {
        assert!(engine.call(packet(0x529, bytes), false).is_err());
    }
}

#[test]
fn context_documents_and_signed_blob_kinds_remain_opaque_and_bounded() {
    let engine = Engine::new();
    for kind in [3_u8, 4] {
        let bytes = document(kind);
        let output = engine
            .call(
                packet(0x52a, bytes.clone()).with_u64(151, kind as u64),
                false,
            )
            .unwrap();
        assert_eq!(output.len(), 2);
        assert_eq!(get(&output, 150).value, bytes.len() as u64);
        let begin = BotaDeviceSdkPacketV1::new(0x523)
            .with_u64(127, 0x60)
            .with_u64(151, kind as u64)
            .with_u64(152, 7)
            .with_u64(150, bytes.len() as u64)
            .with_bytes(123, vec![1; 32]);
        let framed = engine.call(begin, true).unwrap();
        let decoded = engine
            .call(packet(0x521, get(&framed, 30).bytes.clone()), false)
            .unwrap();
        assert_eq!(get(&decoded, 151).value, kind as u64);
        for offset in [0, 8, 10] {
            let mut bad = bytes.clone();
            bad[offset] ^= 1;
            assert!(
                engine
                    .call(packet(0x52a, bad).with_u64(151, kind as u64), false)
                    .is_err()
            );
        }
        let mut long = bytes;
        long.push(0);
        assert!(
            engine
                .call(packet(0x52a, long).with_u64(151, kind as u64), false)
                .is_err()
        );
    }
}

#[test]
fn capabilities_distinguish_readiness_admission_and_expired_recovery() {
    let engine = Engine::new();
    for flags in [0, 0x7f, 0x17f, 0x37f, 0x3ff] {
        assert!(
            engine
                .call(packet(0x520, capabilities(flags)), false)
                .is_ok()
        );
        for recovery in [false, true] {
            let result = engine.call(
                packet(0x52c, capabilities(flags)).with_bool(204, recovery),
                false,
            );
            let mask = if recovery { 0x37f } else { 0x17f };
            assert_eq!(
                result.is_ok(),
                flags & mask == mask,
                "flags={flags:x} recovery={recovery}"
            );
        }
    }
    assert!(
        engine
            .call(packet(0x520, capabilities(0x400)), false)
            .is_err()
    );
    assert!(
        engine
            .call(
                packet(0x52c, capabilities(0x77f)).with_bool(204, true),
                false
            )
            .is_err()
    );
}

#[test]
fn authorization_identity_extraction_is_typed_not_a_trust_decision() {
    let engine = Engine::new();
    let mut bytes = vec![0; 408];
    bytes[..8].copy_from_slice(b"BOTAAUT2");
    bytes[8..12].copy_from_slice(&[2, 0, 152, 1]);
    bytes[13..17].copy_from_slice(&[3, 3, 2, 1]);
    bytes[30..32].copy_from_slice(&8_u16.to_le_bytes());
    bytes[32..36].copy_from_slice(&3_u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&7_u32.to_le_bytes());
    bytes[72..80].copy_from_slice(&u64::MAX.to_le_bytes());
    bytes[80..88].copy_from_slice(&u64::MAX.to_le_bytes());
    bytes[88..104].fill(0x12);
    bytes[120..136].fill(0x34);
    bytes[312..344].fill(0x56);
    let output = engine.call(packet(0x52b, bytes.clone()), false).unwrap();
    for (id, expected) in [
        (154, 3),
        (147, 3),
        (167, 2),
        (201, 1),
        (69, 8),
        (165, 3),
        (129, 7),
        (202, u64::MAX),
        (203, u64::MAX),
    ] {
        assert_eq!(get(&output, id).value, expected);
    }
    assert_eq!(get(&output, 132).bytes, [0x12; 16]);
    assert_eq!(get(&output, 144).bytes, [0x56; 32]);
    assert_eq!(
        get(&output, 13).bytes,
        b"34343434-3434-3434-3434-343434343434"
    );
    for index in [0, 8, 10] {
        let mut bad = bytes.clone();
        bad[index] ^= 1;
        assert!(engine.call(packet(0x52b, bad), false).is_err());
    }
}

#[test]
fn existing_recording_codec_exposes_every_metadata_field_without_precision_loss() {
    let engine = Engine::new();
    let output = engine.call(packet(0x522, entry(7, 1)), false).unwrap();
    for (id, expected) in [
        (129, 7),
        (147, 3),
        (146, 1),
        (68, u64::MAX),
        (149, u32::MAX as u64),
        (131, u64::MAX - 1),
        (130, u64::MAX),
    ] {
        assert_eq!(get(&output, id).value, expected);
    }
    assert_eq!(get(&output, 144).bytes, [0xa5; 32]);
    let output = engine
        .call(packet(0x522, end(7, 3, [9; 32])), false)
        .unwrap();
    assert_eq!(get(&output, 85).value, 3);
    assert_eq!(get(&output, 148).value, 19);
    assert_eq!(get(&output, 123).bytes, [9; 32]);
}

#[test]
fn catalog_is_explicitly_armed_and_consumes_empty_end_and_failures() {
    let engine = Engine::new();
    let empty_hash = [
        0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9,
        0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52,
        0xb8, 0x55,
    ];
    assert!(engine.catalog(7, end(7, 0, empty_hash)).is_err());
    assert!(engine.catalog(7, vec![]).unwrap().is_empty());
    let output = engine.catalog(7, end(7, 0, empty_hash)).unwrap();
    assert_eq!(get(&output, 85).value, 0);
    assert_eq!(get(&output, 148).value, 19);
    assert!(engine.catalog(7, end(7, 0, empty_hash)).is_err());
    assert!(engine.catalog(7, vec![]).unwrap().is_empty());
    assert!(engine.catalog(7, entry(7, 1)).unwrap().is_empty());
    assert!(engine.catalog(7, entry(7, 1)).is_err());
    assert!(engine.catalog(7, end(7, 0, empty_hash)).is_err());
}

#[test]
fn catalog_returns_ordered_typed_entries_and_is_engine_local() {
    let first = Engine::new();
    let second = Engine::new();
    let digest = [
        0x32, 0x49, 0x40, 0x42, 0xcd, 0x07, 0x35, 0x9d, 0x68, 0x07, 0xe8, 0x58, 0x1a, 0xb5, 0xa1,
        0x22, 0x5a, 0xb3, 0x22, 0x81, 0x33, 0x6b, 0xed, 0xde, 0x98, 0xdf, 0xf2, 0x43, 0x6b, 0x72,
        0x2b, 0x44,
    ];
    first.catalog(7, vec![]).unwrap();
    second.catalog(8, vec![]).unwrap();
    first.catalog(7, entry(7, 1)).unwrap();
    assert!(second.catalog(7, end(7, 1, digest)).is_err());
    let output = first.catalog(7, end(7, 1, digest)).unwrap();
    assert_eq!(
        output.iter().map(|f| f.id).collect::<Vec<_>>(),
        [128, 85, 148, 123, 13, 129, 147, 146, 68, 149, 131, 130, 144]
    );
    assert_eq!(get(&output, 13).ty, field_type::UTF8);
    assert_eq!(get(&output, 144).ty, field_type::BYTES);
    assert_eq!(get(&output, 68).ty, field_type::UNSIGNED);
    assert_eq!(get(&output, 68).value, u64::MAX);
    assert_eq!(get(&output, 131).value, u64::MAX - 1);
    // Owned result copies survive subsequent catalog reset and engine destruction.
    first.catalog(9, vec![]).unwrap();
    drop(first);
    assert_eq!(get(&output, 123).bytes, digest);
}

#[test]
fn catalog_envelope_failures_clear_state_and_null_the_output() {
    let engine = Engine::new();
    for bad in [
        packet(0x527, vec![]).with_u64(128, 7).with_u64(199, 1),
        packet(0x527, vec![]).with_u64(128, 7).with_u64(128, 7),
        packet(0x527, vec![]).with_text(128, "7"),
        packet(0x527, vec![]).with_u64(128, 7).with_operation(1),
        packet(0x527, vec![]).with_u64(128, 7).with_request_id(1),
        packet(0x527, vec![])
            .with_u64(128, 7)
            .with_cancellation_id(1, 1),
    ] {
        engine.catalog(7, vec![]).unwrap();
        engine.catalog(7, entry(7, 1)).unwrap();
        assert!(engine.call(bad, false).is_err());
        assert!(engine.catalog(7, entry(7, 2)).is_err());
    }
    for unsupported_abi in [false, true] {
        engine.catalog(7, vec![]).unwrap();
        let input = packet(0x527, entry(7, 1)).with_u64(128, 7);
        let mut view = input.view();
        if unsupported_abi {
            view.abi_version = 2;
        } else {
            view.reserved = 1;
        }
        let mut output = ptr::dangling_mut();
        let expected = if unsupported_abi {
            BotaDeviceSdkStatusV1::UnsupportedAbi
        } else {
            BotaDeviceSdkStatusV1::OperationFailed
        };
        assert_eq!(
            unsafe { bota_device_sdk_v1_protocol_decode(engine.0, &view, &mut output) },
            expected
        );
        assert!(output.is_null());
        assert!(engine.catalog(7, entry(7, 2)).is_err());
    }
}

#[test]
fn all_new_codecs_reject_missing_extra_duplicate_and_mistyped_inputs() {
    let engine = Engine::new();
    for (kind, encode) in [
        (0x528, true),
        (0x529, false),
        (0x52a, false),
        (0x52b, false),
        (0x52c, false),
    ] {
        for bad in [
            BotaDeviceSdkPacketV1::new(kind),
            BotaDeviceSdkPacketV1::new(kind).with_text(30, "opaque"),
            packet(kind, vec![]).with_bytes(30, vec![]),
            packet(kind, vec![]).with_u64(999, 1),
        ] {
            assert!(engine.call(bad, encode).is_err());
        }
    }
    assert!(
        engine
            .call(BotaDeviceSdkPacketV1::new(0x528).with_text(199, "1"), true)
            .is_err()
    );
    assert!(
        engine
            .call(packet(0x52a, document(3)).with_u64(151, 4), false)
            .is_err()
    );
    assert!(
        engine
            .call(packet(0x52a, document(3)).with_u64(151, 5), false)
            .is_err()
    );
    assert!(
        engine
            .call(packet(0x52c, capabilities(0x37f)).with_u64(204, 1), false)
            .is_err()
    );
    for index in [0, 1, 3, 4, 8, 10] {
        let mut bytes = snapshot(1, 0, &[1; 16]);
        bytes[index] = if index == 4 { 0 } else { 0xff };
        assert!(engine.call(packet(0x529, bytes), false).is_err());
    }
    for length in 0..28 {
        assert!(
            engine
                .call(
                    packet(0x529, snapshot(1, 0, &[1; 16])[..length].to_vec()),
                    false
                )
                .is_err()
        );
    }
    let mut trailing = snapshot(3, 0, &[]);
    trailing.push(0);
    assert!(engine.call(packet(0x529, trailing), false).is_err());
    for bit in 10..32 {
        assert!(
            engine
                .call(packet(0x520, capabilities(0x37f | (1 << bit))), false)
                .is_err()
        );
    }
    for bit in [0, 1, 2, 3, 4, 5, 6, 8, 9] {
        assert!(
            engine
                .call(
                    packet(0x52c, capabilities(0x37f & !(1 << bit))).with_bool(204, true),
                    false
                )
                .is_err()
        );
    }
    for offset in [8, 10, 12, 14, 16, 20] {
        let mut bytes = capabilities(0x37f);
        bytes[offset] = 0;
        bytes[offset + 1] = 0;
        assert!(
            engine
                .call(packet(0x52c, bytes).with_bool(204, true), false)
                .is_err()
        );
    }
}

#[test]
fn context_blob_data_commit_abort_result_share_the_existing_wire_codec() {
    let engine = Engine::new();
    for (kind, length) in [(3_u64, 196_u64), (4, 264)] {
        for code in [0x61, 0x62, 0x63] {
            let mut input = BotaDeviceSdkPacketV1::new(0x523)
                .with_u64(127, code)
                .with_u64(151, kind)
                .with_u64(152, 7);
            if code == 0x61 {
                input = input
                    .with_u64(39, length - 2)
                    .with_bytes(30, vec![0xaa, 0xbb]);
            }
            let output = engine.call(input, true).unwrap();
            let wire = &get(&output, 30).bytes;
            assert_eq!(wire[..8], [code as u8, 2, kind as u8, 0, 7, 0, 0, 0]);
            let fields = engine.call(packet(0x521, wire.clone()), false).unwrap();
            assert_eq!(get(&fields, 151).value, kind);
        }
        let result = vec![0x64, 2, kind as u8, 0, 7, 0, 0, 0, 6, 0];
        assert_eq!(
            get(&engine.call(packet(0x521, result), false).unwrap(), 155).value,
            6
        );
        for (offset, data) in [(length, vec![1]), (0, vec![])] {
            assert!(
                engine
                    .call(
                        BotaDeviceSdkPacketV1::new(0x523)
                            .with_u64(127, 0x61)
                            .with_u64(151, kind)
                            .with_u64(152, 7)
                            .with_u64(39, offset)
                            .with_bytes(30, data),
                        true
                    )
                    .is_err()
            );
        }
        assert!(
            engine
                .call(
                    BotaDeviceSdkPacketV1::new(0x523)
                        .with_u64(127, 0x60)
                        .with_u64(151, kind)
                        .with_u64(152, 7)
                        .with_u64(150, length + 1)
                        .with_bytes(123, vec![1; 32]),
                    true
                )
                .is_err()
        );
    }
}
