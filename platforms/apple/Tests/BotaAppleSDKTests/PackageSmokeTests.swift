import BotaDeviceSDKC
import XCTest

@testable import BotaAppleSDK

final class PackageSmokeTests: XCTestCase {
    func testPackageImportsFrozenAbi() {
        XCTAssertEqual(bota_device_sdk_v1_abi_version(), BOTA_DEVICE_SDK_ABI_VERSION)
        XCTAssertEqual(BotaAppleSDKVersion.current, "1.1.0")
    }
}
