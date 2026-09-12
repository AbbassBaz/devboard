import AppKit
import Foundation
import Observation
import ServiceManagement
import SwiftUI
import UserNotifications

struct CrashInfo: Decodable {
  var gaveUp: Bool?
}

struct Service: Decodable {
  var id: String?
  var name: String
  var kind: String
  var status: String
  var ports: [Int]
  var rootPid: Int?
  var readiness: String?
  var hidden: Bool?
  var pinned: Bool?
  var cwd: String?
  var command: String?
  var crash: CrashInfo?

  var rowId: String { id ?? "\(name)-\(ports.first ?? 0)" }
}

struct Snapshot: Decodable {
  var services: [Service]
}

enum BoardConfig {
  static var url: String {
    let raw = (Bundle.main.object(forInfoDictionaryKey: "DevboardURL") as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let base = raw.isEmpty ? "http://127.0.0.1:4242" : raw
    return base.hasSuffix("/") ? String(base.dropLast()) : base
  }

  static var port: String {
    URL(string: url)?.port.map(String.init) ?? "4242"
  }
}

@MainActor
@Observable
final class BoardClient {
  private(set) var services: [Service] = []
  private(set) var reachable = false
  private var primedAlerts = false
  private var seenUnhealthy = Set<String>()
  private var seenGaveUp = Set<String>()

  var dev: [Service] {
    services.filter { $0.kind == "dev" && $0.hidden != true }
  }

  var on: Int { dev.filter { $0.status == "running" }.count }
  var off: Int { dev.filter { $0.status == "stopped" }.count }
  var unhealthy: Int { dev.filter { $0.readiness == "unhealthy" }.count }

  init() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    Task { await self.loop() }
  }

  private func loop() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(3))
    }
  }

  func refresh() async {
    do {
      guard let url = URL(string: "\(BoardConfig.url)/api/services") else { return }
      let (data, response) = try await URLSession.shared.data(from: url)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        reachable = false
        return
      }
      services = try JSONDecoder().decode(Snapshot.self, from: data).services
      reachable = true
      notifyFlips()
    } catch {
      reachable = false
    }
  }

  func start(_ service: Service) async {
    guard let id = service.id else { return }
    await post("/api/start", ["id": id])
  }

  func restart(_ service: Service) async {
    if let id = service.id {
      await post("/api/restart", ["id": id])
    } else if let pid = service.rootPid {
      await post("/api/restart", ["rootPid": pid])
    }
  }

  func stop(_ service: Service) async {
    guard let pid = service.rootPid else { return }
    await post("/api/kill", ["rootPid": pid])
  }

  func startAll() async {
    for s in dev where s.status == "stopped" && s.pinned == true {
      await start(s)
    }
  }

  func stopAll() async {
    for s in dev where s.status == "running" {
      await stop(s)
    }
  }

  private func post(_ path: String, _ body: [String: Any]) async {
    guard let url = URL(string: "\(BoardConfig.url)\(path)") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    _ = try? await URLSession.shared.data(for: req)
    await refresh()
  }

  private func notifyFlips() {
    if !primedAlerts {
      for s in dev {
        if s.readiness == "unhealthy" { seenUnhealthy.insert(s.rowId) }
        if s.crash?.gaveUp == true { seenGaveUp.insert(s.rowId) }
      }
      primedAlerts = true
      return
    }
    for s in dev {
      let key = s.rowId
      if s.readiness == "unhealthy" {
        if !seenUnhealthy.contains(key) {
          seenUnhealthy.insert(key)
          postNote(title: s.name, body: "unhealthy")
        }
      } else {
        seenUnhealthy.remove(key)
      }
      if s.crash?.gaveUp == true {
        if !seenGaveUp.contains(key) {
          seenGaveUp.insert(key)
          postNote(title: s.name, body: "restart failed")
        }
      } else {
        seenGaveUp.remove(key)
      }
    }
  }

  private func postNote(title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req)
  }
}

@main
struct DevboardTrayApp: App {
  @State private var board = BoardClient()

  var body: some Scene {
    MenuBarExtra {
      TrayMenu(board: board)
    } label: {
      TrayLabel(board: board)
    }
    .menuBarExtraStyle(.menu)
  }
}

