import AppKit
import Foundation
import Observation
import ServiceManagement
import SwiftUI

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

  var dev: [Service] {
    services.filter { $0.kind == "dev" && $0.hidden != true }
  }

  var on: Int { dev.filter { $0.status == "running" }.count }
  var off: Int { dev.filter { $0.status == "stopped" }.count }
  var unhealthy: Int { dev.filter { $0.readiness == "unhealthy" }.count }

  init() {
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
    } catch {
      reachable = false
    }
  }

  func start(_ service: Service) async {
    guard let id = service.id else { return }
    await post("/api/start", ["id": id])
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
        Button(rowTitle(service)) {
          Task { await activate(service) }
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

  private func activate(_ s: Service) async {
    if s.status == "running", let port = s.ports.first, let url = URL(string: "http://127.0.0.1:\(port)") {
      NSWorkspace.shared.open(url)
      return
    }
    await board.start(s)
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
