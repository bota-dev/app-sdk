protocol MaterialHost: Sendable {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error>
}
