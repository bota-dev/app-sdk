import BotaDeviceSDKC
import XCTest

@testable import BotaAppSDK

final class PackageSmokeTests: XCTestCase {
    func testPackageImportsFrozenAbi() {
        XCTAssertEqual(bota_device_sdk_v1_abi_version(), BOTA_DEVICE_SDK_ABI_VERSION)
        XCTAssertEqual(BotaAppleSDKVersion.current, "2.0.0-beta.1")
    }
}
