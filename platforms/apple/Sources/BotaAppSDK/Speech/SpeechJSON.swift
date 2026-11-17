import Foundation

struct SpeechPolicyUpdate {
    let state: SpeechState
    let captions: [SpeechCaption]
    let event: Data?
}

/// Projection only; all schema, authority and version validation lives in Rust.
enum SpeechJSON {
    static func command(_ type: String, _ fields: [String: Any] = [:]) throws -> Data {
        var value = fields; value["type"] = type
        return try JSONSerialization.data(withJSONObject: value)
    }
    static func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
    static func response(_ type: String, id: UInt32, field: String, body: Data) -> Data {
        // Preserve the host's exact JSON body for the shared validator.
        var result = Data("{\"type\":\"\(type)\",\"requestId\":\(id),\"\(field)\":".utf8)
        result.append(body); result.append(Data("}".utf8))
        return result
    }
    static func update(_ data: Data) throws -> SpeechPolicyUpdate {
        struct Captions: Decodable { let captions: [SpeechCaption] }
        let decoder = JSONDecoder()
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let event = try value?["event"].flatMap { event -> Data? in
            if event is NSNull { return nil }
            return try JSONSerialization.data(withJSONObject: event)
        }
        return try SpeechPolicyUpdate(state: decoder.decode(SpeechState.self, from: data),
                                      captions: decoder.decode(Captions.self, from: data).captions, event: event)
    }
}
