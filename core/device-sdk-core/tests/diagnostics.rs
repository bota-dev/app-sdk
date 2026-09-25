use bota_device_sdk_core::protocol::{
    DeviceDiagnosticsDecoder, DiagnosticCommand, encode_diagnostic_command,
};

fn meta(index: u8) -> Vec<u8> {
    let mut bytes = vec![0x90, index, 3];
    bytes.extend(5_u16.to_le_bytes());
    bytes.extend(982341_u32.to_le_bytes());
    bytes.extend((42 + u64::from(index)).to_le_bytes());
    bytes
}

fn signature(index: u8) -> Vec<u8> {
    let mut bytes = vec![0x91, index];
    bytes.extend(0x0123456789abcdef_u64.to_le_bytes());
    bytes
}

fn detail() -> [u8; 176] {
    let mut bytes = [0; 176];
    bytes[..2].copy_from_slice(&[1, 1]);
    bytes[2..14].copy_from_slice(b"a4f02973d61c");
    bytes[15..20].copy_from_slice(&[2, 0, 3, 1, 1]);
    for (offset, value) in [
        (20, 8_u32),
        (40, 0x14bd0),
        (44, 0x82a4),
        (48, 0x4118),
        (52, 0x82a4),
        (56, 0x14bd0),
        (72, 18320),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[80..87].copy_from_slice(b"btstack");
    bytes[96..100].copy_from_slice(&(-210_i32).to_le_bytes());
    bytes[100..102].copy_from_slice(&3_u16.to_le_bytes());
    bytes[102..106].copy_from_slice(&2_i32.to_le_bytes());
    bytes
}

fn chunk(index: u8, offset: usize, bytes: &[u8]) -> Vec<u8> {
    let mut packet = vec![0x95, index];
    packet.extend((offset as u16).to_le_bytes());
    packet.extend(176_u16.to_le_bytes());
    packet.extend(bytes);
    packet
}

fn feed_detail(decoder: &mut DeviceDiagnosticsDecoder, index: u8, bytes: &[u8; 176]) {
    for (part, bytes) in bytes.chunks(14).enumerate() {
        assert_eq!(decoder.push(&chunk(index, part * 14, bytes)).unwrap(), None);
    }
}

fn feed_event(decoder: &mut DeviceDiagnosticsDecoder, index: u8, bytes: &[u8; 176]) {
    assert_eq!(decoder.push(&meta(index)).unwrap(), None);
    assert_eq!(decoder.push(&signature(index)).unwrap(), None);
    feed_detail(decoder, index, bytes);
}

#[test]
fn reference_318974f_full_report_matches_every_field() {
    let mut decoder = DeviceDiagnosticsDecoder::default();
    feed_event(&mut decoder, 0, &detail());
    let batch = decoder.push(&[0x92, 1]).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(batch).unwrap(),
        serde_json::json!({
            "schema_version": 1,
            "events": [{
                "event_id": "000000000000002a", "event_type": "hard_fault",
                "reason_code": "cpu_usage_fault", "uptime_ms": 982341,
                "signature": "0123456789abcdef", "firmware_build_id": "a4f02973d61c",
                "subsystem": "system", "state_before_event": "recording",
                "report": {
                    "fault": {"cpu_id": 0, "cpu_emu": "00000008", "core_emu": "00000000",
                        "hsb_emu": "00000000", "audio_emu": "00000000", "wireless_emu": "00000000"},
                    "execution": {"task": "btstack", "reti": "rom:00014bd0", "rets": "rom:000082a4",
                        "pc_trace": ["rom:00004118", "rom:000082a4", "rom:00014bd0"]},
                    "runtime": {"heap_free_bytes": 18320},
                    "breadcrumbs": [{"delta_ms": -210, "code": "recording_started", "arg0": 2}]
                }
            }]
        })
    );
    assert!(decoder.push(&[0x92, 0]).unwrap().unwrap().events.is_empty());
}

