use bota_device_sdk_ffi::{
    BotaDeviceSdkEngineV1, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, BotaDeviceSdkStatusV1,
    bota_device_sdk_v1_engine_free, bota_device_sdk_v1_engine_new, bota_device_sdk_v1_packet_free,
    bota_device_sdk_v1_packet_view, bota_device_sdk_v1_protocol_decode,
    bota_device_sdk_v1_protocol_encode, field_type,
};
use std::{ptr, slice};

// Literal allocations intentionally freeze the native contract, independently of Rust names.
const DECODE: u32 = 0x0525;
const ENCODE: u32 = 0x0526;

struct Engine(*mut BotaDeviceSdkEngineV1);
impl Engine {
    fn new() -> Self {
        Self(bota_device_sdk_v1_engine_new())
    }
    fn decode(&self, bytes: &[u8]) -> Result<Vec<Field>, BotaDeviceSdkStatusV1> {
        self.call(
            &BotaDeviceSdkPacketV1::new(DECODE).with_bytes(30, bytes.to_vec()),
            false,
        )
    }
    fn call(
        &self,
        packet: &BotaDeviceSdkPacketV1,
        encode: bool,
    ) -> Result<Vec<Field>, BotaDeviceSdkStatusV1> {
        let mut output = ptr::null_mut();
        let call = if encode {
            bota_device_sdk_v1_protocol_encode
        } else {
            bota_device_sdk_v1_protocol_decode
        };
        let status = unsafe { call(self.0, &packet.view(), &mut output) };
        if status != BotaDeviceSdkStatusV1::Ok {
            assert!(output.is_null());
            return Err(status);
        }
        let mut view = BotaDeviceSdkPacketViewV1::default();
        assert_eq!(
            unsafe { bota_device_sdk_v1_packet_view(output, &mut view) },
            BotaDeviceSdkStatusV1::Ok
        );
        assert_eq!(view.kind, if encode { ENCODE } else { DECODE });
        let fields = if view.field_count == 0 {
            vec![]
        } else {
            unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) }
                .iter()
                .map(|field| Field {
                    id: field.field_id,
                    ty: field.field_type,
                    unsigned: field.unsigned_value,
                    signed: field.signed_value,
                    bytes: if field.data.len == 0 {
                        vec![]
                    } else {
                        unsafe { slice::from_raw_parts(field.data.data, field.data.len as usize) }
                            .to_vec()
                    },
                })
                .collect()
        };
        unsafe { bota_device_sdk_v1_packet_free(output) };
        Ok(fields)
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
    unsigned: u64,
    signed: i64,
    bytes: Vec<u8>,
}
fn text(id: u32, value: &str) -> Field {
    Field {
        id,
        ty: field_type::UTF8,
        unsigned: 0,
        signed: 0,
        bytes: value.as_bytes().to_vec(),
    }
}
fn unsigned(id: u32, value: u64) -> Field {
    Field {
        id,
        ty: field_type::UNSIGNED,
        unsigned: value,
        signed: 0,
        bytes: vec![],
    }
}
fn signed(id: u32, value: i64) -> Field {
    Field {
        id,
        ty: field_type::SIGNED,
        unsigned: 0,
        signed: value,
        bytes: vec![],
    }
}
fn event(engine: &Engine, index: u8, report: bool) {
    let mut meta = vec![0x90, index, 3, 5, 0];
    meta.extend(982341_u32.to_le_bytes());
    meta.extend((42 + u64::from(index)).to_le_bytes());
    assert!(engine.decode(&meta).unwrap().is_empty());
    let mut signature = vec![0x91, index];
    signature.extend(0x0123456789abcdef_u64.to_le_bytes());
    assert!(engine.decode(&signature).unwrap().is_empty());
    let mut detail = [0; 176];
    detail[..2].copy_from_slice(&[1, u8::from(report)]);
    detail[2..14].copy_from_slice(b"a4f02973d61c");
    detail[15..20].copy_from_slice(&[2, 0, 1, 1, 3]);
    detail[20] = 8;
    detail[40..44].copy_from_slice(&0x80001234_u32.to_le_bytes());
    detail[44..48].copy_from_slice(&0x40005678_u32.to_le_bytes());
    detail[48..52].copy_from_slice(&0x4118_u32.to_le_bytes());
    detail[72..76].copy_from_slice(&18320_u32.to_le_bytes());
    detail[76..80].copy_from_slice(&u32::MAX.to_le_bytes());
    detail[80..87].copy_from_slice(b"btstack");
    detail[96..100].copy_from_slice(&(-210_i32).to_le_bytes());
    detail[100] = 3;
    detail[102..106].copy_from_slice(&i32::MIN.to_le_bytes());
    for (part, bytes) in detail.chunks(14).enumerate() {
        let mut packet = vec![0x95, index];
        packet.extend((part as u16 * 14).to_le_bytes());
        packet.extend(176_u16.to_le_bytes());
        packet.extend(bytes);
        assert!(engine.decode(&packet).unwrap().is_empty());
    }
}

