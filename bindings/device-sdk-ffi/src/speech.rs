//! Native projection of the shared speech policy, independent of the BLE engine.
use crate::{BotaDeviceSdkErrorV1, BotaDeviceSdkSliceV1, BotaDeviceSdkStatusV1};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    speech::SpeechClient,
};
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Mutex,
};
use zeroize::Zeroize;

// Foreign input is bounded before reading it. The core applies its stricter
// per-command limits (only caption pages may exceed 32 KiB).
const MAX_CONFIGURATION: u64 = 32 * 1024;
const MAX_COMMAND: u64 = 896 * 1024;

#[repr(C)]
pub struct BotaDeviceSdkSpeechV1 {
    client: Mutex<Option<SpeechClient>>,
}

#[repr(C)]
pub struct BotaDeviceSdkSpeechOutputV1 {
    json: Vec<u8>,
}

impl Drop for BotaDeviceSdkSpeechOutputV1 {
    fn drop(&mut self) {
        self.json.zeroize();
    }
}

fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
}

#[unsafe(no_mangle)]
/// # Safety
/// Input must be readable for this call. Output slots must be writable, distinct
/// and empty. Only bounded capture metadata is accepted; free the output once.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_capture(
    command: BotaDeviceSdkSliceV1,
    out_json: *mut *mut BotaDeviceSdkSpeechOutputV1,
    out_error: *mut *mut BotaDeviceSdkErrorV1,
) -> BotaDeviceSdkStatusV1 {
    // The same bounded UTF-8 and panic-contained output boundary as speech IO.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        result(out_json, out_error, || {
            let json = bota_device_sdk_core::speech::capture::dispatch_json(text(command, 65536)?)?;
            Ok(BotaDeviceSdkSpeechOutputV1 {
                json: json.into_bytes(),
            })
        })
    }
}

// Caller guarantees that a bounded, non-empty slice is readable for this call.
unsafe fn text<'a>(input: BotaDeviceSdkSliceV1, limit: u64) -> Result<&'a str, DeviceSdkError> {
    if input.len > limit {
        return Err(DeviceSdkError::new(
            ErrorCode::PayloadTooLarge,
            Operation::Decode,
            false,
        ));
    }
    if input.len == 0 {
        return Ok("");
    }
    if input.data.is_null() {
        return Err(invalid());
    }
    // The fixed limit fits usize/isize on all supported platforms; null was rejected.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(input.data, input.len as usize) })
        .map_err(|_| invalid())
}

// Both output slots must be writable, distinct and contain no outstanding owner.
unsafe fn result<T>(
    output: *mut *mut T,
    error: *mut *mut BotaDeviceSdkErrorV1,
    operation: impl FnOnce() -> Result<T, DeviceSdkError>,
) -> BotaDeviceSdkStatusV1 {
    // Clear valid slots even when another required slot is missing.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        if !output.is_null() {
            *output = ptr::null_mut();
        }
        if !error.is_null() {
            *error = ptr::null_mut();
        }
    }
    if output.is_null() || error.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(value)) => {
            // The validated slot receives exactly one SDK allocation.
            // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
            unsafe { *output = Box::into_raw(Box::new(value)) };
            BotaDeviceSdkStatusV1::Ok
        }
        Ok(Err(value)) => {
            // Errors contain only stable core codes; never input JSON or credentials.
            // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
            unsafe { *error = Box::into_raw(Box::new(value.into())) };
            BotaDeviceSdkStatusV1::OperationFailed
        }
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// Non-empty input slices must be readable for this call. Output slots must be
/// writable, distinct and contain no outstanding SDK owner. Free returned owners once.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_new(
    configuration: BotaDeviceSdkSliceV1,
    grant: BotaDeviceSdkSliceV1,
    now_ms: u64,
    out_speech: *mut *mut BotaDeviceSdkSpeechV1,
    out_error: *mut *mut BotaDeviceSdkErrorV1,
) -> BotaDeviceSdkStatusV1 {
    // The documented slices and output slots are checked by the shared boundary helpers.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        result(out_speech, out_error, || {
            Ok(BotaDeviceSdkSpeechV1 {
                client: Mutex::new(Some(SpeechClient::from_json(
                    text(configuration, MAX_CONFIGURATION)?,
                    text(grant, MAX_CONFIGURATION)?,
                    now_ms,
                )?)),
            })
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `speech` must be null or live. Input must be readable for this call; output
/// slots must be writable, distinct and contain no outstanding SDK owner. Do not
/// free `speech` concurrently. Any failure requires host media teardown.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_step(
    speech: *mut BotaDeviceSdkSpeechV1,
    command: BotaDeviceSdkSliceV1,
    now_ms: u64,
    out_json: *mut *mut BotaDeviceSdkSpeechOutputV1,
    out_error: *mut *mut BotaDeviceSdkErrorV1,
) -> BotaDeviceSdkStatusV1 {
    // The documented live handle and slices enter a serialized, panic-contained boundary.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        result(out_json, out_error, || {
            let speech = speech.as_ref().ok_or_else(invalid)?;
            let mut owner = speech
                .client
                .lock()
                .map_err(|_| DeviceSdkError::new(ErrorCode::Internal, Operation::Unknown, false))?;
            let response = (|| {
                let json = text(command, MAX_COMMAND)?;
                owner
                    .as_mut()
                    .ok_or_else(|| {
                        DeviceSdkError::new(ErrorCode::NotConnected, Operation::Connect, false)
                    })?
                    .dispatch_json(json, now_ms)
            })();
            match response {
                Ok(json) => Ok(BotaDeviceSdkSpeechOutputV1 {
                    json: json.into_bytes(),
                }),
                Err(error) => {
                    // Invalid foreign UTF-8/length must not bypass the core's terminal
                    // handling of malformed commands. Native hosts close on any error.
                    *owner = None;
                    Err(error)
                }
            }
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `speech` must be null or a live SDK owner, with no concurrent calls. Free once.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_free(speech: *mut BotaDeviceSdkSpeechV1) {
    if !speech.is_null() {
        // The documented owner is reclaimed exactly once after native calls are retired.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        drop(unsafe { Box::from_raw(speech) });
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `output` must be null or live; `out_view` must be null or writable. The UTF-8
/// slice is borrowed until output_free, and is not NUL terminated.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_output_view(
    output: *const BotaDeviceSdkSpeechOutputV1,
    out_view: *mut BotaDeviceSdkSliceV1,
) -> BotaDeviceSdkStatusV1 {
    if out_view.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    // The documented writable slot is cleared before checking its borrowed owner.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe { *out_view = BotaDeviceSdkSliceV1::default() };
    if output.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    // Caller keeps the immutable owner live until the view has been copied.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        let output = &*output;
        *out_view = BotaDeviceSdkSliceV1 {
            data: output.json.as_ptr(),
            len: output.json.len() as u64,
        };
    }
    BotaDeviceSdkStatusV1::Ok
}

#[unsafe(no_mangle)]
/// # Safety
/// `output` must be null or a live SDK owner. Free once after copying its views.
pub unsafe extern "C" fn bota_device_sdk_v1_speech_output_free(
    output: *mut BotaDeviceSdkSpeechOutputV1,
) {
    if !output.is_null() {
        // The documented output allocation is reclaimed and its caption bytes erased.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        drop(unsafe { Box::from_raw(output) });
    }
}
