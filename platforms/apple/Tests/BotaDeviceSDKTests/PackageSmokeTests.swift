import BotaDeviceSDKC
import XCTest

@testable import BotaDeviceSDK

final class PackageSmokeTests: XCTestCase {
    func testPackageImportsFrozenAbi() {
        XCTAssertEqual(bota_device_sdk_v1_abi_version(), BOTA_DEVICE_SDK_ABI_VERSION)
        XCTAssertEqual(BotaDeviceSDKVersion.current, "1.0.0")
    }
}
