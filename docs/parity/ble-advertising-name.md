# BLE Advertising Model Metadata and Serial Identity

October 20, 2026. New firmware publishes a versioned 14-byte Manufacturer Data
payload:

`company_le[2] | mac[6] | version=1 | model_code | serial_suffix[4]`

Model codes are 1 Pin, 2 Note, 3 Pin Pro and 0 unknown. `serial_suffix` is the
last four ASCII-alphanumeric characters of the manufacturing serial, preserving
case, or four zero bytes when absent/invalid. The full serial is never advertised.
Complete Local Name is model-only and is not an authoritative model field.

The SDK decodes the structured fields and formats labels such as
`Bota Note 67KP`. Unknown model codes, future versions and malformed suffixes do
not infer a model. Legacy eight-byte Manufacturer Data continues to provide only
the MAC and therefore retains the existing public compatibility fallback.

The generated-JS `react-native-ble-plx` port keeps OS duplicate delivery enabled
because Android may deliver ADV_DATA and SCAN_RSP separately. It merges fields by
peripheral ID without letting an empty callback erase structured metadata. The
adapter reads the decoded model directly from the BLE port; it does not parse the
Local Name to decide `deviceType`.

The public SDK currently groups legacy Pin Pro under the frozen `bota_pin` family
while retaining `Bota Pin Pro XXXX` as the display label. A future public API
revision may expose Pin Pro as a separate typed value.

After connection, `180A/2A24` remains the authoritative canonical model and
`180A/2A25` remains the full serial. Registration must use those connected values.
The suffix may collide and never authorizes binding, reconnection or capability.

## Verification

- Firmware extracted-C tests cover the exact payload bytes, all known and unknown
  model codes, valid/invalid suffixes, no full-SN exposure and the 31-byte limit.
- SDK tests cover Android split callbacks, structured Note classification,
  SDK-owned display formatting, legacy MAC parsing and rejection of future or
  malformed metadata.
- App tests cover connected-model mapping and replacement of enriched same-ID
  scan results.
- Target build, physical advertisement readback, package publication and App
  qualification remain separate acceptance gates.
