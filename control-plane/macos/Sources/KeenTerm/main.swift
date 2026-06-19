import AppKit
import Darwin
import Foundation
import GhosttyTerminal
import SwiftUI

private let apiBase = URL(string: ProcessInfo.processInfo.environment["KEENTERM_API"] ?? "http://127.0.0.1:7070")!
private let repoDir = ProcessInfo.processInfo.environment["KEENTERM_REPO_DIR"] ?? "~/projects/shilo-ai-mono"
private let logPath = "/tmp/keenterm.log"

private func log(_ message: String) {
  let line = "[\(Date())] \(message)\n"
  if let data = line.data(using: .utf8) {
    if FileManager.default.fileExists(atPath: logPath),
       let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
    } else {
      try? data.write(to: URL(fileURLWithPath: logPath))
    }
  }
}

struct StackStatus: Decodable {
  var pg: Bool
  var redis: Bool
  var hasura: Bool

  var up: Bool { pg && redis && hasura }
}

struct AgentInfo: Decodable, Identifiable {
  var n: Int
  var name: String
  var state: String
  var codex: Bool
  var working: Bool
  var stack: StackStatus

  var id: Int { n }
  var running: Bool { state == "running" }
}

@MainActor
final class AgentsStore: ObservableObject {
  @Published var agents: [AgentInfo] = []
  @Published var selectedID: Int?
  @Published var busy: String?
  @Published var error: String?

  var selected: AgentInfo? {
    agents.first { $0.n == selectedID }
  }

