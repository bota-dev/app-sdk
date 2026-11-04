# Saving edited recordings

`createRecordingEditClient` is an unreleased React Native helper exported from
the package root and `@bota.dev/react-native-app-sdk/runtime`. It does not require
or reserve the BLE workflow engine. It does not edit, decode, split or merge audio.

The App owns its editor, actual clip files, authenticated backend facade and
durable journal. The helper validates the intent, persists it before admission,
uploads unchanged files, finalizes saving and recovers status. Server-side merge
accepts ordered cloud recording IDs or uploaded input files. Server-side saving
accepts already exported split clips or an already merged file.

```typescript
import {
  createRecordingEditClient,
  type RecordingEditHost,
  type RecordingEditRequest,
} from '@bota.dev/react-native-app-sdk/runtime';

// Implement this host using your App's scoped backend, private files and journal.
declare const host: RecordingEditHost<string>;
declare const request: RecordingEditRequest;
declare const finishedFiles: Record<string, string>;

const edits = createRecordingEditClient(host);
const accepted = await edits.saveEdit(request, finishedFiles);
const current = await edits.get(accepted.operation_id);
// After restarting, supply a new host for the same authenticated scope.
await edits.resume(accepted.operation_id);
```

| Host member | Required behavior |
| --- | --- |
| `scopeKey`, `signal`, `checkScope` | Bind account, project/workspace and environment. Invalidate permanently when any changes. |
| `load`, `save` | Persist the exact request and opaque file handles, with `version: 1` and `scope_key`; keep the same operation UUID across restarts. |
| `request` | Call your authenticated edit facade with the supplied method, relative path, JSON body and cancellation signal. Never embed a Bota project secret in the App. |
| `inspect` | Read the actual local file and return SHA-256 and byte size, preferably through bounded native/file streaming. |
| `upload` | PUT the unchanged file to the returned HTTPS URL using all supplied checksum/content headers. Do not forward application authorization to object storage. Honor cancellation. |

`saveEdit(request, files)` takes a client-generated UUID, `kind: merge | split`,
`mode: concatenate_sources | save_outputs`, and `manifest` containing sources,
outputs and `processing: transcribe_then_summarize`. Persist the UUID before the
first possible mutation. Source order is playback order. No wall-clock alignment
is performed.

For `concatenate_sources`, supply 2–20 distinct sources and one named output.
Cloud sources contain `kind: cloud_recording`, `recording_id` and original
`sha256`, with a normalized sample clock when available. A local source contains
`kind: local_artifact`, `artifact_id`, `sha256`, `samples`, `channels` and `file`.
The file identity is `{ sha256, size_bytes, content_type }`; handles use keys
`input_0`, `input_1`, etc. Only local sources need handles.

For split `save_outputs`, supply one source and 2–20 named finished WAV outputs.
Each output has a file identity and one exact interval
`{ source_index: 0, start_sample, end_sample }`. Sample coordinates are decimal
strings. Adjacent intervals partition the whole source. Handles use `output_0`,
`output_1`, etc. Finished merge saving instead supplies one output with one
full-source interval for each of its 2–20 sources. Local-only source descriptors
carry declared highlights and do not force upload of the original.

The initial backend profile uses 48 kHz PCM16 WAV with mono/stereo channels.
Combined duration is bounded to 20 minutes, inputs to 256 MiB each and 512 MiB
combined. The One and Portal split editors further limit previews to five minutes
and 64 MiB. Query the backend's capabilities before preparing files. For cloud
splitting, use the canonical editing preview supplied by the source descriptor;
its separate checksum does not replace the original source hash.

`saveEdit` returning `queued` or `processing` means accepted, not published.
`saved` means all new audio files are visible; inspect each output's transcription
and summary status separately. `retry(id)` preserves result identities and
published audio. When an audio retry returns `waiting_for_inputs`, call
`resume(id)` to reupload the exact files. `cancel(id)` fences further work; saved
audio is retained. It cannot recall already issued URLs or provider requests.

An output's `processing_error: processing_dispatch_deferred` indicates temporary
AI admission or dispatch failure. Display it separately from audio save failure;
the backend reconciles the same stage IDs and clears it after successful dispatch.

The helper checks every local file before first admission. On recovery it first
replays the journaled intent, allowing an already saved operation to recover even
after local files disappear. It serializes concurrent saves of the same UUID
within one client. The backend is authoritative across multiple clients.
Changed bytes or intent require a new operation, never silent re-rendering under
the old identity. Delete host files only after authoritative save/cancellation.

Package publication, adoption by consumer Apps and physical editing/playback
qualification remain separate from source/package tests. Older published SDK
versions do not expose this helper; consumers must check availability and adopt
the matching qualified artifact before enabling their editor entry point.
