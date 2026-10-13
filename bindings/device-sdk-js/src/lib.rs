//! A u32-only raw-memory RPC surface over the canonical Rust SDK runtime.
//!
//! JavaScript owns no Rust pointers. It copies bytes into a registered buffer,
//! calls RPC with engine/buffer handles, copies the output, then frees both buffers.
//! No platform IO, wasm-bindgen, imported JS objects, or exported i64/u64 values.

mod byo;
mod codecs;
mod dto;
mod engine;
mod host_policy;
mod json;
mod native_v2;
mod planners;
mod recording_upload;
mod v2;

use engine::{Engine, error_bytes, invalid};
use std::{cell::RefCell, collections::BTreeMap};

pub const ABI_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_BUFFER_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BUFFERS: usize = 128;
pub const MAX_ENGINES: usize = 16;
pub const MAX_CALLBACKS: usize = 256;

/// Native-only differential test surface over the exact RPC implementation.
/// This is not exported from the wasm32 module or used by platform SDK facades.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
pub struct TraceEngine {
    engine: Engine,
}

#[cfg(not(target_arch = "wasm32"))]
impl TraceEngine {
    pub fn request(&mut self, input: &[u8]) -> Vec<u8> {
        self.engine.request(input)
    }
}

struct Registry {
    next_handle: Option<u32>,
    buffers: BTreeMap<u32, Box<[u8]>>,
    engines: BTreeMap<u32, Engine>,
    buffer_bytes: usize,
}

impl Registry {
    const fn new() -> Self {
        Self {
            next_handle: Some(1),
            buffers: BTreeMap::new(),
            engines: BTreeMap::new(),
            buffer_bytes: 0,
        }
    }

    fn handle(&mut self) -> Option<u32> {
        let handle = self.next_handle?;
        self.next_handle = handle.checked_add(1);
        Some(handle)
    }

    fn buffer_alloc(&mut self, length: usize) -> u32 {
        if length == 0
            || length > MAX_MESSAGE_BYTES
            || self.buffers.len() >= MAX_BUFFERS
            || length > MAX_BUFFER_BYTES.saturating_sub(self.buffer_bytes)
        {
            return 0;
        }
        let Some(handle) = self.handle() else {
            return 0;
        };
        self.buffers
            .insert(handle, vec![0; length].into_boxed_slice());
        self.buffer_bytes += length;
        handle
    }

    fn buffer_free(&mut self, handle: u32) -> u32 {
        let Some(mut buffer) = self.buffers.remove(&handle) else {
            return 1;
        };
        self.buffer_bytes -= buffer.len();
        // Best-effort scrubbing of transient transport material; JS must also scrub its copies.
        buffer.fill(0);
        0
    }

    fn engine_new(&mut self) -> u32 {
        if self.engines.len() >= MAX_ENGINES {
            return 0;
        }
        let Some(handle) = self.handle() else {
            return 0;
        };
        self.engines.insert(handle, Engine::default());
        handle
    }

    fn engine_free(&mut self, handle: u32) -> u32 {
        if self.engines.remove(&handle).is_some() {
            0
        } else {
            1
        }
    }

    fn rpc(&mut self, engine_handle: u32, input_handle: u32) -> u32 {
        if !self.buffers.contains_key(&input_handle) {
            return 0;
        }
        // Reserve the largest possible result before mutating the reducer. An
        // allocation failure must not hide the next protocol effects from the host.
        if self.buffers.len() >= MAX_BUFFERS
            || MAX_MESSAGE_BYTES > MAX_BUFFER_BYTES.saturating_sub(self.buffer_bytes)
        {
            return 0;
        }
        let input = self.buffers[&input_handle].to_vec();
        let Some(output_handle) = self.handle() else {
            return 0;
        };
        let result = match self.engines.get_mut(&engine_handle) {
            Some(engine) => engine.request(&input),
            None => error_bytes(&invalid("unknown engine handle")),
        };
        if result.len() > MAX_MESSAGE_BYTES {
            return 0;
        }
        self.buffer_bytes += result.len();
        self.buffers
            .insert(output_handle, result.into_boxed_slice());
        output_handle
    }
}

thread_local! {
    // The generated JS runtime is single threaded. Handles belong to this runtime
    // instance and are never valid in another instance or another native test thread.
    static REGISTRY: RefCell<Registry> = const { RefCell::new(Registry::new()) };
}

