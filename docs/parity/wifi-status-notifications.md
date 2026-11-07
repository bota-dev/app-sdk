# WiFi status notification dispatch

## Failure and correction

The generated React Native host called `decodeWiFiStatusEvent`, whose decoder
existed but was missing from the public Rust codec dispatcher. The first WiFi
notification therefore failed with `unsupported_operation` / `unknown bridge
codec`. Observer cleanup removed the status subscription. The independent
29-byte authenticated configuration receipt could still resolve successfully,
leaving an application waiting for `connected` and the target SSID.

Register the existing decoder and regenerate the canonical JavaScript runtime.
No firmware frame, GATT UUID, backend grant, token protocol, or public SDK API
changes. Both receipt and ordinary status notifications continue sharing the
existing WiFi status characteristic. Receipt authentication remains separate
from actual network connection evidence.

## Regression and review requirements

| Requirement | Executable evidence | Boundary |
| --- | --- | --- |
| Notification decoder is reachable through public dispatch | Rust `wifi_status_event_dispatch_preserves_connection_state_and_filters_receipts`; generated-core codec regression | A direct decoder test alone is insufficient |
| Receipt cannot close the persistent status observer | `wifiStatusIntegration.test.mjs`, v2/v3 with status before and after receipt | Actual generated core and host; simulated BLE I/O |
| The application receives the connection event | Android/iOS public `DeviceManager` callback and cache checks | Actual public runtime; no codec or manager mocks |
| Receipt success cannot manufacture connection success | Receipt-only, failed status, and missing SSID scenarios | App still needs matching connected status |
| Authentication and lifecycle remain enforced | Tampered receipt and late notification after retirement | No plaintext fallback or retry of a grant |
| Native Rust and shipped generated JavaScript agree | `react-native:verify-js-core` includes status, receipt and malformed-frame dispatch | Regenerate on the canonical Linux toolchain |

The tests are included in the existing React Native `npm test` / `npm run verify`
CI path; no additional optional gate is required. Unlike older host tests, these
tests do not stub the codec. Run them again against the exact packed SDK used by
the consuming application so an old embedded runtime cannot pass source-only
verification.

The release order is SDK qualification/publication, then consuming App adoption.
A local APK may embed the explicitly selected unpublished candidate for firmware
testing. No backend deployment or firmware protocol migration is required.
Phone BLE delivery, router association/DHCP, and installed App UI acceptance
remain physical checks; simulations do not prove those outcomes.

## Local verification and design review

The previous generated runtime failed eight of the first nine focused scenarios
and both added public DeviceManager scenarios. After canonical Linux regeneration,
all 11 pass. The complete React Native verification passes 706 tests, package and
Codegen checks, types, build and licenses. The Rust bridge passes all 76 tests and
Clippy; native Rust and generated JavaScript agree on 179 differential RPCs.

Review found the implementation conforms to the requirements above: the only
production Rust change is dispatching to the existing event decoder; framing,
authentication, cancellation and subscription teardown are unchanged. The new
generated artifact belongs to those exact Rust inputs. Hosted CI, published SDK
adoption and physical phone/router acceptance remain separate delivery gates.
