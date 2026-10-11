use bota_device_sdk_core::protocol::{ByoBleFrame, ByoBleKind, decode_byo_ble, encode_byo_ble};

#[test]
fn bounded_independent_frames_round_trip_without_using_v2_document_layouts() {
    let frame = ByoBleFrame {
        kind: ByoBleKind::Request,
        operation: 3,
        status: 0,
        request_id: 7,
        offset: 0,
        total: 3,
        payload: vec![1, 2, 3],
    };
    let bytes = encode_byo_ble(&frame, 20).unwrap();
    assert_eq!(bytes, [112, 3, 3, 0, 7, 0, 0, 0, 0, 0, 3, 0, 1, 2, 3]);
    assert_eq!(decode_byo_ble(&bytes).unwrap(), frame);
    assert!(encode_byo_ble(&frame, 14).is_err());
    for length in 0..12 {
        assert!(decode_byo_ble(&bytes[..length]).is_err());
    }
    let mut legacy = bytes.clone();
    legacy[1] = 2;
    assert!(decode_byo_ble(&legacy).is_err());
}

#[test]
fn rejects_overflow_replayed_zero_ids_and_noncanonical_control_fields() {
    let frame = ByoBleFrame {
        kind: ByoBleKind::Request,
        operation: 4,
        status: 0,
        request_id: 1,
        offset: 8191,
        total: 8192,
        payload: vec![1],
    };
    assert!(encode_byo_ble(&frame, 20).is_ok());
    for bad in [
        ByoBleFrame {
            payload: vec![1, 2],
            ..frame.clone()
        },
        ByoBleFrame {
            total: 8193,
            ..frame.clone()
        },
        ByoBleFrame {
            request_id: 0,
            ..frame.clone()
        },
        ByoBleFrame {
            status: 1,
            ..frame.clone()
        },
        ByoBleFrame {
            operation: 0,
            ..frame.clone()
        },
        ByoBleFrame {
            kind: ByoBleKind::Pull,
            ..frame.clone()
        },
    ] {
        assert!(encode_byo_ble(&bad, 512).is_err());
    }
    let pull = ByoBleFrame {
        kind: ByoBleKind::Pull,
        total: 0,
        payload: vec![],
        ..frame
    };
    assert!(encode_byo_ble(&pull, 20).is_ok());
}

#[test]
fn live_operations_are_additive_and_never_accept_v2_framing() {
    for operation in 9..=13 {
        let frame = ByoBleFrame {
            kind: ByoBleKind::Request,
            operation,
            status: 0,
            request_id: 11,
            offset: 0,
            total: 0,
            payload: vec![],
        };
        let mut bytes = encode_byo_ble(&frame, 244).unwrap();
        assert_eq!(decode_byo_ble(&bytes).unwrap(), frame);
        bytes[1] = 2;
        assert!(decode_byo_ble(&bytes).is_err());
    }
}