fn registry<R>(body: impl FnOnce(&mut Registry) -> R, unavailable: R) -> R {
    REGISTRY.with(|registry| {
        registry
            .try_borrow_mut()
            .map_or(unavailable, |mut registry| body(&mut registry))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_js_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_js_buffer_alloc(length: u32) -> u32 {
    registry(|state| state.buffer_alloc(length as usize), 0)
}

/// Returns a borrowed linear-memory address, valid until that buffer is freed.
/// Re-read the generated memory buffer after calls that may grow linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn bota_js_buffer_ptr(handle: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        registry(
            |state| {
                state
                    .buffers
                    .get(&handle)
                    .map_or(0, |buffer| buffer.as_ptr() as u32)
            },
            0,
        )
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = handle;
        0
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_js_buffer_len(handle: u32) -> u32 {
    registry(
        |state| {
            state
                .buffers
                .get(&handle)
                .map_or(0, |buffer| buffer.len() as u32)
        },
        0,
    )
}

/// Status 0 means freed; status 1 means absent or unavailable. Handles never reuse.
#[unsafe(no_mangle)]
pub extern "C" fn bota_js_buffer_free(handle: u32) -> u32 {
    registry(|state| state.buffer_free(handle), 1)
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_js_engine_new() -> u32 {
    registry(Registry::engine_new, 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_js_engine_free(handle: u32) -> u32 {
    registry(|state| state.engine_free(handle), 1)
}

/// Returns an owned output-buffer handle. Zero means the input handle is invalid,
/// the registry is reentered, or bounded allocation capacity is exhausted.
#[unsafe(no_mangle)]
pub extern "C" fn bota_js_rpc(engine_handle: u32, input_handle: u32) -> u32 {
    registry(|state| state.rpc(engine_handle, input_handle), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invoke(state: &mut Registry, engine: u32, bytes: &[u8]) -> (u32, serde_json::Value) {
        let input = state.buffer_alloc(bytes.len());
        state
            .buffers
            .get_mut(&input)
            .unwrap()
            .copy_from_slice(bytes);
        let output = state.rpc(engine, input);
        let value = serde_json::from_slice(state.buffers.get(&output).unwrap()).unwrap();
        assert_eq!(state.buffer_free(input), 0);
        (output, value)
    }

    #[test]
    fn registered_handles_bound_memory_and_reject_stale_frees() {
        let mut state = Registry::new();
        assert_eq!(state.buffer_alloc(0), 0);
        assert_eq!(state.buffer_alloc(MAX_MESSAGE_BYTES + 1), 0);
        let handle = state.buffer_alloc(1);
        assert_eq!(state.buffer_free(handle), 0);
        assert_eq!(state.buffer_free(handle), 1);
        let next = state.buffer_alloc(1);
        assert_ne!(next, handle);
        assert_eq!(state.buffer_free(next), 0);
        let handles = (0..MAX_BUFFER_BYTES / MAX_MESSAGE_BYTES)
            .map(|_| state.buffer_alloc(MAX_MESSAGE_BYTES))
            .collect::<Vec<_>>();
        assert!(handles.iter().all(|handle| *handle != 0));
        assert_eq!(state.buffer_alloc(1), 0);
        for handle in handles {
            assert_eq!(state.buffer_free(handle), 0);
        }
        assert_eq!(state.buffer_bytes, 0);
    }

    #[test]
    fn malformed_rpc_returns_owned_error_without_touching_an_engine() {
        let mut state = Registry::new();
        let engine = state.engine_new();
        let (output, value) = invoke(&mut state, engine, b"{\"version\":1,\"action\":\"start\"}");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "invalid_input");
        assert_eq!(state.buffer_free(output), 0);
        let (output, value) = invoke(&mut state, engine, b"{\"version\":1,\"action\":\"status\"}");
        assert_eq!(value["result"]["status"], "Idle");
        assert_eq!(state.buffer_free(output), 0);
        assert_eq!(state.engine_free(engine), 0);
        assert_eq!(state.engine_free(engine), 1);
        assert_eq!(state.buffer_bytes, 0);
    }

    #[test]
    fn registry_exhaustion_cannot_mutate_core_then_lose_effects() {
        let mut state = Registry::new();
        let engine = state.engine_new();
        let (input, _) = invoke(&mut state, engine, b"{\"version\":1,\"action\":\"status\"}");
        let mut handles = Vec::new();
        while state.buffers.len() < MAX_BUFFERS {
            let handle = state.buffer_alloc(1);
            assert_ne!(handle, 0);
            handles.push(handle);
        }
        assert_eq!(state.rpc(engine, input), 0);
        assert_eq!(state.buffer_free(input), 0);
        for handle in handles {
            state.buffer_free(handle);
        }
        let (output, value) = invoke(&mut state, engine, b"{\"version\":1,\"action\":\"status\"}");
        assert_eq!(value["result"]["status"], "Idle");
        state.buffer_free(output);
    }
}
