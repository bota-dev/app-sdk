use bota_device_sdk_ffi::{
    BotaDeviceSdkErrorV1, BotaDeviceSdkErrorViewV1, BotaDeviceSdkStatusV1,
    bota_device_sdk_v1_abi_version, bota_device_sdk_v1_engine_cancel,
    bota_device_sdk_v1_engine_free, bota_device_sdk_v1_engine_last_error,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_error_free, bota_device_sdk_v1_error_view,
};
use std::ptr;

#[test]
fn crate_version_matches_the_synchronized_sdk_version() {
    let sdk_version = include_str!("../../../sdk-version.toml")
        .trim()
        .strip_prefix("version = \"")
        .and_then(|value| value.strip_suffix('"'))
        .expect("sdk-version.toml must contain one quoted version");

    assert_eq!(env!("CARGO_PKG_VERSION"), sdk_version);
}

#[test]
fn abi_version_and_engine_lifecycle_are_stable() {
    assert_eq!(bota_device_sdk_v1_abi_version(), 1);

    let engine = bota_device_sdk_v1_engine_new();
    assert!(!engine.is_null());
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn null_engine_reports_invalid_argument_without_panicking() {
    let status = unsafe { bota_device_sdk_v1_engine_cancel(ptr::null_mut(), 0, 1) };
    assert_eq!(status, BotaDeviceSdkStatusV1::InvalidArgument);
}

#[test]
fn failed_operation_exposes_one_owned_structured_error() {
    let engine = bota_device_sdk_v1_engine_new();
    assert!(!engine.is_null());

    let status = unsafe { bota_device_sdk_v1_engine_cancel(engine, 0, 1) };
    assert_eq!(status, BotaDeviceSdkStatusV1::OperationFailed);

    let mut error: *mut BotaDeviceSdkErrorV1 = ptr::null_mut();
    let status = unsafe { bota_device_sdk_v1_engine_last_error(engine, &mut error) };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert!(!error.is_null());

    let mut view = BotaDeviceSdkErrorViewV1::default();
    let status = unsafe { bota_device_sdk_v1_error_view(error, &mut view) };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert_ne!(view.code, 0);
    assert_ne!(view.operation, 0);
    assert!(!view.detail.data.is_null());
    assert!(view.detail.len > 0);

    unsafe {
        bota_device_sdk_v1_error_free(error);
        bota_device_sdk_v1_engine_free(engine);
    }
}

#[test]
fn engine_without_failure_has_no_error_owner() {
    let engine = bota_device_sdk_v1_engine_new();
    let mut error: *mut BotaDeviceSdkErrorV1 = ptr::null_mut();

    let status = unsafe { bota_device_sdk_v1_engine_last_error(engine, &mut error) };

    assert_eq!(status, BotaDeviceSdkStatusV1::NoOutput);
    assert!(error.is_null());
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}