  func refresh() async {
    do {
      agents = try await request("/api/agents")
      if selectedID == nil {
        selectedID = agents.first?.n
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  func create() async {
    await run("new") {
      let created: CreatedAgent = try await self.request("/api/agents", method: "POST")
      self.selectedID = created.n
    }
  }

  func start(_ agent: AgentInfo) async {
    await run("start-\(agent.n)") {
      let _: EmptyResponse = try await self.request("/api/agents/\(agent.n)/start", method: "POST")
    }
  }

  func stop(_ agent: AgentInfo) async {
    await run("stop-\(agent.n)") {
      let _: EmptyResponse = try await self.request("/api/agents/\(agent.n)/stop", method: "POST")
    }
  }

  func stackUp(_ agent: AgentInfo) async {
    await run("stack-\(agent.n)") {
      let _: EmptyResponse = try await self.request("/api/agents/\(agent.n)/stack/up", method: "POST")
    }
  }

  private func run(_ key: String, _ body: @escaping () async throws -> Void) async {
    if busy != nil { return }
    busy = key
    error = nil
    do {
      try await body()
      await refresh()
    } catch {
      self.error = error.localizedDescription
    }
    busy = nil
  }

  private func request<T: Decodable>(_ path: String, method: String = "GET") async throws -> T {
    var req = URLRequest(url: apiBase.appending(path: path))
    req.httpMethod = method
    let (data, response) = try await URLSession.shared.data(for: req)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 500
    if status < 200 || status >= 300 {
      throw NSError(domain: "KeenTerm", code: status, userInfo: [
        NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "HTTP \(status)"
      ])
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private struct CreatedAgent: Decodable {
  var n: Int
  var name: String
}

private struct EmptyResponse: Decodable {
  var ok: Bool?
}

@MainActor
final class TerminalSession: ObservableObject {
  let machine: String
  private var fd: Int32 = -1
  private var pid: pid_t = 0
  private var source: DispatchSourceRead?
  private var pendingOutput = Data()
  private var flushPendingScheduled = false
  private let pendingOutputCap = 512 * 1024
  private(set) var opened = false
  let terminalState = TerminalViewState()
  private lazy var ghosttySession = InMemoryTerminalSession(
    write: { [weak self] data in
      Task { @MainActor in self?.send(data) }
    },
    resize: { [weak self] viewport in
      Task { @MainActor in self?.resize(cols: Int(viewport.columns), rows: Int(viewport.rows)) }
    }
  )

  init(machine: String) {
    self.machine = machine
    terminalState.setTheme(TerminalTheme(light: .alabaster, dark: .alabaster))
    terminalState.setTerminalConfiguration(
      TerminalConfiguration.default
        .fontThicken(false)
        .custom("font-size", "15.5")
    )
    terminalState.configuration = TerminalSurfaceOptions(
      backend: .inMemory(ghosttySession),
      workingDirectory: repoDir
    )
  }

  func open() {
    close()
    opened = true

    var master: Int32 = 0
    var initialSize = winsize(ws_row: 30, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0)
    let child = forkpty(&master, nil, nil, &initialSize)
    if child == -1 {
      ghosttySession.receive("\r\n[forkpty failed]\r\n")
      return
    }

    if child == 0 {
      setenv("TERM", "xterm-256color", 1)
      let inner = ". ~/.asdf/asdf.sh 2>/dev/null || true; cd \(repoDir) 2>/dev/null || true; exec codex --yolo"
      execArgs(["/usr/bin/env", "orb", "-m", machine, "bash", "-lc", inner])
    }

    fd = master
    pid = child
    resize(cols: 120, rows: 30)
    receiveFromPty(Data("$ orb -m \(machine) codex --yolo\r\n".utf8))
    startReadLoop()
  }

  func close() {
    source?.cancel()
    source = nil
    if fd >= 0 {
      Darwin.close(fd)
      fd = -1
    }
    if pid > 0 {
      kill(pid, SIGHUP)
      pid = 0
    }
    opened = false
  }

  func ensureOpen() {
    guard !opened, pid <= 0 else { return }
    open()
  }

  func send(_ text: String) {
    guard let data = text.data(using: .utf8) else { return }
    send(data)
  }

  func send(_ data: Data) {
    guard fd >= 0 else { return }
    data.withUnsafeBytes { raw in
      guard let ptr = raw.baseAddress else { return }
      _ = Darwin.write(fd, ptr, raw.count)
    }
  }

  private func resize(cols: Int, rows: Int) {
    guard fd >= 0 else { return }
    log("resize request cols=\(cols) rows=\(rows)")
    guard cols >= 20, rows >= 5 else {
      log("resize ignored cols=\(cols) rows=\(rows)")
      return
    }
    var size = winsize(
      ws_row: UInt16(max(rows, 1)),
      ws_col: UInt16(max(cols, 1)),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
    _ = ioctl(fd, TIOCSWINSZ, &size)
    log("resize applied cols=\(cols) rows=\(rows)")
  }

  private func startReadLoop() {
    let readFD = fd
    let source = DispatchSource.makeReadSource(fileDescriptor: readFD, queue: .main)
    var buffer = [UInt8](repeating: 0, count: 16384)
    source.setEventHandler { [weak self] in
      guard let self else { return }
      let n = Darwin.read(readFD, &buffer, buffer.count)
      guard n > 0 else { return }
      self.receiveFromPty(Data(buffer.prefix(n)))
    }
    source.resume()
    self.source = source
  }

  private func receiveFromPty(_ data: Data) {
    guard terminalState.surface != nil else {
      pendingOutput.append(data)
      if pendingOutput.count > pendingOutputCap {
        pendingOutput = pendingOutput.suffix(pendingOutputCap)
      }
      schedulePendingFlush()
      return
    }
    ghosttySession.receive(data)
  }

  private func schedulePendingFlush() {
    guard !flushPendingScheduled else { return }
    flushPendingScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.flushPendingScheduled = false
      self?.flushPendingOutput()
    }
  }

  func flushPendingOutput() {
    guard terminalState.surface != nil, !pendingOutput.isEmpty else { return }
    let data = pendingOutput
    pendingOutput.removeAll(keepingCapacity: true)
    ghosttySession.receive(data)
  }
}

@MainActor
final class TerminalSessionsStore: ObservableObject {
  private var sessions: [String: TerminalSession] = [:]

  func session(for machine: String) -> TerminalSession {
    if let session = sessions[machine] {
      return session
    }
    let session = TerminalSession(machine: machine)
    sessions[machine] = session
    return session
  }
}

private func execArgs(_ args: [String]) -> Never {
  let cArgs = args.map { strdup($0) } + [nil]
  execv(cArgs[0], cArgs)
  for ptr in cArgs where ptr != nil {
    free(ptr)
  }
  _exit(127)
}

struct ContentView: View {
  @StateObject private var store = AgentsStore()
  @StateObject private var terminals = TerminalSessionsStore()

  var body: some View {
    NavigationSplitView {
      sidebar
        .frame(minWidth: 260)
    } detail: {
      detail
    }
    .task {
      await store.refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        await store.refresh()
      }
    }
  }

  private var sidebar: some View {
    VStack(spacing: 0) {
      HStack {
        Text("keenterm").font(.headline)
        Spacer()
        Button("+") { Task { await store.create() } }
        Button("refresh") { Task { await store.refresh() } }
      }
      .padding(12)

      List(store.agents, selection: $store.selectedID) { agent in
        VStack(alignment: .leading, spacing: 5) {
          HStack {
            Circle()
              .fill(agent.running ? Color.green : Color.gray)
              .frame(width: 8, height: 8)
            Text("agent \(agent.n)").font(.system(size: 13, weight: .semibold))
            Spacer()
            if agent.working { Text("working").foregroundStyle(.orange) }
          }
          Text(agent.name).font(.caption).foregroundStyle(.secondary)
          HStack {
            Button(agent.running ? "stop" : "start") {
              Task { agent.running ? await store.stop(agent) : await store.start(agent) }
            }
            if agent.running && !agent.stack.up {
              Button("stack") { Task { await store.stackUp(agent) } }
            }
          }
          .buttonStyle(.borderless)
          .font(.caption)
        }
        .padding(.vertical, 4)
        .tag(agent.n)
      }

      if let error = store.error {
        Text(error).font(.caption).foregroundStyle(.red).padding(10)
      }
    }
  }

  private var detail: some View {
    Group {
      if let agent = store.selected {
        if agent.running {
          TerminalDeck(
            agents: store.agents.filter(\.running),
            selectedName: agent.name,
            terminals: terminals
          )
        } else {
          ContentUnavailableView("VM stopped", systemImage: "power", description: Text("Start agent \(agent.n) first."))
        }
      } else {
        ContentUnavailableView("No agent selected", systemImage: "terminal")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct TerminalPane: View {
  @ObservedObject var session: TerminalSession
  var active: Bool

  var body: some View {
    GhosttyTerminalHost(session: session, active: active)
      .frame(minWidth: 720, minHeight: 420)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(red: 0.969, green: 0.969, blue: 0.969))
      .onAppear {
        if active {
          session.ensureOpen()
        }
      }
      .onChange(of: active) {
        if active {
          session.ensureOpen()
        }
      }
  }
}

struct TerminalDeck: View {
  let agents: [AgentInfo]
  let selectedName: String
  @ObservedObject var terminals: TerminalSessionsStore

  var body: some View {
    ZStack {
      ForEach(agents) { agent in
        let active = agent.name == selectedName
        TerminalPane(session: terminals.session(for: agent.name), active: active)
          .opacity(active ? 1 : 0)
          .allowsHitTesting(active)
          .zIndex(active ? 1 : 0)
      }
    }
    .background(Color(red: 0.969, green: 0.969, blue: 0.969))
  }
}

struct GhosttyTerminalHost: NSViewRepresentable {
  @ObservedObject var session: TerminalSession
  var active: Bool

  func makeNSView(context: Context) -> TerminalView {
    let view = TerminalView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
    view.delegate = session.terminalState
    view.controller = session.terminalState.controller
    view.configuration = session.terminalState.configuration
    DispatchQueue.main.async {
      view.fitToSize()
      if active {
        view.window?.makeFirstResponder(view)
      }
      session.flushPendingOutput()
    }
    return view
  }

  func updateNSView(_ view: TerminalView, context: Context) {
    view.delegate = session.terminalState
    view.controller = session.terminalState.controller
    view.configuration = session.terminalState.configuration
    DispatchQueue.main.async {
      if active {
        view.fitToSize()
        view.window?.makeFirstResponder(view)
      }
      session.flushPendingOutput()
    }
  }
}

@main
struct KeenTermApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView()
    }
    .commands {
      CommandGroup(replacing: .sidebar) {
        Button("Toggle Sidebar") {
          NSApp.keyWindow?.firstResponder?.tryToPerform(#selector(NSSplitViewController.toggleSidebar(_:)), with: nil)
        }
        .keyboardShortcut("b", modifiers: [.command])
      }
    }
    .windowStyle(.hiddenTitleBar)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.async {
      for window in NSApp.windows {
        window.title = ""
        window.titleVisibility = .hidden
        window.toolbar = nil
      }
    }
  }
}