struct TrayLabel: View {
  var board: BoardClient

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol)
      Text(board.reachable ? "\(board.on)" : "–")
        .monospacedDigit()
    }
    .foregroundStyle(board.unhealthy > 0 ? Color.red : Color.primary)
    .accessibilityLabel(label)
  }

  private var symbol: String {
    if !board.reachable { return "circle.dotted" }
    if board.unhealthy > 0 { return "exclamationmark.circle.fill" }
    if board.on > 0 { return "circle.fill" }
    return "circle"
  }

  private var label: String {
    if !board.reachable { return "devboard is off" }
    if board.unhealthy > 0 { return "\(board.unhealthy) unhealthy, \(board.on) running" }
    return "\(board.on) running, \(board.off) idle"
  }
}

struct TrayMenu: View {
  var board: BoardClient
  @State private var login = SMAppService.mainApp.status == .enabled

  var body: some View {
    if !board.reachable {
      Text("Board is off")
      Button("Start board") { startBoard() }
    } else {
      Text(statusLine)
        .foregroundStyle(board.unhealthy > 0 ? .red : .secondary)
      Divider()
      ForEach(board.dev.prefix(12), id: \.rowId) { service in
        Menu(rowTitle(service)) {
          Button("Open") { openPort(service) }
            .disabled(service.ports.first == nil)
          Button("Restart") { Task { await board.restart(service) } }
          Button("Stop") { Task { await board.stop(service) } }
            .disabled(service.status != "running")
          Button("Copy run command") { copyRun(service) }
          Button("Logs") { openLogs(service) }
            .disabled(service.id == nil)
        }
      }
      if board.dev.count > 12 {
        Text("+\(board.dev.count - 12) more on the board")
      }
      Divider()
      Button("Open Board") { openBoard() }
      Button("Start all") { Task { await board.startAll() } }
        .disabled(board.off == 0)
      Button("Stop all") { Task { await board.stopAll() } }
        .disabled(board.on == 0)
    }
    Divider()
    Toggle("Open at login", isOn: Binding(
      get: { login },
      set: { enabled in
        do {
          if enabled { try SMAppService.mainApp.register() }
          else { try SMAppService.mainApp.unregister() }
          login = SMAppService.mainApp.status == .enabled
        } catch {
          login = SMAppService.mainApp.status == .enabled
        }
      }
    ))
    Button("Quit menu bar") { NSApplication.shared.terminate(nil) }
  }

  private var statusLine: String {
    if board.unhealthy > 0 { return "\(board.unhealthy) unhealthy · \(board.on) on · \(board.off) off" }
    return "\(board.on) on · \(board.off) off"
  }

  private func rowTitle(_ s: Service) -> String {
    let mark = s.status == "running" ? (s.readiness == "unhealthy" ? "⚠" : "●") : "○"
    let port = s.ports.first.map { ":\($0)" } ?? ""
    return "\(mark)  \(s.name)  \(port)"
  }

  private func openPort(_ s: Service) {
    guard let port = s.ports.first, let url = URL(string: "http://127.0.0.1:\(port)") else { return }
    NSWorkspace.shared.open(url)
  }

  private func copyRun(_ s: Service) {
    let cmd = "cd \(s.cwd ?? ".") && \(s.command ?? "")"
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(cmd, forType: .string)
  }

  private func openLogs(_ s: Service) {
    guard let id = s.id?.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
    guard let url = URL(string: "\(BoardConfig.url)/?sel=\(id)") else { return }
    NSWorkspace.shared.open(url)
  }

  private func openBoard() {
    if let url = URL(string: BoardConfig.url) {
      NSWorkspace.shared.open(url)
    }
  }

  private func startBoard() {
    let root = Bundle.main.object(forInfoDictionaryKey: "DevboardRoot") as? String ?? ""
    guard !root.isEmpty else { return }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc", "cd \(shellEscape(root)) && DEVBOARD_TRAY=0 PORT=\(BoardConfig.port) nohup bun run server.ts >/dev/null 2>&1 &"]
    try? task.run()
    Task {
      try? await Task.sleep(for: .milliseconds(800))
      await board.refresh()
    }
  }

  private func shellEscape(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }
}
