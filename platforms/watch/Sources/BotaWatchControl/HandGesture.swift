import SwiftUI

extension View {
  /// Makes the customer's visible control the scene's primary Double Tap action.
  /// The customer owns its action, enabled state and business logic. This does not observe background gestures.
  @ViewBuilder public func botaPrimaryHandGesture(isEnabled: Bool = true) -> some View {
    #if os(watchOS)
      if #available(watchOS 11.0, *) {
        self.handGestureShortcut(.primaryAction, isEnabled: isEnabled)
      } else {
        self
      }
    #else
      self
    #endif
  }
}
