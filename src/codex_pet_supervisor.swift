import AppKit
import Darwin
import Foundation

private enum Component: String {
    case timer
    case companion
}

private final class PetSupervisor: NSObject {
    private let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    private let installDir = ProcessInfo.processInfo.environment["CODEX_PET_INSTALL_DIR"] ?? ""
    private let nodePath = ProcessInfo.processInfo.environment["CODEX_PET_NODE_BIN"] ?? ""
    private let pythonPath = ProcessInfo.processInfo.environment["CODEX_PET_PYTHON_BIN"] ?? ""
    private let label = "io.github.codex-pet-companion"
    private let supportedBundleIDs: Set<String> = [
        "com.openai.codex",
        "com.openai.chatgpt",
        "com.openai.chat"
    ]

    private var timerProcess: Process?
    private var companionProcess: Process?
    private var timerProbe: Timer?
    private var readinessProbe: Timer?
    private var intentionalStops: Set<pid_t> = []
    private var timerFailures: [Date] = []
    private var companionFailures: [Date] = []
    private var timerRetry: Timer?
    private var companionRetry: Timer?
    private var timerStartedAt: Date?
    private var companionStartedAt: Date?
    private var companionToken: String?
    private var gptApplicationID: String?
    private var stopping = false
    private var timerState = "starting"
    private var companionState = "waiting"
    private var lastErrors: [String: String] = [:]
    private var lastStatusData: Data?
    private let ioQueue = DispatchQueue(label: "io.github.codex-pet-companion.supervisor-io")
    private var repeatedLogs: [String: (lastLogged: Date, suppressed: Int)] = [:]
    private var termSignalSource: DispatchSourceSignal?
    private var interruptSignalSource: DispatchSourceSignal?

    private var stateDir: String { "\(home)/.codex/ultradian-rhythm" }
    private var socketPath: String { "\(stateDir)/daemon.sock" }
    private var statusPath: String { "\(stateDir)/supervisor-status.json" }
    private var readyPath: String { "\(stateDir)/companion-ready.json" }
    private var scriptPath: String { "\(installDir)/bin/codex-pet-companion.js" }
    private var pythonModulePath: String { "\(installDir)/src" }

    func run() {
        _ = umask(0o077)
        guard createStateDirectory() else {
            fputs("codex-pet-supervisor: state directory is unavailable or unsafe\n", stderr)
            exit(78)
        }
        installWorkspaceObservers()
        installSignalHandlers()
        writeStatus()
        startTimer()
        updateGPTState()
        RunLoop.main.run()
    }