#[test]
fn commands_require_canonical_ids_and_preserve_all_u64_bits() {
    assert_eq!(
        encode_diagnostic_command(DiagnosticCommand::List).unwrap(),
        [0x10]
    );
    for (id, expected) in [
        ("0123456789abcdef", 0x0123456789abcdef_u64),
        ("ffffffffffffffff", u64::MAX),
        ("0000000000000000", 0),
    ] {
        let mut bytes = vec![0x11];
        bytes.extend(expected.to_le_bytes());
        assert_eq!(
            encode_diagnostic_command(DiagnosticCommand::Acknowledge(id)).unwrap(),
            bytes
        );
    }
    for id in [
        "",
        "ABC",
        "0123456789ABCDEF",
        "000000000000000",
        "00000000000000000",
        "000000000000000g",
        " 000000000000000",
        "00000000000000\n0",
        "００００００００",
    ] {
        assert!(
            encode_diagnostic_command(DiagnosticCommand::Acknowledge(id)).is_err(),
            "{id:?}"
        );
    }
}

#[test]
fn optional_fields_fallbacks_address_regions_and_maximum_arrays() {
    let mut decoder = DeviceDiagnosticsDecoder::default();
    let mut bytes = detail();
    bytes[14..20].copy_from_slice(&[255, 255, 7, 255, 255, 3]);
    bytes[40..44].copy_from_slice(&0x80001234_u32.to_le_bytes());
    bytes[44..48].copy_from_slice(&0x40005678_u32.to_le_bytes());
    bytes[48..52].fill(0);
    bytes[76..80].copy_from_slice(&u32::MAX.to_le_bytes());
    bytes[80..96].fill(0);
    bytes[100..102].copy_from_slice(&u16::MAX.to_le_bytes());
    bytes[102..106].copy_from_slice(&i32::MIN.to_le_bytes());
    bytes[166..170].copy_from_slice(&i32::MAX.to_le_bytes());
    bytes[170..172].copy_from_slice(&7_u16.to_le_bytes());
    bytes[172..176].copy_from_slice(&(-1_i32).to_le_bytes());
    feed_event(&mut decoder, 0, &bytes);
    let batch = decoder.push(&[0x92, 1]).unwrap().unwrap();
    let event = &batch.events[0];
    assert_eq!(event.subsystem, "system");
    assert_eq!(event.state_before_event, "unknown");
    let report = event.report.as_ref().unwrap();
    assert_eq!(report.execution.task, None);
    assert_eq!(report.execution.reti.as_deref(), Some("sdram:00001234"));
    assert_eq!(report.execution.rets.as_deref(), Some("ram:00005678"));
    assert_eq!(report.execution.pc_trace, ["rom:000082a4", "rom:00014bd0"]);
    assert_eq!(
        report.runtime.as_ref().unwrap().task_stack_remaining_bytes,
        Some(u32::MAX)
    );
    assert_eq!(report.breadcrumbs.len(), 8);
    assert_eq!(report.breadcrumbs[0].code, "state_changed");
    assert_eq!(report.breadcrumbs[0].arg0, i32::MIN);
    assert_eq!(report.breadcrumbs[7].delta_ms, i32::MAX);
    assert_eq!(report.breadcrumbs[7].code, "full_sleep");
    assert_eq!(report.breadcrumbs[7].arg0, -1);

    bytes[1] = 0;
    feed_event(&mut decoder, 0, &bytes);
    assert!(
        decoder.push(&[0x92, 1]).unwrap().unwrap().events[0]
            .report
            .is_none()
    );
    bytes[1] = 1;
    bytes[17..20].fill(0);
    bytes[40..48].fill(0);
    feed_event(&mut decoder, 0, &bytes);
    let event = &decoder.push(&[0x92, 1]).unwrap().unwrap().events[0];
    let report = event.report.as_ref().unwrap();
    assert!(report.runtime.is_none());
    assert!(report.execution.reti.is_none());
    assert!(report.execution.rets.is_none());
    assert!(report.execution.pc_trace.is_empty());
    assert!(report.breadcrumbs.is_empty());
}

