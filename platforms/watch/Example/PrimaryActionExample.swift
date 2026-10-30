import BotaWatchControl
import SwiftUI

/// Integration snippet, not a shipping application or SDK-owned screen.
/// Supply the action and enabled state from the customer's application.
struct PrimaryActionExample: View {
  let title: String
  let isEnabled: Bool
  let action: () -> Void

  var body: some View {
    Button(title, action: action)
      .disabled(!isEnabled)
      .botaPrimaryHandGesture()
  }
}
