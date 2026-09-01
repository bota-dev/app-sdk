import BotaDeviceSDKC
import XCTest

@testable import BotaAppleSDK

final class FactoryResetManagerTests: XCTestCase {
    func testResetProviderIsBoundToCommandAndBindingGeneration() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = FactoryResetManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        let completion = try await manager.factoryReset(
            secureDevice(),
            commandID: "reset-command-1",
            grantID: "reset-grant-1",
            bindingGeneration: 9
        ) { request in
            XCTAssertEqual(request.commandID, "reset-command-1")
            XCTAssertEqual(request.bindingGeneration, 9)
            return Data([0x44])
        }

        XCTAssertEqual(completion, .init(commandID: "reset-command-1", bindingGeneration: 9))
        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_FACTORY_RESET))
        XCTAssertEqual(command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID)), "reset-command-1")
        XCTAssertEqual(command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID)), "reset-grant-1")

        let registeredProvider = await recorder.resetProvider
        let provider = try XCTUnwrap(registeredProvider)
        let request = FactoryResetMaterialRequest(serialNumber: "EVFXXW67KP", nonce: Data(repeating: 3, count: 16))
        _ = try await provider(request)
    }

    func testResumeUsesOnlyTheExactDurableResult() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        await recorder.setPendingReset(.init(
            commandID: "reset-command-1",
            resultCode: 0,
            deletedRecordingCount: 7,
            bindingGeneration: 9
        ))
        let manager = FactoryResetManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        let completion = try await manager.resumePendingFactoryReset(
            secureDevice(),
            currentBindingGeneration: 9
        )

        XCTAssertEqual(completion, .init(commandID: "reset-command-1", bindingGeneration: 9))
        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RESUME_FACTORY_RESET))
        XCTAssertEqual(command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID)), "reset-command-1")
        XCTAssertEqual(command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID)), nil)
    }

    func testResumeAfterReinstallWaitsForFirmwareReplayWithoutGrantOrResetOpcode() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = FactoryResetManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        let completion = try await manager.resumeUnjournaledFactoryReset(
            secureDevice(),
            commandID: "reset-after-reinstall",
            bindingGeneration: 0
        ) { _ in }

        XCTAssertEqual(
            completion,
            FactoryResetCompletion(commandID: "reset-after-reinstall", bindingGeneration: 0)
        )
        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RESUME_FACTORY_RESET))
        XCTAssertEqual(
            command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID)),
            "reset-after-reinstall"
        )
        XCTAssertNil(command.fields.secureUnsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE)))
        XCTAssertNil(command.fields.secureUnsigned(
            UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT)
        ))
        XCTAssertNil(command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID)))
    }

    func testStaleBindingGenerationCannotResumeOrDeleteANewerBinding() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        await recorder.setPendingReset(.init(
            commandID: "old-reset-command",
            resultCode: 0,
            deletedRecordingCount: 7,
            bindingGeneration: 8
        ))
        let manager = FactoryResetManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        do {
            _ = try await manager.resumePendingFactoryReset(
                secureDevice(),
                currentBindingGeneration: 9
            )
            XCTFail("a result from an older binding must not close the current binding")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch)
        }

        let commands = await runner.commands
        XCTAssertTrue(commands.isEmpty)
    }
}
