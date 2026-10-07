import Foundation
import XCTest

@testable import BotaAppSDK

final class BotaSDKErrorTests: XCTestCase {
    func testReconnectFailureSurvivesNSErrorBridge() {
        let failure = BotaSDKError(
            code: .deviceNotFound, operation: .reconnect, retryable: true,
            detail: "device was not found during the scan"
        )
        let bridged = failure as NSError

        XCTAssertEqual(bridged.domain, "BotaAppSDK.BotaSDKError")
        XCTAssertEqual(bridged.code, 10)
        XCTAssertEqual(bridged.localizedDescription, failure.detail)
        XCTAssertEqual(bridged.userInfo["botaErrorCode"] as? String, "device_not_found")
        XCTAssertEqual(bridged.userInfo["botaOperation"] as? String, "reconnect")
        XCTAssertEqual(bridged.userInfo["retryable"] as? Bool, true)
        XCTAssertNil(bridged.userInfo["protocolStatus"])
    }

    func testAllCoreErrorCodesRetainTheirNumericIdentity() {
        for raw: UInt32 in 1...21 {
            let failure = BotaSDKError(
                code: BotaSDKError.code(raw), operation: .connect, retryable: false,
                detail: "connection failed"
            )
            XCTAssertEqual((failure as NSError).code, Int(raw))
        }
    }

    func testProtocolFailureRetainsStatusAndRetryPolicy() {
        let failure = BotaSDKError(
            code: .protocolRejected, operation: .provision, retryable: false,
            protocolStatus: 0x14, detail: "device rejected provisioning"
        )
        let bridged = failure as NSError

        XCTAssertEqual(bridged.userInfo["botaErrorCode"] as? String, "protocol_rejected")
        XCTAssertEqual(bridged.userInfo["botaOperation"] as? String, "provision")
        XCTAssertEqual(bridged.userInfo["retryable"] as? Bool, false)
        XCTAssertEqual(bridged.userInfo["protocolStatus"] as? UInt16, 0x14)
    }

    func testUnknownErrorAndEmptyDetailHaveUsableBridgeMetadata() {
        let failure = BotaSDKError(
            code: .unknown(4_000), operation: .unknown(90), retryable: false,
            detail: ""
        )
        let bridged = failure as NSError

        XCTAssertEqual(bridged.code, 4_000)
        XCTAssertEqual(bridged.userInfo["botaErrorCode"] as? String, "unknown")
        XCTAssertEqual(bridged.userInfo["botaOperation"] as? String, "unknown")
        XCTAssertEqual(bridged.localizedDescription, "unknown during unknown")
    }
}
