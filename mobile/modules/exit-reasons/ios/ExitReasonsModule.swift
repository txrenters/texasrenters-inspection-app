import ExpoModulesCore
import MetricKit

/**
 * Why iOS closed the app, kept until JavaScript asks for it.
 *
 * Technicians on move-outs saw the app freeze and then close to the home
 * screen (2026-10-06). Nothing in JavaScript can say why: a phone out of
 * memory, or the watchdog ending an app that stopped answering, kills the
 * process outright, and no handler runs. iOS records the reason itself and
 * hands it to MetricKit: crash and hang diagnostics on the next launch, and
 * once a day a count of every exit by cause (memory limit, watchdog, CPU,
 * crash, normal). This module keeps what it is given until the app's own error
 * log collects it -- see `src/lib/os-exit-reports.ts`.
 *
 * JavaScript loads it with `requireOptionalNativeModule`, so an update reaching
 * a 1.3.0 binary built before this module simply reports nothing.
 */
public class ExitReasonsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExitReasons")

    // As early as the app allows: iOS offers what it held back since the last
    // launch to whoever subscribes, not to whoever asks later.
    OnCreate {
      ExitReportSubscriber.shared.start()
    }

    // The reports kept so far, as a JSON array of { kind, json, receivedAt },
    // and forgotten here once handed over.
    AsyncFunction("takeReports") { () -> String in
      return ExitReportStore.shared.take()
    }
  }
}

final class ExitReportStore {
  static let shared = ExitReportStore()

  /// Bounded: a diagnostic payload with its call stacks can run to a few hundred kilobytes.
  private let maximumReports = 12
  private let lock = NSLock()

  private var fileURL: URL? {
    guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    return directory
      .appendingPathComponent("exit-reasons", isDirectory: true)
      .appendingPathComponent("pending.json")
  }

  func add(kind: String, json: Data) {
    guard let text = String(data: json, encoding: .utf8) else { return }
    lock.lock()
    defer { lock.unlock() }
    var reports = read()
    reports.append([
      "kind": kind,
      "json": text,
      "receivedAt": ISO8601DateFormatter().string(from: Date())
    ])
    if reports.count > maximumReports {
      reports.removeFirst(reports.count - maximumReports)
    }
    write(reports)
  }

  func take() -> String {
    lock.lock()
    defer { lock.unlock() }
    let reports = read()
    if let fileURL = fileURL, !reports.isEmpty {
      try? FileManager.default.removeItem(at: fileURL)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: reports),
          let text = String(data: data, encoding: .utf8) else {
      return "[]"
    }
    return text
  }

  private func read() -> [[String: String]] {
    guard let fileURL = fileURL,
          let data = try? Data(contentsOf: fileURL),
          let reports = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]] else {
      return []
    }
    return reports
  }

  private func write(_ reports: [[String: String]]) {
    guard let fileURL = fileURL,
          let data = try? JSONSerialization.data(withJSONObject: reports) else {
      return
    }
    try? FileManager.default.createDirectory(
      at: fileURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? data.write(to: fileURL, options: .atomic)
  }
}

final class ExitReportSubscriber: NSObject, MXMetricManagerSubscriber {
  static let shared = ExitReportSubscriber()

  private var started = false

  func start() {
    guard !started else { return }
    started = true
    MXMetricManager.shared.add(self)
  }

  /// About once a day: how many times the app was closed, by cause, among much else.
  func didReceive(_ payloads: [MXMetricPayload]) {
    for payload in payloads {
      ExitReportStore.shared.add(kind: "metrics", json: payload.jsonRepresentation())
    }
  }

  /// Crashes, hangs, and CPU or disk-write excesses; on the next launch since iOS 15.
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads {
      ExitReportStore.shared.add(kind: "diagnostics", json: payload.jsonRepresentation())
    }
  }
}
