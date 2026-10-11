import Darwin

/// iOS 15-compatible monotonic time that keeps advancing while the device sleeps.
/// Keep the continuous-clock semantics of context refresh and the live-session budget.
struct ByoContinuousInstant: Sendable {
    let nanoseconds: UInt64

    static var now: Self {
        Self(nanoseconds: clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW))
    }

    func seconds(to later: Self) -> Double {
        Double(later.nanoseconds - nanoseconds) / 1_000_000_000
    }
}
