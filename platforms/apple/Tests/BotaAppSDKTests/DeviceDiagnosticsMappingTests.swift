import Foundation
import XCTest

@testable import BotaAppSDK

final class DeviceDiagnosticsMappingTests: XCTestCase {
    func testTypedFieldsPreserveFullReportAndSparseEventBoundaries() throws {
        let fields: [CoreField] = [
            .unsigned(id: 171, value: 1), .unsigned(id: 172, value: 2),
        ] + event("ffffffffffffffff", report: true) + [
            .unsigned(id: 182, value: 1),
            .text(id: 183, value: "ffffffff"), .text(id: 184, value: "00000002"),
            .text(id: 185, value: "00000003"), .text(id: 186, value: "00000004"),
            .text(id: 187, value: "00000005"), .text(id: 188, value: "audio"),
            .text(id: 189, value: "rom:00001234"), .text(id: 190, value: "ram:00005678"),
            .unsigned(id: 191, value: 2), .text(id: 192, value: "rom:00000001"),
            .text(id: 192, value: "sdram:00000002"), .unsigned(id: 193, value: UInt64(UInt32.max)),
            .unsigned(id: 194, value: 0), .unsigned(id: 195, value: 2),
            .signed(id: 196, value: Int64(Int32.min)), .text(id: 197, value: "boot"),
            .signed(id: 198, value: Int64(Int32.max)),
            .signed(id: 196, value: -1), .text(id: 197, value: "state_changed"),
            .signed(id: 198, value: -2),
        ] + event("8000000000000001", report: false)
        let batch = try XCTUnwrap(CoreModelMapper.diagnosticBatch(from: fields))
        XCTAssertEqual(batch.schemaVersion, 1)
        XCTAssertEqual(batch.events.map(\.eventId), ["ffffffffffffffff", "8000000000000001"])
        XCTAssertEqual(batch.events[0].signature, "fedcba9876543210")
        XCTAssertEqual(batch.events[0].uptimeMs, UInt32.max)
        XCTAssertEqual(batch.events[0].report, DeviceDiagnosticReport(
            fault: .init(cpuId: 1, cpuEmu: "ffffffff", coreEmu: "00000002", hsbEmu: "00000003",
                         audioEmu: "00000004", wirelessEmu: "00000005"),
            execution: .init(task: "audio", reti: "rom:00001234", rets: "ram:00005678",
                             pcTrace: ["rom:00000001", "sdram:00000002"]),
            runtime: .init(heapFreeBytes: .max, taskStackRemainingBytes: 0),
            breadcrumbs: [.init(deltaMs: .min, code: "boot", arg0: .max),
                          .init(deltaMs: -1, code: "state_changed", arg0: -2)]
        ))
        XCTAssertNil(batch.events[1].report)
        XCTAssertNil(try CoreModelMapper.diagnosticBatch(from: []))
    }

    func testRustCommandEncodingKeepsExactIdsAndRejectsInvalidIds() throws {
        let mapper = try CoreModelMapper()
        XCTAssertEqual(try mapper.createDiagnosticCommand(nil), Data([0x10]))
        XCTAssertEqual(try mapper.createDiagnosticCommand("8000000000000001"), Data([0x11, 1, 0, 0, 0, 0, 0, 0, 0x80]))
        XCTAssertEqual(try mapper.createDiagnosticCommand("ffffffffffffffff"), Data([0x11] + Array(repeating: 0xff, count: 8)))
        for invalid in ["", "FFFFFFFFFFFFFFFF", "000000000000000g", "00000000000000000"] {
            XCTAssertThrowsError(try mapper.createDiagnosticCommand(invalid))
        }
    }

    func testRustDecoderResetAndEmptyBatch() throws {
        let mapper = try CoreModelMapper()
        XCTAssertNil(try mapper.decodeDiagnosticEvents(Data()))
        XCTAssertEqual(try mapper.decodeDiagnosticEvents(Data([0x92, 0])), .init(schemaVersion: 1, events: []))
        XCTAssertNil(try mapper.decodeDiagnosticEvents(Data()))
    }

    private func event(_ id: String, report: Bool) -> [CoreField] {
        [
            .text(id: 173, value: id), .text(id: 174, value: "hard_fault"),
            .text(id: 175, value: "cpu_stack_overflow"), .unsigned(id: 176, value: UInt64(UInt32.max)),
            .text(id: 177, value: "fedcba9876543210"), .text(id: 178, value: "012345abcdef"),
            .text(id: 179, value: "audio"), .text(id: 180, value: "recording"),
            .bool(id: 181, value: report),
        ]
    }
}