#[test]
fn malformed_fragments_and_metadata_clear_all_pending_state() {
    for bad in [
        chunk(0, 0, &[0; 14]),
        chunk(0, 28, &[0; 14]),
        chunk(0, 175, &[0; 2]),
        vec![0x95, 0, 14, 0, 175, 0, 1],
        vec![0x95, 0, 14, 0, 176, 0],
        vec![0x95; 21],
        vec![0x90],
        vec![0x91],
        vec![0x92],
        meta(0),
    ] {
        let mut decoder = DeviceDiagnosticsDecoder::default();
        decoder.push(&meta(0)).unwrap();
        decoder.push(&chunk(0, 0, &detail()[..14])).unwrap();
        assert!(decoder.push(&bad).is_err(), "{bad:?}");
        assert!(decoder.push(&[0x92, 1]).is_err());
        feed_event(&mut decoder, 0, &detail());
        assert_eq!(decoder.push(&[0x92, 1]).unwrap().unwrap().events.len(), 1);
    }
}

#[test]
fn invalid_detail_version_build_id_and_missing_metadata_reset_decoder() {
    for (offset, value) in [(0, 2), (2, b'Z'), (2, 0xff)] {
        let mut decoder = DeviceDiagnosticsDecoder::default();
        decoder.push(&meta(0)).unwrap();
        let mut bytes = detail();
        bytes[offset] = value;
        let result = bytes
            .chunks(14)
            .enumerate()
            .try_for_each(|(part, data)| decoder.push(&chunk(0, part * 14, data)).map(|_| ()));
        assert!(result.is_err());
        assert!(decoder.push(&[0x92, 1]).is_err());
    }
    let mut decoder = DeviceDiagnosticsDecoder::default();
    for (part, bytes) in detail().chunks(14).enumerate() {
        let result = decoder.push(&chunk(0, part * 14, bytes));
        assert_eq!(result.is_err(), part == 12);
    }
    assert!(decoder.push(&[0x92, 0]).unwrap().unwrap().events.is_empty());
}

#[test]
fn reset_and_end_require_complete_contiguous_events_and_consume_state() {
    let mut decoder = DeviceDiagnosticsDecoder::default();
    feed_event(&mut decoder, 0, &detail());
    decoder.reset();
    assert!(decoder.push(&[0x92, 1]).is_err());
    feed_event(&mut decoder, 0, &detail());
    assert_eq!(decoder.push(&[]).unwrap(), None);
    assert!(decoder.push(&[0x92, 1]).is_err());
    feed_event(&mut decoder, 1, &detail());
    assert!(decoder.push(&[0x92, 1]).is_err());
    feed_event(&mut decoder, 0, &detail());
    assert!(decoder.push(&[0x92, 0]).is_err());
    decoder.push(&meta(0)).unwrap();
    feed_detail(&mut decoder, 0, &detail());
    assert!(decoder.push(&[0x92, 1]).is_err());
    feed_event(&mut decoder, 1, &detail());
    feed_event(&mut decoder, 0, &detail());
    let batch = decoder.push(&[0x92, 2]).unwrap().unwrap();
    assert_eq!(batch.events[0].event_id, "000000000000002a");
    assert_eq!(batch.events[1].event_id, "000000000000002b");
    assert!(decoder.push(&[0x92, 2]).is_err());
}

#[test]
fn assembly_is_bounded_by_u8_indices_and_fixed_detail_size() {
    let mut decoder = DeviceDiagnosticsDecoder::default();
    for index in 0..=255 {
        feed_event(&mut decoder, index, &detail());
    }
    // END has a u8 count, so 256 assembled events cannot form a complete batch.
    assert!(decoder.push(&[0x92, 255]).is_err());
    for index in 0..255 {
        feed_event(&mut decoder, index, &detail());
    }
    assert_eq!(
        decoder.push(&[0x92, 255]).unwrap().unwrap().events.len(),
        255
    );
}

#[test]
fn unknown_transport_messages_are_ignored_without_leaking_partial_events() {
    let mut decoder = DeviceDiagnosticsDecoder::default();
    assert_eq!(decoder.push(&[0x93, 0]).unwrap(), None);
    assert_eq!(decoder.push(&[0x94, 0]).unwrap(), None);
    assert_eq!(decoder.push(&signature(0)).unwrap(), None);
    assert_eq!(decoder.push(&[0, 0, 0, b'a']).unwrap(), None);
    assert!(decoder.push(&[0x92, 0]).unwrap().unwrap().events.is_empty());
}
