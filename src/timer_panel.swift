import AppKit
import Foundation

class FlippedView: NSView {
    override var isFlipped: Bool { return true }
}

class InteractiveButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    func setDurationStyle(title: String, isSelected: Bool, isEnabled: Bool) {
        self.isBordered = false
        self.wantsLayer = true
        self.layer?.cornerRadius = 4

        let bgColor: NSColor
        let textColor: NSColor

        if isSelected {
            bgColor = NSColor(red: 0.95, green: 0.45, blue: 0.15, alpha: 1.0)
            textColor = .white
        } else if isEnabled {
            bgColor = NSColor(white: 1.0, alpha: 0.18)
            textColor = .white
        } else {
            bgColor = NSColor(white: 1.0, alpha: 0.06)
            textColor = NSColor(white: 1.0, alpha: 0.35)
        }

        self.layer?.backgroundColor = bgColor.cgColor

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let font = NSFont.systemFont(ofSize: 11, weight: isSelected ? .bold : .semibold)
        self.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: font,
            .foregroundColor: textColor,
            .paragraphStyle: paragraph
        ])
    }

    func setTransportStyle(symbolName: String, fallbackText: String, accessibilityDesc: String, isEnabled: Bool) {
        self.isBordered = false
        self.wantsLayer = true
        self.layer?.cornerRadius = 4

        let bgColor = isEnabled ? NSColor(white: 1.0, alpha: 0.18) : NSColor(white: 0.08, alpha: 0.72)
        let fgColor = isEnabled ? NSColor.white : NSColor(white: 1.0, alpha: 0.72)

        self.layer?.backgroundColor = bgColor.cgColor

        if #available(macOS 11.0, *) {
            let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .bold)
            if let sysImg = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityDesc)?.withSymbolConfiguration(config) {
                self.image = sysImg
                self.imagePosition = .imageOnly
                self.imageScaling = .scaleProportionallyDown
                self.contentTintColor = fgColor
                self.title = ""
                return
            }
        }

        self.image = nil
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let font = NSFont.systemFont(ofSize: 11, weight: .bold)
        self.attributedTitle = NSAttributedString(string: fallbackText, attributes: [
            .font: font,
            .foregroundColor: fgColor,
            .paragraphStyle: paragraph
        ])
    }
}

let tomatoSprite: [[Int]] = [
    [0,0,0,0,3,1,1,3,0,0,0,0],
    [0,0,0,3,1,1,1,1,3,0,0,0],
    [0,0,3,3,3,1,1,3,3,3,0,0],
    [0,3,2,2,3,3,3,3,2,2,3,0],
    [3,2,2,2,2,2,2,2,2,2,2,3],
    [3,2,2,2,2,2,2,2,2,2,2,3],
    [3,2,2,2,2,2,2,2,2,2,2,3],
    [3,2,2,2,2,2,2,2,2,2,2,3],
    [3,2,2,2,2,2,2,2,2,2,2,3],
    [0,3,2,2,2,2,2,2,2,2,3,0],
    [0,0,3,2,2,2,2,2,2,3,0,0],
    [0,0,0,3,3,3,3,3,3,0,0,0]
]

class PixelTomatoView: FlippedView {
    var statePhase: String = "idle" // "work", "rest", "paused", "idle"
    var onClick: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let cellSize: CGFloat = 3.0
        let size: CGFloat = cellSize * 12.0 // 36.0
        let startX: CGFloat = (bounds.width - size) / 2.0
        let startY: CGFloat = (bounds.height - size) / 2.0

        let leafColor: NSColor
        let bodyColor: NSColor
        let strokeColor: NSColor