    private func createStateDirectory() -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: stateDir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            // An existing directory is expected; the descriptor check below is authoritative.
        }

        let directoryFD = stateDir.withCString { open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
        guard directoryFD >= 0 else { return false }
        defer { close(directoryFD) }

        var info = stat()
        guard fstat(directoryFD, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              info.st_uid == getuid(),
              fchmod(directoryFD, mode_t(0o700)) == 0 else {
            return false
        }
        return true
    }

    private func installWorkspaceObservers() {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let self,
                  let bundleID = app.bundleIdentifier,
                  self.supportedBundleIDs.contains(bundleID) else { return }
            self.gptApplicationID = bundleID
            self.companionFailures.removeAll()
            self.companionRetry?.invalidate()
            self.companionRetry = nil
            self.writeStatus()
            self.startCompanionIfReady()
        }
        center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let self,
                  let bundleID = app.bundleIdentifier,
                  self.supportedBundleIDs.contains(bundleID) else { return }
            self.updateGPTState()
        }
    }

    private func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        termSignalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSignalSource?.setEventHandler { [weak self] in self?.shutdown() }
        termSignalSource?.resume()
        interruptSignalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        interruptSignalSource?.setEventHandler { [weak self] in self?.shutdown() }
        interruptSignalSource?.resume()
    }

    private func updateGPTState() {
        let running = NSWorkspace.shared.runningApplications.first {
            guard let bundleID = $0.bundleIdentifier else { return false }
            return supportedBundleIDs.contains(bundleID)
        }
        gptApplicationID = running?.bundleIdentifier
        if running == nil {
            companionRetry?.invalidate()
            companionRetry = nil
            stopCompanion()
            companionState = "waiting"
            writeStatus()
        } else {
            companionFailures.removeAll()
            startCompanionIfReady()
        }
    }

    private func startTimer() {
        guard !stopping, timerProcess == nil else { return }
        guard FileManager.default.isExecutableFile(atPath: pythonPath),
              FileManager.default.fileExists(atPath: pythonModulePath) else {
            fail(.timer, "Python runtime or timer package is missing")
            return
        }

        timerState = "starting"
        writeStatus()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: pythonPath)
        process.arguments = ["-m", "ultradian_rhythm.daemon"]
        process.currentDirectoryURL = URL(fileURLWithPath: installDir)
        process.environment = ProcessInfo.processInfo.environment.merging([
            "HOME": home,
            "PYTHONPATH": pythonModulePath,
            "PYTHONUNBUFFERED": "1"
        ]) { _, new in new }
        attachOutput(process, component: .timer)
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                self?.handleTermination(.timer, pid: ended.processIdentifier, code: ended.terminationStatus)
            }
        }
        do {
            try process.run()
            timerProcess = process
            timerStartedAt = Date()
            log("timer", "timer daemon launched pid=\(process.processIdentifier)")
            pollTimerReady(deadline: Date().addingTimeInterval(15))
            scheduleHealthReset(.timer, pid: process.processIdentifier)
        } catch {
            fail(.timer, "could not launch timer daemon: \(error.localizedDescription)")
        }
    }

    private func pollTimerReady(deadline: Date) {
        timerProbe?.invalidate()
        guard !stopping, timerProcess != nil else { return }
        if unixSocketAcceptsConnection(socketPath) {
            timerState = "running"
            writeStatus()
            log("timer", "timer daemon is accepting local connections")
            startCompanionIfReady()
            return
        }
        if Date() >= deadline {
            if let process = timerProcess {
                intentionalStops.insert(process.processIdentifier)
                timerProcess = nil
                if process.isRunning { process.terminate() }
            }
            timerState = "failed"
            fail(.timer, "timer daemon did not open its local socket within 15 seconds")
            return
        }
        timerProbe = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            self?.pollTimerReady(deadline: deadline)
        }
    }

    private func startCompanionIfReady() {
        guard !stopping, gptApplicationID != nil, timerState == "running",
              timerProcess != nil, companionProcess == nil, companionRetry == nil else { return }
        guard FileManager.default.isExecutableFile(atPath: nodePath),
              FileManager.default.isExecutableFile(atPath: "\(installDir)/bin/Pet Pomodoro Companion.app/Contents/MacOS/companion_renderer") else {
            fail(.companion, "Node runtime or prebuilt pet renderer is missing")
            return
        }

        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        companionToken = token
        try? FileManager.default.removeItem(atPath: readyPath)
        companionState = "starting"
        writeStatus()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath, "--worker", "--ready-token", token]
        process.currentDirectoryURL = URL(fileURLWithPath: installDir)
        process.environment = ProcessInfo.processInfo.environment.merging([
            "HOME": home,
            "NODE_ENV": "production",
            "CODEX_PET_INSTALL_DIR": installDir
        ]) { _, new in new }
        attachOutput(process, component: .companion)
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                self?.handleTermination(.companion, pid: ended.processIdentifier, code: ended.terminationStatus)
            }
        }
        do {
            try process.run()
            companionProcess = process
            companionStartedAt = Date()
            log("companion", "pet companion launched pid=\(process.processIdentifier)")
            pollCompanionReady(pid: process.processIdentifier, token: token, deadline: Date().addingTimeInterval(30))
            scheduleHealthReset(.companion, pid: process.processIdentifier)
        } catch {
            fail(.companion, "could not launch pet companion: \(error.localizedDescription)")
        }
    }

    private func pollCompanionReady(pid: pid_t, token: String, deadline: Date) {
        readinessProbe?.invalidate()
        guard !stopping, companionProcess?.processIdentifier == pid else { return }
        if let data = FileManager.default.contents(atPath: readyPath),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           object["token"] as? String == token,
           (object["pid"] as? Int) == Int(pid) {
            if object["ready"] as? Bool == true {
                companionState = "running"
                writeStatus()
                log("companion", "pet companion is ready")
                return
            }
            if let error = object["error"] as? String, !error.isEmpty {
                log("companion", "startup rejected: \(error)")
            }
        }
        if Date() >= deadline {
            fail(.companion, "pet companion did not report ready within 30 seconds")
            stopCompanion()
            return
        }
        readinessProbe = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            self?.pollCompanionReady(pid: pid, token: token, deadline: deadline)
        }
    }

    private func stopCompanion() {
        readinessProbe?.invalidate()
        readinessProbe = nil
        guard let process = companionProcess else { return }
        intentionalStops.insert(process.processIdentifier)
        companionProcess = nil
        companionToken = nil
        if process.isRunning { process.terminate() }
    }

    private func handleTermination(_ component: Component, pid: pid_t, code: Int32) {
        if intentionalStops.remove(pid) != nil { return }
        switch component {
        case .timer:
            guard timerProcess?.processIdentifier == pid else { return }
            timerProcess = nil
            timerProbe?.invalidate()
            timerState = "failed"
            stopCompanion()
            fail(.timer, "timer daemon exited with status \(code)")
        case .companion:
            guard companionProcess?.processIdentifier == pid else { return }
            companionProcess = nil
            readinessProbe?.invalidate()
            companionToken = nil
            companionState = gptApplicationID == nil ? "waiting" : "failed"
            writeStatus()
            guard gptApplicationID != nil else { return }
            fail(.companion, "pet companion exited with status \(code)")
        }
    }

    private func fail(_ component: Component, _ message: String) {
        let now = Date()
        let cutoff = now.addingTimeInterval(-600)
        var failures = component == .timer ? timerFailures : companionFailures
        failures.removeAll { $0 < cutoff }
        failures.append(now)
        if component == .timer { timerFailures = failures } else { companionFailures = failures }
        lastErrors[component.rawValue] = message
        writeStatus()
        log(component.rawValue, "failure \(failures.count)/5: \(message)")

        guard failures.count < 5 else {
            if component == .timer { timerState = "paused-after-failures" }
            else { companionState = "paused-after-failures" }
            writeStatus()
            log(component.rawValue, "automatic recovery paused; run codex-pet-companion repair after resolving the cause")
            return
        }
        let delays: [TimeInterval] = [2, 5, 15, 60]
        scheduleRetry(component, after: delays[min(failures.count - 1, delays.count - 1)])
    }

    private func scheduleRetry(_ component: Component, after delay: TimeInterval) {
        let item = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self, !self.stopping else { return }
            switch component {
            case .timer:
                self.timerRetry = nil
                self.startTimer()
            case .companion:
                self.companionRetry = nil
                self.startCompanionIfReady()
            }
        }
        if component == .timer {
            timerRetry?.invalidate()
            timerRetry = item
        } else {
            companionRetry?.invalidate()
            companionRetry = item
        }
    }

    private func scheduleHealthReset(_ component: Component, pid: pid_t) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in
            guard let self else { return }
            let process = component == .timer ? self.timerProcess : self.companionProcess
            guard process?.processIdentifier == pid, process?.isRunning == true else { return }
            if component == .timer {
                self.timerFailures.removeAll()
                self.lastErrors[Component.timer.rawValue] = nil
            } else {
                self.companionFailures.removeAll()
                self.lastErrors[Component.companion.rawValue] = nil
            }
            self.writeStatus()
        }
    }

    private func attachOutput(_ process: Process, component: Component) {
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        for handle in [stdout.fileHandleForReading, stderr.fileHandleForReading] {
            handle.readabilityHandler = { [weak self] stream in
                let data = stream.availableData
                guard !data.isEmpty else {
                    stream.readabilityHandler = nil
                    return
                }
                let text = String(decoding: data, as: UTF8.self)
                    .split(whereSeparator: \.isNewline)
                    .joined(separator: " | ")
                if !text.isEmpty { self?.log(component.rawValue, String(text.prefix(4000))) }
            }
        }
    }

    private func unixSocketAcceptsConnection(_ path: String) -> Bool {
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else { return false }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: bytes.count + 1) { chars in
                for (index, byte) in bytes.enumerated() { chars[index] = CChar(byte) }
                chars[bytes.count] = 0
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return result == 0
    }

    private func writeStatus() {
        let object: [String: Any] = [
            "schemaVersion": 1,
            "service": stopping ? "stopping" : "running",
            "pid": getpid(),
            "gpt": gptApplicationID == nil ? "not-running" : "running",
            "gptBundleIdentifier": gptApplicationID as Any? ?? NSNull(),
            "timer": timerState,
            "companion": companionState,
            "errors": lastErrors
        ]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted]) else { return }
        if data == lastStatusData { return }
        lastStatusData = data
        ioQueue.async { [statusPath] in
            let temp = "\(statusPath).\(getpid()).tmp"
            do {
                try data.write(to: URL(fileURLWithPath: temp), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp)
                if FileManager.default.fileExists(atPath: statusPath) {
                    _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: statusPath), withItemAt: URL(fileURLWithPath: temp))
                } else {
                    try FileManager.default.moveItem(atPath: temp, toPath: statusPath)
                }
            } catch {
                try? FileManager.default.removeItem(atPath: temp)
            }
        }
    }

    private func log(_ component: String, _ message: String) {
        ioQueue.async { [stateDir] in
            let logPath = "\(stateDir)/supervisor.log"
            let now = Date()
            let key = "\(component)\u{0}\(message)"
            var loggedMessage = message
            if var previous = self.repeatedLogs[key] {
                if now.timeIntervalSince(previous.lastLogged) < 60 {
                    previous.suppressed += 1
                    self.repeatedLogs[key] = previous
                    return
                }
                if previous.suppressed > 0 {
                    loggedMessage += " (suppressed \(previous.suppressed) repeated messages)"
                }
                previous.lastLogged = now
                previous.suppressed = 0
                self.repeatedLogs[key] = previous
            } else {
                self.repeatedLogs[key] = (lastLogged: now, suppressed: 0)
            }
            if self.repeatedLogs.count > 256 {
                self.repeatedLogs = self.repeatedLogs.filter { now.timeIntervalSince($0.value.lastLogged) < 600 }
            }
            let entry = "\(ISO8601DateFormatter().string(from: now)) [\(component)] \(loggedMessage)\n"
            guard let data = entry.data(using: .utf8) else { return }
            let maxBytes = 1_048_576
            let fm = FileManager.default
            if fm.fileExists(atPath: logPath),
               let attrs = try? fm.attributesOfItem(atPath: logPath),
               ((attrs[.size] as? NSNumber)?.intValue ?? 0) + data.count > maxBytes {
                try? fm.removeItem(atPath: "\(logPath).2")
                if fm.fileExists(atPath: "\(logPath).1") { try? fm.moveItem(atPath: "\(logPath).1", toPath: "\(logPath).2") }
                try? fm.moveItem(atPath: logPath, toPath: "\(logPath).1")
            }
            if fm.fileExists(atPath: logPath), let handle = FileHandle(forWritingAtPath: logPath) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                fm.createFile(atPath: logPath, contents: data, attributes: [.posixPermissions: 0o600])
            }
        }
    }

    private func shutdown() {
        guard !stopping else { return }
        stopping = true
        timerProbe?.invalidate()
        readinessProbe?.invalidate()
        timerRetry?.invalidate()
        companionRetry?.invalidate()
        timerState = "stopping"
        companionState = "stopping"
        writeStatus()
        stopCompanion()
        if let process = timerProcess {
            intentionalStops.insert(process.processIdentifier)
            timerProcess = nil
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
    }
}

private let supervisor = PetSupervisor()
supervisor.run()