#[test]
fn encoder_uses_typed_commands_and_canonical_event_id() {
    let engine = Engine::new();
    for (command, id, expected) in [
        (0x10, None, vec![0x10]),
        (
            0x11,
            Some("0123456789abcdef"),
            vec![0x11, 0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 1],
        ),
    ] {
        let mut input = BotaDeviceSdkPacketV1::new(ENCODE).with_u64(97, command);
        if let Some(id) = id {
            input = input.with_text(173, id);
        }
        assert_eq!(
            engine.call(&input, true).unwrap(),
            vec![Field {
                id: 30,
                ty: field_type::BYTES,
                unsigned: 0,
                signed: 0,
                bytes: expected,
            }]
        );
    }
    for input in [
        BotaDeviceSdkPacketV1::new(ENCODE).with_u64(97, 0x11),
        BotaDeviceSdkPacketV1::new(ENCODE)
            .with_u64(97, 0x11)
            .with_text(173, "ABC"),
        BotaDeviceSdkPacketV1::new(ENCODE)
            .with_u64(97, 0x11)
            .with_u64(173, 42),
        BotaDeviceSdkPacketV1::new(ENCODE)
            .with_u64(97, 0x10)
            .with_text(173, "000000000000002a"),
        BotaDeviceSdkPacketV1::new(ENCODE).with_u64(97, 0x12),
    ] {
        assert_eq!(
            engine.call(&input, true),
            Err(BotaDeviceSdkStatusV1::OperationFailed)
        );
    }
}

#[test]
fn final_batch_is_typed_and_groups_every_field_by_event_id() {
    let engine = Engine::new();
    event(&engine, 0, true);
    event(&engine, 1, false);
    let fields = engine.decode(&[0x92, 2]).unwrap();
    let common = |id: &str, report: bool| {
        vec![
            text(173, id),
            text(174, "hard_fault"),
            text(175, "cpu_usage_fault"),
            unsigned(176, 982341),
            text(177, "0123456789abcdef"),
            text(178, "a4f02973d61c"),
            text(179, "system"),
            text(180, "recording"),
            Field {
                id: 181,
                ty: field_type::BOOL,
                unsigned: u64::from(report),
                signed: 0,
                bytes: vec![],
            },
        ]
    };
    let mut expected = vec![unsigned(171, 1), unsigned(172, 2)];
    expected.extend(common("000000000000002a", true));
    expected.extend([
        unsigned(182, 0),
        text(183, "00000008"),
        text(184, "00000000"),
        text(185, "00000000"),
        text(186, "00000000"),
        text(187, "00000000"),
        text(188, "btstack"),
        text(189, "sdram:00001234"),
        text(190, "ram:00005678"),
        unsigned(191, 1),
        text(192, "rom:00004118"),
        unsigned(193, 18320),
        unsigned(194, u64::from(u32::MAX)),
        unsigned(195, 1),
        signed(196, -210),
        text(197, "recording_started"),
        signed(198, i64::from(i32::MIN)),
    ]);
    expected.extend(common("000000000000002b", false));
    assert_eq!(fields, expected);
    assert_eq!(
        engine.decode(&[0x92, 0]).unwrap(),
        vec![unsigned(171, 1), unsigned(172, 0)]
    );
}

#[test]
fn decoders_are_engine_scoped_and_reset_on_new_reads_and_invalid_input() {
    let first = Engine::new();
    let second = Engine::new();
    event(&first, 0, true);
    assert!(second.decode(&[0x92, 1]).is_err());
    assert!(!first.decode(&[0x92, 1]).unwrap().is_empty());
    event(&first, 0, false);
    assert!(first.decode(&[]).unwrap().is_empty());
    assert!(first.decode(&[0x92, 1]).is_err());
    for bad in [
        BotaDeviceSdkPacketV1::new(DECODE).with_bytes(30, vec![0x95; 21]),
        BotaDeviceSdkPacketV1::new(DECODE).with_text(30, "not bytes"),
        BotaDeviceSdkPacketV1::new(DECODE)
            .with_bytes(30, vec![0x92, 1])
            .with_u64(97, 0x10),
        BotaDeviceSdkPacketV1::new(DECODE),
        BotaDeviceSdkPacketV1::new(DECODE)
            .with_bytes(30, vec![0x92, 1])
            .with_bytes(30, vec![0x92, 1]),
    ] {
        event(&first, 0, true);
        assert!(first.call(&bad, false).is_err());
        assert!(first.decode(&[0x92, 1]).is_err());
    }
}

#[test]
fn invalid_packet_envelope_clears_diagnostics_and_never_returns_a_stale_output() {
    let engine = Engine::new();
    for input in [
        BotaDeviceSdkPacketV1::new(DECODE)
            .with_bytes(30, vec![0x92, 1])
            .with_operation(1),
        BotaDeviceSdkPacketV1::new(DECODE)
            .with_bytes(30, vec![0x92, 1])
            .with_request_id(1),
        BotaDeviceSdkPacketV1::new(DECODE)
            .with_bytes(30, vec![0x92, 1])
            .with_cancellation_id(1, 1),
    ] {
        event(&engine, 0, false);
        assert_eq!(
            engine.call(&input, false),
            Err(BotaDeviceSdkStatusV1::OperationFailed)
        );
        assert!(engine.decode(&[0x92, 1]).is_err());
    }
    event(&engine, 0, true);
    let input = BotaDeviceSdkPacketV1::new(DECODE).with_bytes(30, vec![0x92, 1]);
    let mut view = input.view();
    view.abi_version = 2;
    let mut output = std::ptr::dangling_mut();
    assert_eq!(
        unsafe { bota_device_sdk_v1_protocol_decode(engine.0, &view, &mut output) },
        BotaDeviceSdkStatusV1::UnsupportedAbi
    );
    assert!(output.is_null());
    assert!(engine.decode(&[0x92, 1]).is_err());
}

#[test]
fn final_batch_supports_more_than_the_input_field_limit_without_raw_payloads() {
    let engine = Engine::new();
    for index in 0..10 {
        event(&engine, index, true);
    }
    let batch = engine.decode(&[0x92, 10]).unwrap();
    assert!(batch.len() > 64);
    assert_eq!(batch.iter().filter(|field| field.id == 173).count(), 10);
    assert_eq!(batch.iter().filter(|field| field.id == 196).count(), 10);
    assert!(!batch.iter().any(|field| field.ty == field_type::BYTES));
}
