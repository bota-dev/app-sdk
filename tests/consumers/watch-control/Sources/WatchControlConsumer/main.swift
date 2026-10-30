import WatchControlIntegration

@main struct Consumer {
  @MainActor static func main() throws {
    try checkIntegration()
    print("Watch SDK consumer compiled without application or login dependencies.")
  }
}