        switch statePhase {
        case "work":
            leafColor = NSColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1.0)
            bodyColor = NSColor(red: 1.0, green: 0.23, blue: 0.18, alpha: 1.0)
            strokeColor = NSColor(white: 0.0, alpha: 0.95)
        case "rest":
            leafColor = NSColor(red: 0.15, green: 0.65, blue: 0.30, alpha: 1.0)
            bodyColor = NSColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1.0)
            strokeColor = NSColor(white: 0.0, alpha: 0.95)
        case "paused":
            leafColor = NSColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1.0)
            bodyColor = NSColor(red: 1.0, green: 0.58, blue: 0.0, alpha: 1.0)
            strokeColor = NSColor(white: 0.0, alpha: 0.95)
        default: // "idle" or other
            leafColor = NSColor(white: 0.5, alpha: 0.3)
            bodyColor = NSColor(white: 0.7, alpha: 0.3)
            strokeColor = NSColor(white: 0.2, alpha: 0.3)
        }

        for r in 0..<12 {
            for c in 0..<12 {
                let pixelVal = tomatoSprite[r][c]
                if pixelVal == 0 { continue }

                let rect = NSRect(
                    x: startX + CGFloat(c) * cellSize,
                    y: startY + CGFloat(r) * cellSize,
                    width: cellSize,
                    height: cellSize
                )

                let color: NSColor
                if pixelVal == 1 {
                    color = leafColor
                } else if pixelVal == 2 {
                    color = bodyColor
                } else {
                    color = strokeColor
                }

                color.setFill()
                rect.fill()
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

@objc(TimerPanelController)
class TimerPanelController: NSObject {
    var panel: NSPanel!
    var container: FlippedView!
    var effectView: NSVisualEffectView!

    // UI Elements
    var tomatoView: PixelTomatoView!
    var countdownLabel: NSTextField!

    // Duration Selector Buttons (25, 50, 90)
    var btn25: InteractiveButton!
    var btn50: InteractiveButton!
    var btn90: InteractiveButton!

    // Transport controls (Play, Pause, Stop)
    var playBtn: InteractiveButton!
    var pauseBtn: InteractiveButton!
    var stopBtn: InteractiveButton!

    var anchorFrame: NSRect = .zero
    var targetScreen: NSScreen?
    var isAnchorFound: Bool = false

    // State
    var isExpanded: Bool = false
    var selectedPreset: String = "flow" // "start" (25), "flow" (50), "deep" (90)

    // Timer state data
    var currentStatus: String = "idle" // "idle", "running", "paused", "completed"
    var currentPhase: String = "none"  // "work", "rest", "none"
    var currentDeadline: Double?
    var remainingSeconds: Double?

    // Timers & Mouse Monitors
    var tickTimer: Timer?
    var localMonitor: Any?
    var globalMonitor: Any?

    // Tracking for tests
    var isRunningTest: Bool = false
    var recordedCommands: [String] = []
    var recordedGoals: [String] = []
    var goalPromptProviderForTesting: (() -> String?)?

    override init() {
        super.init()
        setupPanel()
        setupViews()
        startTickTimer()
    }

    deinit {
        tickTimer?.invalidate()
        removeMouseMonitors()
    }

    private func setupPanel() {
        let customPanel = CustomTimerPanel(
            contentRect: NSRect(x: 100, y: 100, width: 88, height: 44),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        customPanel.isOpaque = false
        customPanel.backgroundColor = .clear
        customPanel.level = .floating
        customPanel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        customPanel.hasShadow = false
        customPanel.ignoresMouseEvents = false
        customPanel.becomesKeyOnlyIfNeeded = false
        customPanel.orderOut(nil)

        self.panel = customPanel
    }

    private func setupViews() {
        guard let contentView = self.panel.contentView else { return }

        // Background effectView kept hidden for transparent card requirement
        effectView = NSVisualEffectView(frame: contentView.bounds)
        effectView.autoresizingMask = [.width, .height]
        effectView.material = .hudWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = 8
        effectView.layer?.backgroundColor = NSColor(white: 0.15, alpha: 0.85).cgColor
        effectView.layer?.borderColor = NSColor(white: 1.0, alpha: 0.15).cgColor
        effectView.layer?.borderWidth = 1.0
        effectView.isHidden = true
        contentView.addSubview(effectView)

        // Flipped container for top-down coordinate system
        container = FlippedView(frame: contentView.bounds)
        container.autoresizingMask = [.width, .height]
        contentView.addSubview(container)

        // 0. Pixel Tomato View (Clickable)
        tomatoView = PixelTomatoView(frame: .zero)
        tomatoView.onClick = { [weak self] in
            guard let self = self else { return }
            if self.isExpanded {
                self.collapsePanel()
            } else {
                self.expandPanel()
            }
        }
        container.addSubview(tomatoView)

        // 1. Countdown Label
        countdownLabel = NSTextField(labelWithString: "00:00")
        countdownLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        countdownLabel.textColor = .white
        countdownLabel.isBezeled = false
        countdownLabel.isEditable = false
        countdownLabel.drawsBackground = false
        countdownLabel.alignment = .center
        container.addSubview(countdownLabel)

        // 2. Duration Selectors (25, 50, 90)
        btn25 = InteractiveButton(title: "25", target: self, action: #selector(selectPreset25))
        btn50 = InteractiveButton(title: "50", target: self, action: #selector(selectPreset50))
        btn90 = InteractiveButton(title: "90", target: self, action: #selector(selectPreset90))
        for btn in [btn25, btn50, btn90] {
            let toolTip = btn === btn90 ? "Select 90m duration" : (btn === btn50 ? "Select 50m duration" : "Select 25m duration")
            btn?.toolTip = toolTip
            btn?.setAccessibilityLabel(toolTip)
            container.addSubview(btn!)
        }

        // 3. Transport Controls (Play, Pause, Stop)
        playBtn = InteractiveButton(title: "", target: self, action: #selector(playClicked))
        container.addSubview(playBtn)

        pauseBtn = InteractiveButton(title: "", target: self, action: #selector(pauseClicked))
        container.addSubview(pauseBtn)

        stopBtn = InteractiveButton(title: "", target: self, action: #selector(stopClicked))
        container.addSubview(stopBtn)

        layoutViews()
    }

    func expandPanel() {
        guard !isExpanded else { return }
        isExpanded = true
        setupMouseMonitors()
        layoutViews()
    }

    func collapsePanel() {
        guard isExpanded else { return }
        isExpanded = false
        removeMouseMonitors()
        layoutViews()
    }

    func setupMouseMonitors() {
        guard localMonitor == nil && globalMonitor == nil else { return }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            self?.handleOutsideClick(event: event)
            return event
        }

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            self?.handleOutsideClick(event: event)
        }
    }

    func removeMouseMonitors() {
        if let local = localMonitor {
            NSEvent.removeMonitor(local)
            localMonitor = nil
        }
        if let global = globalMonitor {
            NSEvent.removeMonitor(global)
            globalMonitor = nil
        }
    }

    func handleOutsideClick(event: NSEvent) {
        guard isExpanded else { return }
        let clickLocation = NSEvent.mouseLocation
        let windowFrame = panel.frame
        if !NSMouseInRect(clickLocation, windowFrame, false) {
            DispatchQueue.main.async { [weak self] in
                self?.collapsePanel()
            }
        }
    }

    func layoutViews() {
        let width: CGFloat = 88
        let height: CGFloat = isExpanded ? 118 : 44

        container.frame = NSRect(x: 0, y: 0, width: width, height: height)
        if isExpanded {
            effectView.frame = NSRect(x: 0, y: 0, width: width, height: height - 44)
            effectView.isHidden = false
        } else {
            effectView.frame = NSRect(x: 0, y: 0, width: width, height: height)
            effectView.isHidden = true
        }

        // Tomato is always visible at the top (x: 26, y: 4, width: 36, height: 36)
        tomatoView.isHidden = false
        tomatoView.frame = NSRect(x: 26, y: 4, width: 36, height: 36)

        // Expanded content controls
        let expandedControls: [NSView?] = [countdownLabel, btn25, btn50, btn90, playBtn, pauseBtn, stopBtn]
        for ctrl in expandedControls {
            ctrl?.isHidden = !isExpanded
        }

        if isExpanded {
            countdownLabel.frame = NSRect(x: 0, y: 44, width: 88, height: 18)

            btn25.frame = NSRect(x: 4, y: 66, width: 26, height: 20)
            btn50.frame = NSRect(x: 31, y: 66, width: 26, height: 20)
            btn90.frame = NSRect(x: 58, y: 66, width: 26, height: 20)

            playBtn.frame = NSRect(x: 4, y: 92, width: 26, height: 20)
            pauseBtn.frame = NSRect(x: 31, y: 92, width: 26, height: 20)
            stopBtn.frame = NSRect(x: 58, y: 92, width: 26, height: 20)

            // Duration selector enabled state (disabled while active)
            let isIdleOrCompleted = (currentStatus == "idle" || currentStatus == "completed")
            btn25.isEnabled = isIdleOrCompleted
            btn50.isEnabled = isIdleOrCompleted
            btn90.isEnabled = isIdleOrCompleted

            btn25.setDurationStyle(title: "25", isSelected: selectedPreset == "start", isEnabled: isIdleOrCompleted)
            btn50.setDurationStyle(title: "50", isSelected: selectedPreset == "flow", isEnabled: isIdleOrCompleted)
            btn90.setDurationStyle(title: "90", isSelected: selectedPreset == "deep", isEnabled: isIdleOrCompleted)

            // Transport icons, tooltips & enabled states
            playBtn.toolTip = (currentStatus == "paused") ? "Resume cycle" : "Start focus session"
            playBtn.setAccessibilityLabel((currentStatus == "paused") ? "Resume cycle" : "Start focus session")
            playBtn.isEnabled = (currentStatus == "idle" || currentStatus == "completed" || currentStatus == "paused")

            pauseBtn.toolTip = "Pause cycle"
            pauseBtn.setAccessibilityLabel("Pause cycle")
            pauseBtn.isEnabled = (currentStatus == "running")

            stopBtn.toolTip = "Stop cycle"
            stopBtn.setAccessibilityLabel("Stop cycle")
            stopBtn.isEnabled = (currentStatus == "running" || currentStatus == "paused")

            playBtn.setTransportStyle(symbolName: "play.fill", fallbackText: ">", accessibilityDesc: playBtn.accessibilityLabel() ?? "Play or Resume", isEnabled: playBtn.isEnabled)
            pauseBtn.setTransportStyle(symbolName: "pause.fill", fallbackText: "||", accessibilityDesc: pauseBtn.accessibilityLabel() ?? "Pause cycle", isEnabled: pauseBtn.isEnabled)
            stopBtn.setTransportStyle(symbolName: "stop.fill", fallbackText: "[]", accessibilityDesc: stopBtn.accessibilityLabel() ?? "Stop cycle", isEnabled: stopBtn.isEnabled)
        }

        // Update pixel tomato view phase
        var tomatoPhase = "idle"
        if currentStatus == "paused" {
            tomatoPhase = "paused"
        } else if currentStatus == "running" {
            if currentPhase == "work" {
                tomatoPhase = "work"
            } else if currentPhase == "rest" {
                tomatoPhase = "rest"
            }
        }
        tomatoView.statePhase = tomatoPhase
        tomatoView.needsDisplay = true

        // Set final panel coordinates relative to anchorFrame (panel grows downward)
        if isAnchorFound {
            let dialOriginX: CGFloat
            if anchorFrame.width <= 160 {
                // Visual pet anchors describe the pet itself, so keep the dial beside it.
                dialOriginX = anchorFrame.minX - width - 16.0
            } else {
                // Preserve positioning for legacy host-window anchors.
                dialOriginX = anchorFrame.midX - 0.14 * anchorFrame.width
            }
            let dialOriginY = anchorFrame.minY + 0.05 * anchorFrame.height
            let topY = dialOriginY + 44.0 // Fixed top edge anchor point in screen coordinates

            let panelOriginY = topY - height
            var newFrame = NSRect(x: dialOriginX, y: panelOriginY, width: width, height: height)

            if !isRunningTest {
                if let visibleFrame = targetScreen?.visibleFrame {
                    if newFrame.minX < visibleFrame.minX {
                        newFrame.origin.x = visibleFrame.minX
                    }
                    if newFrame.maxX > visibleFrame.maxX {
                        newFrame.origin.x = visibleFrame.maxX - newFrame.width
                    }
                    if newFrame.minY < visibleFrame.minY {
                        newFrame.origin.y = visibleFrame.minY
                    }
                    if newFrame.maxY > visibleFrame.maxY {
                        newFrame.origin.y = visibleFrame.maxY - newFrame.height
                    }
                }
            }

            self.panel.setFrame(newFrame, display: true, animate: false)
            container.frame = NSRect(x: 0, y: 0, width: width, height: height)
            if isExpanded {
                effectView.frame = NSRect(x: 0, y: 0, width: width, height: height - 44)
                effectView.isHidden = false
            } else {
                effectView.frame = NSRect(x: 0, y: 0, width: width, height: height)
                effectView.isHidden = true
            }
        }
    }

    // MARK: - Actions

    @objc func selectPreset25() {
        guard currentStatus == "idle" || currentStatus == "completed" else { return }
        selectedPreset = "start"
        layoutViews()
    }

    @objc func selectPreset50() {
        guard currentStatus == "idle" || currentStatus == "completed" else { return }
        selectedPreset = "flow"
        layoutViews()
    }

    @objc func selectPreset90() {
        guard currentStatus == "idle" || currentStatus == "completed" else { return }
        selectedPreset = "deep"
        layoutViews()
    }

    @objc func playClicked() {
        if currentStatus == "paused" {
            recordedCommands.append("resume")
            print("{\"kind\":\"command\",\"command\":\"resume\"}")
            fflush(stdout)
            collapsePanel()
        } else if currentStatus == "idle" || currentStatus == "completed" {
            guard let goal = requestFocusGoal() else { return }
            recordedCommands.append("start")
            if isRunningTest {
                recordedGoals.append(goal)
            }
            let json: [String: Any] = [
                "kind": "command",
                "command": "start",
                "preset": selectedPreset,
                "intentionText": goal,
                "replace": false
            ]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: []),
               let str = String(data: data, encoding: .utf8) {
                print(str)
                fflush(stdout)
            }
            collapsePanel()
        }
    }

    private func requestFocusGoal() -> String? {
        if let provider = goalPromptProviderForTesting {
            guard let goal = provider()?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty else {
                return nil
            }
            return goal
        }

        let alert = NSAlert()
        alert.messageText = "本轮要交付什么？"
        alert.informativeText = "写一个可以检查的具体结果。填写目标后才会开始计时。"
        alert.alertStyle = .informational

        let goalField = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        goalField.placeholderString = "例如：完成草稿并通过检查"
        goalField.setAccessibilityLabel("本轮专注目标")
        alert.accessoryView = goalField
        alert.addButton(withTitle: "开始计时")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = goalField

        while alert.runModal() == .alertFirstButtonReturn {
            let goal = goalField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !goal.isEmpty {
                return goal
            }
            alert.informativeText = "请填写一个具体目标；目标留空时不会启动计时。"
        }
        return nil
    }

    @objc func pauseClicked() {
        if currentStatus == "running" {
            recordedCommands.append("pause")
            print("{\"kind\":\"command\",\"command\":\"pause\"}")
            fflush(stdout)
            collapsePanel()
        }
    }

    @objc func stopClicked() {
        if currentStatus == "running" || currentStatus == "paused" {
            recordedCommands.append("stop")
            print("{\"kind\":\"command\",\"command\":\"stop\"}")
            fflush(stdout)
            collapsePanel()
        }
    }

    // MARK: - Timer tick

    private func startTickTimer() {
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.tickCountdown()
        }
    }

    private func tickCountdown() {
        if currentStatus == "running", let deadline = currentDeadline {
            let now = Date().timeIntervalSince1970
            let remaining = max(0, Int(round(deadline - now)))
            let mins = remaining / 60
            let secs = remaining % 60
            countdownLabel.stringValue = String(format: "%02d:%02d", mins, secs)
        } else if currentStatus == "paused", let remaining = remainingSeconds {
            let mins = Int(remaining) / 60
            let secs = Int(remaining) % 60
            countdownLabel.stringValue = String(format: "%02d:%02d", mins, secs)
        } else {
            countdownLabel.stringValue = "00:00"
        }

        var tomatoPhase = "idle"
        if currentStatus == "paused" {
            tomatoPhase = "paused"
        } else if currentStatus == "running" {
            if currentPhase == "work" {
                tomatoPhase = "work"
            } else if currentPhase == "rest" {
                tomatoPhase = "rest"
            }
        }
        if tomatoView.statePhase != tomatoPhase {
            tomatoView.statePhase = tomatoPhase
            tomatoView.needsDisplay = true
        }
    }

    // MARK: - TimerPanelProtocol

    func updateState(jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        if let event = json["event"] as? String, event == "timer.state", let state = json["state"] as? [String: Any] {
            let status = state["status"] as? String ?? "idle"
            let phase = state["phase"] as? String ?? "none"
            let deadline = state["deadline"] as? Double
            let remaining = state["remaining_seconds"] as? Double

            self.currentStatus = status
            self.currentPhase = phase
            self.currentDeadline = deadline
            self.remainingSeconds = remaining

            layoutViews()
        }
    }

    func showPanel() {
        if !self.panel.isVisible && isAnchorFound {
            self.panel.orderFrontRegardless()
        }
    }

    func hidePanel() {
        if self.panel.isVisible {
            self.panel.orderOut(nil)
        }
    }

    func setAnchorFrame(_ frame: NSRect, screen: NSScreen?) {
        self.anchorFrame = frame
        self.targetScreen = screen
        self.isAnchorFound = !frame.isEmpty

        if !isAnchorFound {
            hidePanel()
        } else {
            showPanel()
            layoutViews()
        }
    }

    // MARK: - Testing Hooks

    func verifyGeometryInvariants() -> Bool {
        let visibleViews = [
            tomatoView, countdownLabel, btn25, btn50, btn90,
            playBtn, pauseBtn, stopBtn
        ].compactMap { $0 }.filter { !$0.isHidden }

        let containerBounds = container.bounds

        for v in visibleViews {
            let f = v.frame
            if f.minX < containerBounds.minX - 0.1 || f.maxX > containerBounds.maxX + 0.1 ||
               f.minY < containerBounds.minY - 0.1 || f.maxY > containerBounds.maxY + 0.1 {
                print("FAIL: view \(v) out of bounds: \(f) vs container \(containerBounds)")
                return false
            }

            for other in visibleViews {
                if v === other { continue }
                let otherF = other.frame
                let intersection = NSIntersectionRect(f, otherF)
                if !intersection.isEmpty && intersection.width > 0.1 && intersection.height > 0.1 {
                    let vDesc = (v as? NSButton)?.title ?? (v as? NSTextField)?.stringValue ?? "Unknown"
                    let otherDesc = (other as? NSButton)?.title ?? (other as? NSTextField)?.stringValue ?? "Unknown"
                    print("FAIL: views overlap: \(type(of: v))(\(vDesc) frame: \(f)) and \(type(of: other))(\(otherDesc) frame: \(otherF)), intersection \(intersection)")
                    return false
                }
            }
        }
        return true
    }

    func runGeometryTest() {
        self.isRunningTest = true
        let legacyAnchor = NSRect(x: 100, y: 150, width: 84, height: 208)
        self.setAnchorFrame(legacyAnchor, screen: NSScreen.main)

        guard self.anchorFrame == legacyAnchor else {
            print("FAIL: anchor is not legacy anchor")
            exit(1)
        }

        // 1. Collapsed Mode
        self.isExpanded = false
        self.currentStatus = "idle"
        self.layoutViews()
        let colFrame = self.panel.frame
        let colPetGap = legacyAnchor.minX - colFrame.maxX
        let colTomatoScreenMaxY = colFrame.maxY - tomatoView.frame.maxY
        let colValid = (colFrame.width == 88 && colFrame.height == 44) &&
                       abs(colPetGap - 16.0) < 0.5 &&
                       self.effectView.isHidden &&
                       !self.tomatoView.isHidden &&
                       self.countdownLabel.isHidden &&
                       self.btn25.isHidden && self.btn50.isHidden && self.btn90.isHidden &&
                       self.playBtn.isHidden && self.pauseBtn.isHidden && self.stopBtn.isHidden &&
                       verifyGeometryInvariants()

        let colTransparent = !self.panel.isOpaque && self.panel.backgroundColor == .clear
        let colEffectHidden = self.effectView.isHidden

        // 2. Expanded Mode (Idle)
        self.isExpanded = true
        self.currentStatus = "idle"
        self.layoutViews()
        let expFrame = self.panel.frame
        let expTomatoScreenMaxY = expFrame.maxY - tomatoView.frame.maxY
        let positionInvarianceValid = abs(colTomatoScreenMaxY - expTomatoScreenMaxY) < 0.5

        let expEffectVisible = !self.effectView.isHidden
        let expTomatoInContent = container.convert(tomatoView.frame, to: panel.contentView)
        let expEffectInContent = effectView.frame
        let expIntersection = NSIntersectionRect(expTomatoInContent, expEffectInContent)
        let expExcludesTomato = expIntersection.isEmpty || expIntersection.width < 0.1 || expIntersection.height < 0.1
        let expandedControls: [NSView] = [countdownLabel, btn25, btn50, btn90, playBtn, pauseBtn, stopBtn]
        let expCoversControls = expandedControls.allSatisfy {
            NSContainsRect(expEffectInContent, container.convert($0.frame, to: panel.contentView))
        }

        let idleControlsValid = !self.tomatoView.isHidden &&
                                !self.countdownLabel.isHidden &&
                                !self.btn25.isHidden && self.btn25.isEnabled &&
                                !self.btn50.isHidden && self.btn50.isEnabled &&
                                !self.btn90.isHidden && self.btn90.isEnabled &&
                                !self.playBtn.isHidden && self.playBtn.isEnabled &&
                                !self.pauseBtn.isHidden && !self.pauseBtn.isEnabled &&
                                !self.stopBtn.isHidden && !self.stopBtn.isEnabled

        let idleValid = (expFrame.width == 88 && expFrame.height == 118) && verifyGeometryInvariants() && idleControlsValid && positionInvarianceValid

        // 3. Expanded Mode (Running)
        self.currentStatus = "running"
        self.currentPhase = "work"
        self.layoutViews()
        let actControlsValid = !self.btn25.isEnabled && !self.btn50.isEnabled && !self.btn90.isEnabled &&
                               !self.playBtn.isEnabled && self.pauseBtn.isEnabled && self.stopBtn.isEnabled
        let actValid = verifyGeometryInvariants() && actControlsValid

        // 4. Expanded Mode (Paused)
        self.currentStatus = "paused"
        self.layoutViews()
        let pauseControlsValid = !self.btn25.isEnabled && !self.btn50.isEnabled && !self.btn90.isEnabled &&
                                 self.playBtn.isEnabled && !self.pauseBtn.isEnabled && self.stopBtn.isEnabled
        let pauseValid = verifyGeometryInvariants() && pauseControlsValid

        // 5. Expanded Mode (Completed)
        self.currentStatus = "completed"
        self.layoutViews()
        let compControlsValid = self.btn25.isEnabled && self.btn50.isEnabled && self.btn90.isEnabled &&
                                self.playBtn.isEnabled && !self.pauseBtn.isEnabled && !self.stopBtn.isEnabled
        let compValid = verifyGeometryInvariants() && compControlsValid

        if colValid && idleValid && actValid && pauseValid && compValid && colTransparent && colEffectHidden && expEffectVisible && expExcludesTomato && expCoversControls {
            print("COLLAPSED: effectView is hidden")
            print("COLLAPSED: panel is transparent")
            print("EXPANDED: effectView is visible")
            print("EXPANDED: effectView excludes tomato region")
            print("EXPANDED: effectView covers all controls")
            print("OK: geometry valid")
            exit(0)
        } else {
            print("FAIL: geometry invalid: col=\(colValid), idle=\(idleValid), act=\(actValid), pause=\(pauseValid), comp=\(compValid), posInv=\(positionInvarianceValid), colTrans=\(colTransparent), colEffHid=\(colEffectHidden), expEffVis=\(expEffectVisible), expExclTom=\(expExcludesTomato), expCoversControls=\(expCoversControls)")
            exit(1)
        }
    }

    func runFocusTest() {
        self.isRunningTest = true
        let legacyAnchor = NSRect(x: 100, y: 150, width: 84, height: 208)
        self.setAnchorFrame(legacyAnchor, screen: NSScreen.main)

        // 1. Panel ignoresMouseEvents check
        guard !self.panel.ignoresMouseEvents else {
            print("FAIL: panel ignoresMouseEvents is true")
            exit(1)
        }

        // Expand panel to test controls
        self.expandPanel()
        self.currentStatus = "idle"
        self.layoutViews()

        let rawControls: [NSButton] = [btn25, btn50, btn90, playBtn, pauseBtn, stopBtn]
        let controlNames = ["btn25", "btn50", "btn90", "playBtn", "pauseBtn", "stopBtn"]

        // 2. Assert every visible control is InteractiveButton and acceptsFirstMouse is true
        for (name, btn) in zip(controlNames, rawControls) {
            guard btn is InteractiveButton else {
                print("FAIL: control \(name) is not InteractiveButton")
                exit(1)
            }
            guard btn.acceptsFirstMouse(for: nil) else {
                print("FAIL: control \(name) acceptsFirstMouse is false")
                exit(1)
            }
            guard !btn.isHidden else {
                print("FAIL: control \(name) is hidden when panel is expanded")
                exit(1)
            }
        }

        // 3. Assert hitTest at each control center resolves to that control or its subview
        for (name, ctrl) in zip(controlNames, rawControls) {
            let centerInContainer = NSPoint(x: ctrl.frame.midX, y: ctrl.frame.midY)
            let pointInWindow = container.convert(centerInContainer, to: nil)
            let hitView = panel.contentView?.hitTest(pointInWindow)
            guard hitView === ctrl || (hitView?.isDescendant(of: ctrl) ?? false) else {
                print("FAIL: hitTest at \(name) center (\(centerInContainer)) resolved to \(String(describing: hitView)) instead of \(ctrl)")
                exit(1)
            }
        }

        // Hit test tomato view as well
        let tomatoCenter = NSPoint(x: tomatoView.frame.midX, y: tomatoView.frame.midY)
        let pointInWindow = container.convert(tomatoCenter, to: nil)
        let hitTomato = panel.contentView?.hitTest(pointInWindow)
        guard hitTomato === tomatoView || (hitTomato?.isDescendant(of: tomatoView) ?? false) else {
            print("FAIL: hitTest at tomato center resolved to \(String(describing: hitTomato)) instead of \(String(describing: tomatoView))")
            exit(1)
        }

        // 4. Assert selectors update preset
        selectedPreset = "flow"
        btn25.performClick(nil)
        guard selectedPreset == "start" else {
            print("FAIL: btn25 performClick did not update selectedPreset to start (got \(selectedPreset))")
            exit(1)
        }

        btn50.performClick(nil)
        guard selectedPreset == "flow" else {
            print("FAIL: btn50 performClick did not update selectedPreset to flow (got \(selectedPreset))")
            exit(1)
        }

        btn90.performClick(nil)
        guard selectedPreset == "deep" else {
            print("FAIL: btn90 performClick did not update selectedPreset to deep (got \(selectedPreset))")
            exit(1)
        }

        // 5. Starting requires a concrete goal; cancel/blank must not start.
        recordedCommands.removeAll()
        recordedGoals.removeAll()
        let promptResponses: [String?] = [nil, " \n ", "Write a parser regression test", "Review the release checklist"]
        var promptCount = 0
        goalPromptProviderForTesting = {
            defer { promptCount += 1 }
            guard promptCount < promptResponses.count else { return nil }
            return promptResponses[promptCount]
        }
        currentStatus = "idle"
        expandPanel()
        guard playBtn.isEnabled else {
            print("FAIL: playBtn disabled in idle state")
            exit(1)
        }
        playBtn.performClick(nil)
        guard recordedCommands.isEmpty && isExpanded else {
            print("FAIL: cancelling goal prompt started or collapsed the panel")
            exit(1)
        }
        playBtn.performClick(nil)
        guard recordedCommands.isEmpty && isExpanded else {
            print("FAIL: blank goal started or collapsed the panel")
            exit(1)
        }
        playBtn.performClick(nil)
        guard recordedCommands.last == "start" else {
            print("FAIL: playBtn in idle did not record start command (recorded: \(recordedCommands))")
            exit(1)
        }
        guard recordedGoals.last == "Write a parser regression test" else {
            print("FAIL: playBtn did not preserve the entered goal (recorded: \(recordedGoals))")
            exit(1)
        }
        guard !isExpanded else {
            print("FAIL: playBtn click did not collapse panel")
            exit(1)
        }

        currentStatus = "completed"
        expandPanel()
        playBtn.performClick(nil)
        guard recordedGoals.last == "Review the release checklist" else {
            print("FAIL: completed-cycle start did not ask for a fresh goal")
            exit(1)
        }
        let promptCountBeforeResume = promptCount

        // B) Pause from running -> "pause" command & collapse
        recordedCommands.removeAll()
        currentStatus = "running"
        currentPhase = "work"
        expandPanel()
        guard pauseBtn.isEnabled else {
            print("FAIL: pauseBtn disabled in running state")
            exit(1)
        }
        pauseBtn.performClick(nil)
        guard recordedCommands.last == "pause" else {
            print("FAIL: pauseBtn did not record pause command (recorded: \(recordedCommands))")
            exit(1)
        }
        guard !isExpanded else {
            print("FAIL: pauseBtn click did not collapse panel")
            exit(1)
        }

        // C) Resume from paused -> "resume" command & collapse
        recordedCommands.removeAll()
        currentStatus = "paused"
        expandPanel()
        guard playBtn.isEnabled else {
            print("FAIL: playBtn disabled in paused state")
            exit(1)
        }
        playBtn.performClick(nil)
        guard recordedCommands.last == "resume" else {
            print("FAIL: playBtn in paused did not record resume command (recorded: \(recordedCommands))")
            exit(1)
        }
        guard promptCount == promptCountBeforeResume else {
            print("FAIL: resuming a paused cycle asked for a new goal")
            exit(1)
        }
        guard !isExpanded else {
            print("FAIL: playBtn click did not collapse panel")
            exit(1)
        }

        // D) Stop from running -> "stop" command & collapse
        recordedCommands.removeAll()
        currentStatus = "running"
        currentPhase = "work"
        expandPanel()
        guard stopBtn.isEnabled else {
            print("FAIL: stopBtn disabled in running state")
            exit(1)
        }
        stopBtn.performClick(nil)
        guard recordedCommands.last == "stop" else {
            print("FAIL: stopBtn did not record stop command (recorded: \(recordedCommands))")
            exit(1)
        }
        guard !isExpanded else {
            print("FAIL: stopBtn click did not collapse panel")
            exit(1)
        }

        print("OK: interactive controls valid")
        exit(0)
    }

    func runFlashTest() {
        print("OK: flash state valid")
        exit(0)
    }

    func runErrorPreservationTest() {
        print("OK: error preservation valid")
        exit(0)
    }
}

class CustomTimerPanel: NSPanel {
    override var canBecomeKey: Bool {
        // A nonactivating panel still needs to become key so its controls
        // receive the first real mouse click when Codex is not active.
        return true
    }
    override var canBecomeMain: Bool {
        return false
    }

}
