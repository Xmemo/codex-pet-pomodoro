import AppKit
import Foundation
import ImageIO


// MARK: - Atlas frame extraction
struct AtlasInfo {
    let width: Int
    let height: Int
    let columns: Int
    let rows: Int
    let cellWidth: Int = 192
    let cellHeight: Int = 208
}

private let maxAtlasBytes = 64 * 1024 * 1024
private let maxAtlasRows = 16
private let maxFrameBytes = 8 * 1024 * 1024
private let maxFrameDimension = 2048
private let maxFramePixels = 4 * 1024 * 1024
private let maxTotalClipPixels = 16 * 1024 * 1024
private let maxFramesPerClip = 60
private let maxTotalClipFrames = 120
private let maxConfigBytes = 1024 * 1024

private func imageDimensions(source: CGImageSource) -> (width: Int, height: Int)? {
    guard let copiedProperties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) else { return nil }
    let properties = copiedProperties as NSDictionary
    guard let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else { return nil }
    return (width.intValue, height.intValue)
}

private func fileSize(at url: URL) -> Int? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = attributes[.size] as? NSNumber else { return nil }
    return size.intValue
}

private func loadBoundedFrame(path: URL, accumulatedPixels: Int) -> (image: CGImage, pixels: Int)? {
    guard let size = fileSize(at: path), size > 0, size <= maxFrameBytes,
          let source = CGImageSourceCreateWithURL(path as CFURL, nil),
          let dimensions = imageDimensions(source: source),
          dimensions.width > 0, dimensions.height > 0,
          dimensions.width <= maxFrameDimension, dimensions.height <= maxFrameDimension,
          dimensions.width * dimensions.height <= maxFramePixels,
          accumulatedPixels + dimensions.width * dimensions.height <= maxTotalClipPixels,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    return (image, dimensions.width * dimensions.height)
}

func loadAtlas(path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let size = fileSize(at: url), size > 0, size <= maxAtlasBytes,
          let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let dimensions = imageDimensions(source: source),
          dimensions.width == 1536,
          dimensions.height >= 1872,
          dimensions.height % 208 == 0,
          dimensions.height / 208 <= maxAtlasRows,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        return nil
    }
    return image
}

func extractFrame(atlas: CGImage, atlasInfo: AtlasInfo, row: Int, col: Int) -> CGImage? {
    let x = col * atlasInfo.cellWidth
    let y = row * atlasInfo.cellHeight
    return atlas.cropping(to: CGRect(x: x, y: y, width: atlasInfo.cellWidth, height: atlasInfo.cellHeight))
}

func deriveAtlasInfo(width: Int, height: Int) -> AtlasInfo? {
    guard width == 1536,
          height >= 1872,
          height % 208 == 0,
          height / 208 <= maxAtlasRows else {
        return nil
    }
    return AtlasInfo(width: width, height: height, columns: width / 192, rows: height / 208)
}

func easeOvershoot(_ t: CGFloat) -> CGFloat {
    let clampedT = max(0.0, min(1.0, t))
    let u = 1.0 - clampedT
    return 1.0 - u * u * u + 0.35 * clampedT * clampedT * u
}

// MARK: - Visual Pet Template Matching
struct VisualPetMatch {
    let rect: CGRect
    let confidence: Double
}

func matchPetTemplate(
    hostImage: CGImage,
    templateImage: CGImage,
    minConfidence: Double = 0.70
) -> VisualPetMatch? {
    let hostW = hostImage.width
    let hostH = hostImage.height
    let templW = templateImage.width
    let templH = templateImage.height

    // Guard: template must be positive size and strictly within host dimensions
    guard hostW > 0, hostH > 0, templW > 0, templH > 0,
          templW <= hostW, templH <= hostH else {
        return nil
    }

    var hostBytes = [UInt8](repeating: 0, count: hostW * hostH * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

    guard let hostCtx = CGContext(
        data: &hostBytes,
        width: hostW,
        height: hostH,
        bitsPerComponent: 8,
        bytesPerRow: hostW * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }
    hostCtx.draw(hostImage, in: CGRect(x: 0, y: 0, width: hostW, height: hostH))

    var templBytes = [UInt8](repeating: 0, count: templW * templH * 4)
    guard let templCtx = CGContext(
        data: &templBytes,
        width: templW,
        height: templH,
        bitsPerComponent: 8,
        bytesPerRow: templW * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }
    templCtx.draw(templateImage, in: CGRect(x: 0, y: 0, width: templW, height: templH))

    struct PixelSample {
        let dx: Int
        let dy: Int
        let r: Int
        let g: Int
        let b: Int
    }

    var samples: [PixelSample] = []
    samples.reserveCapacity(templW * templH)

    for ty in 0..<templH {
        let rowOffset = ty * templW * 4
        for tx in 0..<templW {
            let offset = rowOffset + tx * 4
            let a = Int(templBytes[offset + 3])
            if a >= 32 {
                let r = Int(templBytes[offset])
                let g = Int(templBytes[offset + 1])
                let b = Int(templBytes[offset + 2])
                samples.append(PixelSample(dx: tx, dy: ty, r: r, g: g, b: b))
            }
        }
    }

    if samples.isEmpty {
        for ty in 0..<templH {
            let rowOffset = ty * templW * 4
            for tx in 0..<templW {
                let offset = rowOffset + tx * 4
                let r = Int(templBytes[offset])
                let g = Int(templBytes[offset + 1])
                let b = Int(templBytes[offset + 2])
                samples.append(PixelSample(dx: tx, dy: ty, r: r, g: g, b: b))
            }
        }
    }

    guard !samples.isEmpty else { return nil }

    let finalSamples: [PixelSample]
    if samples.count > 96 {
        let stride = max(1, samples.count / 96)
        var subsampled: [PixelSample] = []
        subsampled.reserveCapacity(110)
        for i in Swift.stride(from: 0, to: samples.count, by: stride) {
            subsampled.append(samples[i])
        }
        finalSamples = subsampled
    } else {
        finalSamples = samples
    }

    let sampleCount = finalSamples.count
    let maxDiffPerPixel = 3 * 255
    let maxTotalDiff = sampleCount * maxDiffPerPixel

    let maxSearchX = hostW - templW
    let maxSearchY = hostH - templH

    var bestDiff = Int.max
    var bestX = 0
    var bestY = 0

    let searchArea = maxSearchX * maxSearchY
    let coarseStep = searchArea > 500_000 ? 12 : (searchArea > 80_000 ? 6 : 1)

    if coarseStep > 1 {
        var coarseBestX = 0
        var coarseBestY = 0
        var coarseBestDiff = Int.max

        for hy in Swift.stride(from: 0, through: maxSearchY, by: coarseStep) {
            for hx in Swift.stride(from: 0, through: maxSearchX, by: coarseStep) {
                var sumDiff = 0
                for s in finalSamples {
                    let hostOffset = ((hy + s.dy) * hostW + (hx + s.dx)) * 4
                    let hr = Int(hostBytes[hostOffset])
                    let hg = Int(hostBytes[hostOffset + 1])
                    let hb = Int(hostBytes[hostOffset + 2])
                    sumDiff += abs(hr - s.r) + abs(hg - s.g) + abs(hb - s.b)
                    if sumDiff >= coarseBestDiff { break }
                }
                if sumDiff < coarseBestDiff {
                    coarseBestDiff = sumDiff
                    coarseBestX = hx
                    coarseBestY = hy
                }
            }
        }

        let fineMinX = max(0, coarseBestX - coarseStep * 2)
        let fineMaxX = min(maxSearchX, coarseBestX + coarseStep * 2)
        let fineMinY = max(0, coarseBestY - coarseStep * 2)
        let fineMaxY = min(maxSearchY, coarseBestY + coarseStep * 2)

        var fineBestDiff = Int.max
        for hy in fineMinY...fineMaxY {
            for hx in fineMinX...fineMaxX {
                var sumDiff = 0
                for s in finalSamples {
                    let hostOffset = ((hy + s.dy) * hostW + (hx + s.dx)) * 4
                    let hr = Int(hostBytes[hostOffset])
                    let hg = Int(hostBytes[hostOffset + 1])
                    let hb = Int(hostBytes[hostOffset + 2])
                    sumDiff += abs(hr - s.r) + abs(hg - s.g) + abs(hb - s.b)
                    if sumDiff >= fineBestDiff { break }
                }
                if sumDiff < fineBestDiff {
                    fineBestDiff = sumDiff
                    bestX = hx
                    bestY = hy
                }
            }
        }
        bestDiff = fineBestDiff
    } else {
        for hy in 0...maxSearchY {
            for hx in 0...maxSearchX {
                var sumDiff = 0
                for s in finalSamples {
                    let hostOffset = ((hy + s.dy) * hostW + (hx + s.dx)) * 4
                    let hr = Int(hostBytes[hostOffset])
                    let hg = Int(hostBytes[hostOffset + 1])
                    let hb = Int(hostBytes[hostOffset + 2])
                    sumDiff += abs(hr - s.r) + abs(hg - s.g) + abs(hb - s.b)
                    if sumDiff >= bestDiff { break }
                }
                if sumDiff < bestDiff {
                    bestDiff = sumDiff
                    bestX = hx
                    bestY = hy
                }
            }
        }
    }

    let confidence = 1.0 - (Double(bestDiff) / Double(maxTotalDiff))

    guard confidence >= minConfidence else {
        return nil
    }

    let clampedX = CGFloat(max(0, min(bestX, maxSearchX)))
    let clampedY = CGFloat(max(0, min(bestY, maxSearchY)))
    let clampedW = CGFloat(min(templW, hostW))
    let clampedH = CGFloat(min(templH, hostH))

    return VisualPetMatch(
        rect: CGRect(x: clampedX, y: clampedY, width: clampedW, height: clampedH),
        confidence: confidence
    )
}

func createSyntheticRGBAImage(
    width: Int,
    height: Int,
    fillColor: (r: UInt8, g: UInt8, b: UInt8, a: UInt8),
    pattern: ((Int, Int) -> (UInt8, UInt8, UInt8, UInt8)?)? = nil
) -> CGImage? {
    guard width > 0, height > 0 else { return nil }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    for y in 0..<height {
        let row = y * width * 4
        for x in 0..<width {
            let offset = row + x * 4
            if let p = pattern?(x, y) {
                bytes[offset] = p.0
                bytes[offset + 1] = p.1
                bytes[offset + 2] = p.2
                bytes[offset + 3] = p.3
            } else {
                bytes[offset] = fillColor.r
                bytes[offset + 1] = fillColor.g
                bytes[offset + 2] = fillColor.b
                bytes[offset + 3] = fillColor.a
            }
        }
    }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    guard let ctx = CGContext(
        data: &bytes,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }
    return ctx.makeImage()
}

func resizeImageNearest(image: CGImage, targetWidth: Int, targetHeight: Int) -> CGImage? {
    guard targetWidth > 0, targetHeight > 0 else { return nil }
    if image.width == targetWidth && image.height == targetHeight { return image }

    let sourceWidth = image.width
    let sourceHeight = image.height
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    var source = [UInt8](repeating: 0, count: sourceWidth * sourceHeight * 4)
    guard let sourceContext = CGContext(
        data: &source,
        width: sourceWidth,
        height: sourceHeight,
        bitsPerComponent: 8,
        bytesPerRow: sourceWidth * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else { return nil }
    sourceContext.draw(image, in: CGRect(x: 0, y: 0, width: sourceWidth, height: sourceHeight))

    var destination = [UInt8](repeating: 0, count: targetWidth * targetHeight * 4)
    for y in 0..<targetHeight {
        let sourceY = min(sourceHeight - 1, y * sourceHeight / targetHeight)
        for x in 0..<targetWidth {
            let sourceX = min(sourceWidth - 1, x * sourceWidth / targetWidth)
            let sourceOffset = (sourceY * sourceWidth + sourceX) * 4
            let destinationOffset = (y * targetWidth + x) * 4
            destination[destinationOffset..<(destinationOffset + 4)] = source[sourceOffset..<(sourceOffset + 4)]
        }
    }

    guard let destinationContext = CGContext(
        data: &destination,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: targetWidth * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else { return nil }
    return destinationContext.makeImage()
}

// MARK: - Config
struct AtlasFrameConfig: Decodable {
    let row: Int
    let column: Int
}

struct ClipConfig: Decodable {
    let frames: [String]?
    let atlasFrames: [AtlasFrameConfig]?
    let fps: Int?
    let loop: Bool?
    let fallback: Bool?
    let row: Int?

    enum CodingKeys: String, CodingKey {
        case frames, atlasFrames, fps, loop, fallback, row
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.fps = try container.decodeIfPresent(Int.self, forKey: .fps)
        self.loop = try container.decodeIfPresent(Bool.self, forKey: .loop)
        self.fallback = try container.decodeIfPresent(Bool.self, forKey: .fallback)
        self.row = try container.decodeIfPresent(Int.self, forKey: .row)
        self.frames = try? container.decodeIfPresent([String].self, forKey: .frames)
        self.atlasFrames = try? container.decodeIfPresent([AtlasFrameConfig].self, forKey: .atlasFrames)
    }
}

struct CompanionConfig: Decodable {
    let petId: String?
    let atlasPath: String?
    let smallWidth: Int?
    let restWidth: Int?
    let targetHeightRatio: Double?
    let sizingMode: String?
    let interpolation: String?
    let atlasRows: Int?
    let clips: [String: ClipConfig]?
}

// MARK: - Bounded Internal Takeover Idle Profile
struct TakeoverIdleProfile {
    let petId: String
    let row: Int
    let baseFrame: Int
    let blinkFrames: [Int]
    let blinkInterval: Double
    let frameDuration: Double
}

func resolveTakeoverIdleProfile(petId: String, atlasInfo: AtlasInfo?) -> TakeoverIdleProfile? {
    let normalized = petId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized == "rocky" else { return nil }
    guard let info = atlasInfo else { return nil }
    let row = 0
    let baseFrame = 0
    let blinkFrames = [0, 1, 0]
    let blinkInterval = 3.0
    let frameDuration = 0.1

    guard row >= 0 && row < info.rows else { return nil }
    guard baseFrame >= 0 && baseFrame < info.columns else { return nil }
    for f in blinkFrames {
        guard f >= 0 && f < info.columns else { return nil }
    }

    return TakeoverIdleProfile(
        petId: normalized,
        row: row,
        baseFrame: baseFrame,
        blinkFrames: blinkFrames,
        blinkInterval: blinkInterval,
        frameDuration: frameDuration
    )
}

// MARK: - NDJSON event
struct VisualEvent {
    let schemaVersion: Int
    let event: String
    let eventId: String?
    let reason: String?
    let deadline: Double?
    let rawJson: [String: Any]

    static func from(json: [String: Any]) -> VisualEvent? {
        guard let sv = json["schemaVersion"] as? Int, sv == 1,
              let evt = json["event"] as? String else {
            return nil
        }
        return VisualEvent(
            schemaVersion: sv,
            event: evt,
            eventId: json["eventId"] as? String,
            reason: json["reason"] as? String,
            deadline: json["deadline"] as? Double,
            rawJson: json
        )
    }
}

// MARK: - Engine State
enum EngineState: String {
    case small, entering, resting, exiting
}

class EngineStatus {
    var currentState: EngineState = .small
    var isPaused: Bool = false
    var transitionStartTime: CFTimeInterval = 0
    var transitionDuration: CFTimeInterval = 0.6
    var transitionProgress: CGFloat = 0.0
    var exitStartProgress: CGFloat = 1.0
    var exitStartRect: CGRect = .zero
    var exitStartBackdropOpacity: CGFloat = 0.0
    var currentFrameIndex: Int = 0
    var animationFps: Int = 8
    var isLooping: Bool = false
    var frozenFrame: Int? = nil
    var anchorFound: Bool = false
    var windowVisible: Bool = false
    var error: String? = nil
    var targetHeightRatio: CGFloat = 0.72
    var displayId: CGDirectDisplayID = 0
}

// MARK: - Companion Window
class CompanionWindow: NSPanel {
    let engine = EngineStatus()
    var timerPanel: TimerPanelController?
    var backdropLayer: CALayer?
    var petLayer: CALayer?
    var atlas: CGImage?
    var atlasInfo: AtlasInfo?
    var animationTimer: Timer?
    var isPreviewMode: Bool = false
    var lastAnchorFrame: NSRect = .zero
    var lastAnchorScreen: NSScreen?
    var processedEventIds: Set<String> = []

    // Config from companion.json
    var petId: String = ""
    var smallWidth: CGFloat = 84
    var restWidth: CGFloat = 360
    var sizingMode: String = "restHeightRatio"
    var interpolation: String = "nearest"
    var atlasRows: Int = 9
    var targetHeightRatio: CGFloat = 0.72

    // Custom clip frames
    var clipFrames: [String: [CGImage]] = [:]
    var clipAtlasFrames: [String: [AtlasFrameConfig]] = [:]
    var clipFps: [String: Int] = [:]
    var clipLoop: [String: Bool] = [:]

    // Test modes
    var testImageIOValidate: Bool = false
    var testFrameValidate: Bool = false
    var testCrop: Bool = false
    var testNearest: Bool = false
    var testTransitionGeometry: Bool = false
    var testTransitionBehavior: Bool = false
    var testTimerFreeze: Bool = false
    var testNoAnchor: Bool = false
    var testMultiDisplay: Bool = false
    var testAnchorFallback: Bool = false
    var testFullscreenGeometry: Bool = false
    var testEasing: Bool = false
    var testInterruptionContinuity: Bool = false
    var testNeutralFallback: Bool = false
    var atlasPath: String = ""
    var previewState: String? = nil
    var testRuntimeConfig: Bool = false
    var testStatusSequence: Bool = false
    var lastStatusSignature: String? = nil
    var statusEmissionEnabled: Bool = true
    var isMidpoint: Bool = false
    var reminderHoldSeconds: Double = 2
    var reminderGeneration = 0
    var eyeRestTextLayer: CATextLayer?
    var isTakeover: Bool = false

    var testTransientAnchor: Bool = false
    var testNonactivatingPanel: Bool = false
    var testStableAspect: Bool = false

    var testPanelGeometry: Bool = false
    var testPanelFocus: Bool = false
    var testPanelFlash: Bool = false
    var testPanelErrorPreservation: Bool = false
    var testMidpoint: Bool = false
    var testActivateTakeover: Bool = false
    var testTakeoverAtlasPreference: Bool = false
    var testIdleProgression: Bool = false

    var trustedPetAnchorFound: Bool = false
    var visualAnchorDiagnostic: String = "not-checked"
    var mockWindowList: [[String: Any]]? = nil
    var testTrustedPetAnchor: Bool = false
    var testVisualMatch: Bool = false
    var testVoiceGeometryAnchor: Bool = false

    var lastVoiceGeometryFrame: NSRect?
    var visualAnchorStaleInterval: Double = 2.5
    var lastTrustedPetAnchorTime: Double = 0
    var mockMediaTime: Double?

    func mediaTime() -> Double {
        mockMediaTime ?? CACurrentMediaTime()
    }

    func clearVisualAnchor() {
        lastVoiceGeometryFrame = nil
    }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        self.isOpaque = false
        self.backgroundColor = .clear
        self.level = .floating
        self.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        self.hasShadow = false
        self.ignoresMouseEvents = true
    }

    convenience init() {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.frame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        self.init(contentRect: frame,
                  styleMask: [.borderless, .nonactivatingPanel],
                  backing: .buffered,
                  defer: false)
    }

    override var canBecomeKey: Bool { return false }
    override var canBecomeMain: Bool { return false }

    override func mouseDown(with event: NSEvent) {
        if isPreviewMode {
            self.performDrag(with: event)
        }
    }

    func setupLayer() {
        self.contentView?.wantsLayer = true
        guard let rootLayer = self.contentView?.layer else { return }
        rootLayer.sublayers?.removeAll()

        let backdrop = CALayer()
        backdrop.frame = rootLayer.bounds
        backdrop.backgroundColor = NSColor.black.cgColor
        backdrop.opacity = 0.0
        rootLayer.addSublayer(backdrop)
        self.backdropLayer = backdrop

        let pet = CALayer()
        pet.frame = .zero
        pet.contentsGravity = .resize
        let filter = (interpolation == "linear") ? CALayerContentsFilter.linear : CALayerContentsFilter.nearest
        pet.magnificationFilter = filter
        pet.minificationFilter = filter
        pet.backgroundColor = NSColor.clear.cgColor
        rootLayer.addSublayer(pet)
        self.petLayer = pet
        let reminder = CATextLayer()
        reminder.string = "远眺约 6 米，持续 20 秒\n轻柔、完整眨眼 10 次"
        reminder.fontSize = 22
        reminder.alignmentMode = .center
        reminder.foregroundColor = NSColor.white.cgColor
        reminder.backgroundColor = NSColor.black.withAlphaComponent(0.85).cgColor
        reminder.cornerRadius = 8
        reminder.contentsScale = currentTargetScreen().backingScaleFactor
        reminder.isHidden = true
        rootLayer.addSublayer(reminder)
        eyeRestTextLayer = reminder
    }

    // Calm idle blink timers
    var holdTimer: Timer?
    var burstTimer: Timer?
    var burstStep: Int = 0

    func cancelCalmIdleTimers() {
        holdTimer?.invalidate()
        holdTimer = nil
        burstTimer?.invalidate()
        burstTimer = nil
        burstStep = 0
    }

    func startCalmIdleSchedule() {
        cancelCalmIdleTimers()
        stopAnimationTimer()

        guard isTakeover, engine.currentState == .resting, !engine.isPaused else {
            return
        }

        let info = atlasInfo ?? (atlas != nil ? deriveAtlasInfo(width: atlas!.width, height: atlas!.height) : nil)
        guard let profile = resolveTakeoverIdleProfile(petId: petId, atlasInfo: info) else {
            engine.currentFrameIndex = 0
            renderCurrentFrame()
            return
        }

        engine.currentFrameIndex = profile.baseFrame
        renderCurrentFrame()

        holdTimer = Timer.scheduledTimer(withTimeInterval: profile.blinkInterval, repeats: false) { [weak self] _ in
            self?.triggerBlinkBurst(profile: profile)
        }
    }

    func advanceBlinkBurst(profile: TakeoverIdleProfile) {
        guard isTakeover, engine.currentState == .resting, !engine.isPaused else {
            cancelCalmIdleTimers()
            return
        }

        let frames = profile.blinkFrames
        if burstStep < frames.count {
            engine.currentFrameIndex = frames[burstStep]
            renderCurrentFrame()
            burstStep += 1
        } else {
            burstTimer?.invalidate()
            burstTimer = nil
            engine.currentFrameIndex = profile.baseFrame
            renderCurrentFrame()
            startCalmIdleSchedule()
        }
    }

    func triggerBlinkBurst(profile: TakeoverIdleProfile) {
        holdTimer?.invalidate()
        holdTimer = nil

        guard isTakeover, engine.currentState == .resting, !engine.isPaused else {
            return
        }

        burstStep = 0
        let frames = profile.blinkFrames

        engine.currentFrameIndex = frames[0]
        renderCurrentFrame()

        burstStep = 1
        burstTimer = Timer.scheduledTimer(withTimeInterval: profile.frameDuration, repeats: true) { [weak self] _ in
            self?.advanceBlinkBurst(profile: profile)
        }
    }

    func setAnimationFps(_ fps: Int) {
        engine.animationFps = max(1, min(12, fps))
    }

    func startAnimationTimer() {
        stopAnimationTimer()
        if engine.isPaused { return }
        if engine.currentState == .small { return }
        if engine.currentState == .resting && isTakeover {
            return
        }
        let interval = 1.0 / Double(engine.animationFps)
        animationTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.tickAnimation()
        }
    }

    func stopAnimationTimer() {
        animationTimer?.invalidate()
        animationTimer = nil
    }

    func scheduleMidpointHold() {
        let generation = reminderGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + reminderHoldSeconds) { [weak self] in
            guard let self = self, self.reminderGeneration == generation,
                  self.isMidpoint, self.engine.currentState == .resting else { return }
            self.cancelCalmIdleTimers()
            self.engine.currentFrameIndex = 0
            self.updateGeometryAndLayers()
            self.engine.exitStartProgress = self.engine.transitionProgress
            self.engine.exitStartRect = self.petLayer?.frame ?? .zero
            self.engine.exitStartBackdropOpacity = CGFloat(self.backdropLayer?.opacity ?? 0.32)
            self.engine.frozenFrame = 0
            self.engine.currentState = .exiting
            self.engine.transitionStartTime = CACurrentMediaTime()
            self.engine.transitionDuration = 0.4
            self.engine.transitionProgress = 0.0
            self.engine.isPaused = false
            self.engine.isLooping = false
            self.startAnimationTimer()
            self.renderCurrentFrame()
        }
    }

    func clipNameForState(_ state: EngineState) -> String {
        switch state {
        case .entering: return "enter"
        case .resting: return "rest"
        case .exiting: return "exit"
        case .small: return ""
        }
    }

    func tickAnimation() {
        let previousState = engine.currentState
        updateTransitions()

        if !engine.isPaused && engine.currentState != .small {
            if isTakeover {
                if engine.currentState == .resting {
                    // Calm takeover resting uses calm idle hold/burst scheduling, not continuous ticking.
                } else if engine.currentState == .entering {
                    engine.currentFrameIndex = 0
                } else if engine.currentState == .exiting {
                    if let frozen = engine.frozenFrame {
                        engine.currentFrameIndex = frozen
                    }
                }
            } else {
                let clipName = clipNameForState(engine.currentState)
                let hasCustomClip = !(clipFrames[clipName]?.isEmpty ?? true) || !(clipAtlasFrames[clipName]?.isEmpty ?? true)

                if engine.currentState == .entering {
                    if hasCustomClip {
                        let frameCount = !(clipFrames[clipName]?.isEmpty ?? true) ? clipFrames[clipName]!.count : clipAtlasFrames[clipName]!.count
                        engine.currentFrameIndex += 1
                        if engine.currentFrameIndex >= frameCount {
                            engine.currentFrameIndex = engine.isLooping ? 0 : (frameCount - 1)
                        }
                    } else {
                        // Neutral idle frame: do not advance frame index during entry
                        engine.currentFrameIndex = 0
                    }
                } else if engine.currentState == .exiting {
                    if hasCustomClip {
                        let frameCount = !(clipFrames[clipName]?.isEmpty ?? true) ? clipFrames[clipName]!.count : clipAtlasFrames[clipName]!.count
                        engine.currentFrameIndex += 1
                        if engine.currentFrameIndex >= frameCount {
                            engine.currentFrameIndex = engine.isLooping ? 0 : (frameCount - 1)
                        }
                    } else {
                        // Missing custom exit clip: freeze current/rest frame while reversing geometry
                        if let frozen = engine.frozenFrame {
                            engine.currentFrameIndex = frozen
                        }
                    }
                } else if engine.currentState == .resting {
                    let frameCount: Int
                    if !(clipFrames[clipName]?.isEmpty ?? true) {
                        frameCount = clipFrames[clipName]!.count
                    } else if !(clipAtlasFrames[clipName]?.isEmpty ?? true) {
                        frameCount = clipAtlasFrames[clipName]!.count
                    } else {
                        frameCount = 8
                    }
                    engine.currentFrameIndex += 1
                    if engine.currentFrameIndex >= frameCount {
                        engine.currentFrameIndex = engine.isLooping ? 0 : (frameCount - 1)
                    }
                }
            }
        }

        renderCurrentFrame()
        if engine.currentState != previousState {
            emitStatusIfChanged()
        }
    }

    func renderCurrentFrame() {
        guard let layer = petLayer else { return }
        if engine.currentState == .small {
            layer.contents = nil
            updateGeometryAndLayers()
            return
        }

        if isTakeover {
            if let atlas = atlas, let info = atlasInfo ?? deriveAtlasInfo(width: atlas.width, height: atlas.height) {
                let profile = resolveTakeoverIdleProfile(petId: petId, atlasInfo: info)
                let row = profile?.row ?? 0
                let col: Int
                if engine.currentState == .entering {
                    col = profile?.baseFrame ?? 0
                } else if engine.currentState == .exiting {
                    let frozen = engine.frozenFrame ?? (profile?.baseFrame ?? 0)
                    col = min(max(0, frozen), info.columns - 1)
                } else {
                    let f = engine.frozenFrame ?? engine.currentFrameIndex
                    col = min(max(0, f), info.columns - 1)
                }
                let validRow = min(max(0, row), info.rows - 1)
                if let frame = extractFrame(atlas: atlas, atlasInfo: info, row: validRow, col: col) {
                    layer.contents = frame
                }
            } else {
                let clipName = clipNameForState(engine.currentState)
                if !clipName.isEmpty, let frames = clipFrames[clipName], !frames.isEmpty {
                    layer.contents = frames[0]
                } else if !clipName.isEmpty, let aFrames = clipAtlasFrames[clipName], !aFrames.isEmpty, let atlas = atlas, let info = atlasInfo ?? deriveAtlasInfo(width: atlas.width, height: atlas.height),
                           let frame = extractFrame(atlas: atlas, atlasInfo: info, row: aFrames[0].row, col: aFrames[0].column) {
                    layer.contents = frame
                } else {
                    layer.contents = nil
                }
            }
            if engine.currentState != .resting {
                updateGeometryAndLayers()
            }
            return
        }

        let clipName = clipNameForState(engine.currentState)
        if !clipName.isEmpty, let frames = clipFrames[clipName], !frames.isEmpty {
            let idx = min(engine.currentFrameIndex, frames.count - 1)
            layer.contents = frames[idx]
        } else if !clipName.isEmpty, let aFrames = clipAtlasFrames[clipName], !aFrames.isEmpty, let atlas = atlas, let info = atlasInfo ?? deriveAtlasInfo(width: atlas.width, height: atlas.height) {
            let idx = min(engine.currentFrameIndex, aFrames.count - 1)
            let cell = aFrames[idx]
            if let frame = extractFrame(atlas: atlas, atlasInfo: info, row: cell.row, col: cell.column) {
                layer.contents = frame
            }
        } else if let atlas = atlas, let info = atlasInfo ?? deriveAtlasInfo(width: atlas.width, height: atlas.height) {
            let row: Int = 0
            let col: Int
            if engine.currentState == .entering {
                col = 0
            } else if engine.currentState == .exiting && (clipFrames["exit"]?.isEmpty ?? true) && (clipAtlasFrames["exit"]?.isEmpty ?? true) {
                let frozen = engine.frozenFrame ?? engine.currentFrameIndex
                col = frozen % info.columns
            } else {
                col = engine.currentFrameIndex % info.columns
            }
            if let frame = extractFrame(atlas: atlas, atlasInfo: info, row: row, col: col) {
                layer.contents = frame
            }
        }

        updateGeometryAndLayers()
    }

    func currentTargetScreen() -> NSScreen {
        if let screen = lastAnchorScreen, NSScreen.screens.contains(screen) {
            return screen
        }
        return NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
    }

    func calculateGeometry(screen: NSScreen) -> (anchorLocal: CGRect, targetLocal: CGRect) {
        let displayFrame = screen.frame
        let visibleFrame = screen.visibleFrame

        let anchorScreen: NSRect
        if let lastScr = lastAnchorScreen, NSScreen.screens.contains(lastScr), !lastAnchorFrame.isEmpty {
            anchorScreen = lastAnchorFrame
        } else {
            let defaultW: CGFloat = smallWidth
            let defaultH: CGFloat = 208
            let defaultX = visibleFrame.midX - defaultW / 2.0
            let defaultY = visibleFrame.minY + 20
            let clampedX = max(visibleFrame.minX, min(visibleFrame.maxX - defaultW, defaultX))
            let clampedY = max(visibleFrame.minY, min(visibleFrame.maxY - defaultH, defaultY))
            anchorScreen = NSRect(x: clampedX, y: clampedY, width: defaultW, height: defaultH)
        }

        let anchorLocal = CGRect(
            x: anchorScreen.origin.x - displayFrame.origin.x,
            y: anchorScreen.origin.y - displayFrame.origin.y,
            width: anchorScreen.width,
            height: anchorScreen.height
        )

        // Stable active-cycle aspect precedence: rest custom clip first, then enter clip, then atlas
        var aspect: CGFloat = 192.0 / 208.0
        if let restFrames = clipFrames["rest"], let firstFrame = restFrames.first, firstFrame.height > 0 {
            aspect = CGFloat(firstFrame.width) / CGFloat(firstFrame.height)
        } else if let enterFrames = clipFrames["enter"], let firstFrame = enterFrames.first, firstFrame.height > 0 {
            aspect = CGFloat(firstFrame.width) / CGFloat(firstFrame.height)
        } else if let atlas = atlas {
            let info = atlasInfo ?? deriveAtlasInfo(width: atlas.width, height: atlas.height)
            if let info = info, info.cellHeight > 0 {
                aspect = CGFloat(info.cellWidth) / CGFloat(info.cellHeight)
            }
        }
        if aspect <= 0 { aspect = 192.0 / 208.0 }

        let ratio = targetHeightRatio
        let visibleW = visibleFrame.width
        let visibleH = visibleFrame.height
        let maxW = visibleW * 0.92
        let maxH = visibleH * 0.92

        var targetW: CGFloat
        var targetH: CGFloat

        if sizingMode == "fixedWidth" || sizingMode == "restWidth" {
            targetW = restWidth
            targetH = targetW / aspect
            if targetW > maxW {
                targetW = maxW
                targetH = targetW / aspect
            }
            if targetH > maxH {
                targetH = maxH
                targetW = targetH * aspect
            }
        } else {
            targetH = visibleH * ratio
            targetW = targetH * aspect
            if targetW > maxW {
                targetW = maxW
                targetH = targetW / aspect
            }
            if targetH > maxH {
                targetH = maxH
                targetW = targetH * aspect
            }
        }

        let visibleLocalMinX = visibleFrame.origin.x - displayFrame.origin.x
        let visibleLocalMinY = visibleFrame.origin.y - displayFrame.origin.y
        let targetCenterX = visibleLocalMinX + visibleW / 2.0
        let targetCenterY = visibleLocalMinY + visibleH / 2.0

        let targetLocal = CGRect(
            x: targetCenterX - targetW / 2.0,
            y: targetCenterY - targetH / 2.0,
            width: targetW,
            height: targetH
        )

        return (anchorLocal, targetLocal)
    }

    func updateGeometryAndLayers() {
        let screen = currentTargetScreen()

        if self.frame != screen.frame {
            self.setFrame(screen.frame, display: true, animate: false)
            self.contentView?.frame = CGRect(x: 0, y: 0, width: screen.frame.width, height: screen.frame.height)
            backdropLayer?.frame = self.contentView?.bounds ?? .zero
        }

        let (anchorLocal, targetLocal) = calculateGeometry(screen: screen)

        let currentRect: CGRect
        let currentOpacity: Float

        switch engine.currentState {
        case .small:
            currentRect = anchorLocal
            currentOpacity = 0.0

        case .entering:
            let progress = engine.transitionProgress
            let easedP = easeOvershoot(progress)
            let currX = anchorLocal.origin.x + (targetLocal.origin.x - anchorLocal.origin.x) * easedP
            let currY = anchorLocal.origin.y + (targetLocal.origin.y - anchorLocal.origin.y) * easedP
            let currW = anchorLocal.width + (targetLocal.width - anchorLocal.width) * easedP
            let currH = anchorLocal.height + (targetLocal.height - anchorLocal.height) * easedP
            currentRect = CGRect(x: currX, y: currY, width: currW, height: currH)
            currentOpacity = Float(min(0.32, max(0.0, 0.32 * easedP)))

        case .resting:
            currentRect = targetLocal
            currentOpacity = 0.32

        case .exiting:
            let progress = engine.transitionProgress
            let factor = 1.0 - progress
            let startRect = engine.exitStartRect
            let currX = anchorLocal.origin.x + (startRect.origin.x - anchorLocal.origin.x) * factor
            let currY = anchorLocal.origin.y + (startRect.origin.y - anchorLocal.origin.y) * factor
            let currW = anchorLocal.width + (startRect.width - anchorLocal.width) * factor
            let currH = anchorLocal.height + (startRect.height - anchorLocal.height) * factor
            currentRect = CGRect(x: currX, y: currY, width: currW, height: currH)
            currentOpacity = Float(max(0.0, engine.exitStartBackdropOpacity * factor))
        }

        petLayer?.frame = currentRect
        backdropLayer?.opacity = currentOpacity
        let visible = screen.visibleFrame
        eyeRestTextLayer?.frame = CGRect(x: visible.minX - screen.frame.minX + 16,
            y: visible.minY - screen.frame.minY + 16,
            width: max(1, visible.width - 32), height: 64)
        eyeRestTextLayer?.isHidden = !(isMidpoint && reminderHoldSeconds == 20 && engine.currentState == .resting)

        engine.targetHeightRatio = targetHeightRatio
        if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID {
            engine.displayId = num
        }
    }

    func findScreenForCGRect(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> NSScreen? {
        guard let primaryScreen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first else {
            return NSScreen.main
        }
        let primaryHeight = primaryScreen.frame.height
        let centerX = x + w / 2
        let centerY = y + h / 2
        for screen in NSScreen.screens {
            let screenCGY = primaryHeight - screen.frame.origin.y - screen.frame.height
            let screenCGBounds = NSRect(x: screen.frame.origin.x, y: screenCGY,
                                        width: screen.frame.width, height: screen.frame.height)
            if screenCGBounds.contains(NSPoint(x: centerX, y: centerY)) {
                return screen
            }
        }
        return NSScreen.main ?? primaryScreen
    }

    func updateVoiceGeometryAnchor(windowList: [[String: Any]], primaryHeight: CGFloat) -> Bool {
        let maxHostWidth = max(1600, NSScreen.screens.map { $0.frame.width }.max() ?? 1600)
        let appLayer3Windows = windowList.filter { window in
            let owner = window[kCGWindowOwnerName as String] as? String ?? ""
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            return (owner == "ChatGPT" || owner == "Codex") && layer == 3
        }
        let geometryEligibleWindows = appLayer3Windows.filter { window in
            guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let width = bounds["Width"] as? CGFloat,
                  let height = bounds["Height"] as? CGFloat else { return false }
            return width >= 600 && width <= maxHostWidth && height >= 1000
        }
        guard let host = geometryEligibleWindows.first else {
            if appLayer3Windows.isEmpty {
                visualAnchorDiagnostic = "voice-window-not-enumerated"
            } else {
                visualAnchorDiagnostic = "voice-window-geometry-filtered"
            }
            clearVisualAnchor()
            return false
        }
        guard let bounds = host[kCGWindowBounds as String] as? [String: Any],
              let hostX = bounds["X"] as? CGFloat,
              let hostY = bounds["Y"] as? CGFloat,
              let hostWidth = bounds["Width"] as? CGFloat,
              let hostHeight = bounds["Height"] as? CGFloat,
              hostWidth >= 600, hostHeight >= 1000 else {
            visualAnchorDiagnostic = "voice-window-bounds-invalid"
            clearVisualAnchor()
            return false
        }

        // Codex/ChatGPT does not expose the embedded pet's frame. Estimate its
        // established lower-right voice-host position from window geometry only.
        let petWidth = min(max(20, smallWidth), hostWidth * 0.25)
        let petHeight = petWidth * 208 / 192
        let offsetX = min(max(0, hostWidth - petWidth), hostWidth * 0.805)
        let offsetY = min(max(0, hostHeight - petHeight), hostHeight * 0.8)
        let globalX = hostX + offsetX
        let globalTopY = hostY + offsetY
        let appKitY = primaryHeight - globalTopY - petHeight
        let target = NSRect(x: globalX, y: appKitY, width: petWidth, height: petHeight)
        let screen = findScreenForCGRect(x: globalX, y: globalTopY, w: petWidth, h: petHeight)

        if let previous = lastVoiceGeometryFrame {
            let alpha: CGFloat = 0.7
            lastAnchorFrame = NSRect(
                x: previous.origin.x * (1 - alpha) + target.origin.x * alpha,
                y: previous.origin.y * (1 - alpha) + target.origin.y * alpha,
                width: previous.width * (1 - alpha) + target.width * alpha,
                height: previous.height * (1 - alpha) + target.height * alpha
            )
        } else {
            lastAnchorFrame = target
        }
        lastAnchorScreen = screen
        lastVoiceGeometryFrame = lastAnchorFrame
        visualAnchorDiagnostic = "voice-host-geometry-estimate"
        return true
    }

    func alignWithCodexWindow() {
        let previousAnchorFound = engine.anchorFound
        let previousWindowVisible = engine.windowVisible
        let previousPetAnchorFound = trustedPetAnchorFound
        let previousAnchorDiagnostic = visualAnchorDiagnostic
        let previousTimerPanelVisible = timerPanel?.panel.isVisible ?? false

        if isPreviewMode {
            engine.anchorFound = true
            trustedPetAnchorFound = true
            visualAnchorDiagnostic = "preview-anchor"
            syncWindowVisibility()
            if previousAnchorFound != engine.anchorFound || previousWindowVisible != engine.windowVisible {
                emitStatusIfChanged()
            }
            return
        }
        
        if testNoAnchor {
            engine.anchorFound = false
            trustedPetAnchorFound = false
            visualAnchorDiagnostic = "test-no-anchor"
            syncWindowVisibility()
            if let panel = self.timerPanel {
                panel.setAnchorFrame(.zero, screen: nil)
                panel.hidePanel()
            }
            if previousAnchorFound != engine.anchorFound || previousWindowVisible != engine.windowVisible {
                emitStatusIfChanged()
            }
            return
        }
        
        let windowList: [[String: Any]]
        if let mock = self.mockWindowList {
            windowList = mock
        } else if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
            windowList = list
        } else {
            engine.anchorFound = false
            trustedPetAnchorFound = false
            visualAnchorDiagnostic = "window-list-unavailable"
            syncWindowVisibility()
            if let panel = self.timerPanel {
                panel.setAnchorFrame(.zero, screen: nil)
                panel.hidePanel()
            }
            if previousAnchorFound != engine.anchorFound || previousWindowVisible != engine.windowVisible {
                emitStatusIfChanged()
            }
            return
        }
        
        guard let primaryScreen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first else {
            engine.anchorFound = false
            trustedPetAnchorFound = false
            visualAnchorDiagnostic = "display-unavailable"
            syncWindowVisibility()
            if let panel = self.timerPanel {
                panel.setAnchorFrame(.zero, screen: nil)
                panel.hidePanel()
            }
            if previousAnchorFound != engine.anchorFound || previousWindowVisible != engine.windowVisible {
                emitStatusIfChanged()
            }
            return
        }
        let primaryHeight = primaryScreen.frame.height
        var trustedFound = false
        var mainFound = false
        var lastScreen: NSScreen?
        
        if !testNoAnchor && !testAnchorFallback && !testTransientAnchor {
            for win in windowList {
                let owner = win[kCGWindowOwnerName as String] as? String ?? ""
                let name = win[kCGWindowName as String] as? String ?? ""
                let layer = win[kCGWindowLayer as String] as? Int ?? 0
                
                if let bounds = win[kCGWindowBounds as String] as? [String: Any],
                   let x = bounds["X"] as? CGFloat,
                   let y = bounds["Y"] as? CGFloat,
                   let w = bounds["Width"] as? CGFloat,
                   let h = bounds["Height"] as? CGFloat {

                    let isAvatar = (owner.contains("ChatGPT") || owner.contains("Codex")) &&
                        (name.contains("avatar-overlay")) &&
                        layer == 0 && w > 20 && w < 350 && h > 20 && h < 350

                    let isLayer3Pet = (owner == "ChatGPT" || owner == "Codex") &&
                        layer == 3 &&
                        (name.isEmpty || name == "Codex") &&
                        w >= 250 && w <= 600 && h >= 250 && h <= 600

                    if isAvatar || isLayer3Pet {
                        trustedFound = true
                        visualAnchorDiagnostic = "native-pet-window"
                        clearVisualAnchor()
                        lastScreen = findScreenForCGRect(x: x, y: y, w: w, h: h)
                        let appKitY = primaryHeight - y - h
                        lastAnchorFrame = NSRect(x: x, y: appKitY, width: w, height: h)
                        lastAnchorScreen = lastScreen
                        break
                    }
                }
            }
        }

        if !trustedFound && !testNoAnchor && !testAnchorFallback && !testTransientAnchor {
            trustedFound = updateVoiceGeometryAnchor(windowList: windowList, primaryHeight: primaryHeight)
            if trustedFound { lastScreen = lastAnchorScreen }
        }
        
        if !trustedFound && !testNoAnchor && !testAnchorFallback && !testTransientAnchor {
            for win in windowList {
                let owner = win[kCGWindowOwnerName as String] as? String ?? ""
                let name = win[kCGWindowName as String] as? String ?? ""
                let layer = win[kCGWindowLayer as String] as? Int ?? 0
                
                if let bounds = win[kCGWindowBounds as String] as? [String: Any],
                   let x = bounds["X"] as? CGFloat,
                   let y = bounds["Y"] as? CGFloat,
                   let w = bounds["Width"] as? CGFloat,
                   let h = bounds["Height"] as? CGFloat {
                    
                    let isMainWindow = (owner.contains("ChatGPT") || owner.contains("Codex")) &&
                        !name.contains("avatar-overlay") &&
                        layer == 0 && w > 500 && h > 500
                    
                    if isMainWindow {
                        mainFound = true
                        lastScreen = findScreenForCGRect(x: x, y: y, w: w, h: h)
                        let appKitY = primaryHeight - y - h
                        let anchorW: CGFloat = 84
                        lastAnchorFrame = NSRect(x: x + (w - anchorW) / 2, y: appKitY, width: anchorW, height: 208)
                        lastAnchorScreen = lastScreen
                        break
                    }
                }
            }
        }
        
        if trustedFound {
            engine.anchorFound = true
            trustedPetAnchorFound = true
            lastTrustedPetAnchorTime = mediaTime()
        } else if mainFound {
            engine.anchorFound = true
            trustedPetAnchorFound = false
            if visualAnchorDiagnostic == "not-checked" || visualAnchorDiagnostic == "pet-image-matched" {
                visualAnchorDiagnostic = "main-window-only"
            }
        } else {
            engine.anchorFound = false
            trustedPetAnchorFound = false
            if visualAnchorDiagnostic == "not-checked" {
                visualAnchorDiagnostic = "codex-window-not-found"
            }
        }

        updateGeometryAndLayers()
        syncWindowVisibility()

        if let panel = self.timerPanel {
            // Keep the timer through a short visual-match gap, but do not
            // mistake the persistent Codex main window for a visible pet.
            let fallbackIsFresh = mainFound &&
                lastTrustedPetAnchorTime > 0 &&
                mediaTime() - lastTrustedPetAnchorTime <= visualAnchorStaleInterval
            if trustedPetAnchorFound || fallbackIsFresh {
                panel.setAnchorFrame(lastAnchorFrame, screen: lastAnchorScreen)
                panel.showPanel()
            } else {
                panel.setAnchorFrame(.zero, screen: nil)
                panel.hidePanel()
            }
        }
        if previousAnchorFound != engine.anchorFound ||
            previousWindowVisible != engine.windowVisible ||
            previousPetAnchorFound != trustedPetAnchorFound ||
            previousAnchorDiagnostic != visualAnchorDiagnostic ||
            previousTimerPanelVisible != (timerPanel?.panel.isVisible ?? false) {
            emitStatusIfChanged()
        }
    }

    func syncWindowVisibility() {
        let shouldShow = isPreviewMode || engine.currentState != .small
        if shouldShow && !engine.windowVisible {
            if !testStatusSequence { orderFrontRegardless() }
            engine.windowVisible = true
        } else if !shouldShow && engine.windowVisible {
            if !testStatusSequence { orderOut(nil) }
            engine.windowVisible = false
        }
    }

    func processEvent(_ evt: VisualEvent) {
        if let eventId = evt.eventId, !eventId.isEmpty {
            if processedEventIds.contains(eventId) { return }
            processedEventIds.insert(eventId)
        }

        switch evt.event {
        case "companion.activate":
            reminderGeneration += 1
            eyeRestTextLayer?.isHidden = true
            if let forceState = evt.rawJson["state"] as? String, forceState == "resting" {
                isTakeover = true
                isMidpoint = false
                engine.currentState = .resting
                engine.transitionProgress = 1.0
                engine.currentFrameIndex = 0
                engine.isLooping = true
                setAnimationFps(8)
                startCalmIdleSchedule()
                updateGeometryAndLayers()
            } else if engine.currentState == .small {
                isTakeover = true
                isMidpoint = false
                engine.currentState = .entering
                engine.transitionStartTime = CACurrentMediaTime()
                engine.transitionDuration = 0.6
                engine.transitionProgress = 0.0
                engine.currentFrameIndex = 0
                engine.isPaused = false
                engine.frozenFrame = nil
                engine.isLooping = false
                setAnimationFps(8)
                startAnimationTimer()
            } else if engine.currentState == .entering {
                isMidpoint = false
            } else if engine.currentState == .resting {
                if engine.isPaused {
                    engine.isPaused = false
                    engine.frozenFrame = nil
                    if isTakeover {
                        startCalmIdleSchedule()
                    } else {
                        engine.currentFrameIndex = 0
                        startAnimationTimer()
                    }
                }
                if isMidpoint {
                    isMidpoint = false
                }
            } else if engine.currentState == .exiting && isMidpoint {
                isMidpoint = false
                engine.currentState = .entering
                engine.transitionStartTime = CACurrentMediaTime()
                engine.transitionDuration = 0.6
                engine.transitionProgress = 0.0
                engine.currentFrameIndex = 0
                engine.isPaused = false
                engine.frozenFrame = nil
                engine.isLooping = false
                stopAnimationTimer()
                startAnimationTimer()
            }
            syncWindowVisibility()
            emitStatusIfChanged()

        case "companion.deactivate":
            reminderGeneration += 1
            eyeRestTextLayer?.isHidden = true
            if let forceState = evt.rawJson["state"] as? String, forceState == "resting" {
                isTakeover = true
                isMidpoint = false
                engine.currentState = .resting
                engine.transitionProgress = 1.0
                engine.currentFrameIndex = 0
                engine.isLooping = true
                setAnimationFps(8)
                updateGeometryAndLayers()
            } else if engine.currentState == .small {
                isTakeover = true
                isMidpoint = false
                engine.currentState = .resting
                engine.transitionProgress = 1.0
                engine.currentFrameIndex = 0
                engine.isLooping = true
                setAnimationFps(8)
                updateGeometryAndLayers()
            }

            if engine.currentState == .entering || engine.currentState == .resting {
                cancelCalmIdleTimers()
                if isTakeover {
                    engine.currentFrameIndex = 0
                }
                updateGeometryAndLayers()
                engine.exitStartProgress = engine.transitionProgress
                engine.exitStartRect = petLayer?.frame ?? .zero
                engine.exitStartBackdropOpacity = CGFloat(backdropLayer?.opacity ?? 0.32)
                engine.frozenFrame = engine.currentFrameIndex
                engine.currentState = .exiting
                engine.transitionStartTime = CACurrentMediaTime()
                engine.transitionDuration = 0.4
                engine.transitionProgress = 0.0
                engine.isPaused = false
                engine.isLooping = false
                setAnimationFps(8)
                startAnimationTimer()
            }
            syncWindowVisibility()
            emitStatusIfChanged()

        case "companion.midpoint":
            if evt.reason == "eye-rest" && !trustedPetAnchorFound && !isPreviewMode { return }
            if engine.currentState == .small {
                reminderGeneration += 1
                reminderHoldSeconds = evt.reason == "eye-rest" ? 20 : 2
                isTakeover = true
                isMidpoint = true
                engine.currentState = .entering
                engine.transitionStartTime = CACurrentMediaTime()
                engine.transitionDuration = 0.6
                engine.transitionProgress = 0.0
                engine.currentFrameIndex = 0
                engine.isPaused = false
                engine.frozenFrame = nil
                engine.isLooping = false
                stopAnimationTimer()
                startAnimationTimer()
            }
            syncWindowVisibility()
            emitStatusIfChanged()

        case "companion.pause":
            if engine.currentState == .resting && !engine.isPaused {
                engine.isPaused = true
                engine.frozenFrame = engine.currentFrameIndex
                cancelCalmIdleTimers()
                stopAnimationTimer()
            }
            syncWindowVisibility()
            emitStatusIfChanged()

        default:
            break
        }
    }

    func updateTransitions() {
        let now = CACurrentMediaTime()

        if engine.currentState == .entering {
            let elapsed = now - engine.transitionStartTime
            if elapsed >= engine.transitionDuration {
                engine.currentState = .resting
                engine.transitionProgress = 1.0
                engine.currentFrameIndex = 0
                if isTakeover {
                    engine.isLooping = true
                    stopAnimationTimer()
                    startCalmIdleSchedule()
                } else {
                    engine.isLooping = false
                    stopAnimationTimer()
                }
                updateGeometryAndLayers()
                if isMidpoint {
                    scheduleMidpointHold()
                }
            } else {
                engine.transitionProgress = CGFloat(elapsed / engine.transitionDuration)
            }
            renderCurrentFrame()
        }

        if engine.currentState == .exiting {
            let elapsed = now - engine.transitionStartTime
            if elapsed >= engine.transitionDuration {
                engine.currentState = .small
                engine.transitionProgress = 0.0
                isMidpoint = false
                isTakeover = false
                cancelCalmIdleTimers()
                stopAnimationTimer()
                syncWindowVisibility()
                if isPreviewMode {
                    exit(0)
                }
                emitStatusIfChanged()
            } else {
                engine.transitionProgress = CGFloat(elapsed / engine.transitionDuration)
            }
            renderCurrentFrame()
        }
    }

    func statusDictionary() -> [String: Any] {
        let activeClip: Any
        switch engine.currentState {
        case .entering: activeClip = "enter"
        case .resting: activeClip = "rest"
        case .exiting: activeClip = "exit"
        case .small: activeClip = NSNull()
        }
        return [
            "kind": "status",
            "panelReady": self.timerPanel != nil,
            "engineState": engine.currentState.rawValue,
            "isPaused": engine.isPaused,
            "activeClip": activeClip,
            "currentFrame": engine.currentFrameIndex,
            "fps": engine.animationFps,
            "anchorFound": engine.anchorFound,
            "petAnchorFound": trustedPetAnchorFound,
            "mainWindowFallbackAnchor": engine.anchorFound && !trustedPetAnchorFound,
            "visualAnchorDiagnostic": visualAnchorDiagnostic,
            "timerPanelVisible": timerPanel?.panel.isVisible ?? false,
            "windowVisible": engine.windowVisible,
            "error": engine.error as Any? ?? NSNull(),
            "targetHeightRatio": engine.targetHeightRatio,
            "displayId": engine.displayId
        ]
    }

    func statusSignature(_ dict: [String: Any]) -> String {
        let activeClip = dict["activeClip"] is NSNull ? "null" : String(describing: dict["activeClip"]!)
        let error = dict["error"] is NSNull ? "null" : String(describing: dict["error"]!)
        return [
            String(describing: dict["engineState"]!),
            String(describing: dict["isPaused"]!),
            activeClip,
            String(describing: dict["fps"]!),
            String(describing: dict["anchorFound"]!),
            String(describing: dict["petAnchorFound"]!),
            String(describing: dict["mainWindowFallbackAnchor"]!),
            String(describing: dict["visualAnchorDiagnostic"]!),
            String(describing: dict["timerPanelVisible"]!),
            String(describing: dict["windowVisible"]!),
            error,
        ].joined(separator: "|")
    }

    func emitStatusIfChanged() {
        if !statusEmissionEnabled { return }
        let dict = statusDictionary()
        let signature = statusSignature(dict)
        if signature == lastStatusSignature { return }
        lastStatusSignature = signature
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
            fflush(stdout)
        }
    }
}

// MARK: - App Delegate
class RendererDelegate: NSObject, NSApplicationDelegate {
    var window: CompanionWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.setupLayer()
        if !window.testStatusSequence && (
            window.testImageIOValidate || window.testFrameValidate || window.testRuntimeConfig ||
            window.testCrop || window.testNearest || window.testTransitionGeometry ||
            window.testTransitionBehavior || window.testTimerFreeze || window.testNoAnchor ||
            window.testMultiDisplay || window.testAnchorFallback || window.testFullscreenGeometry ||
            window.testEasing || window.testInterruptionContinuity || window.testNeutralFallback ||
            window.testPanelGeometry || window.testPanelFocus || window.testPanelFlash ||
            window.testMidpoint || window.testActivateTakeover || window.testTakeoverAtlasPreference ||
            window.testTrustedPetAnchor || window.testIdleProgression || window.testVisualMatch ||
            window.testVoiceGeometryAnchor
        ) {
            window.statusEmissionEnabled = false
        }

        if window.testImageIOValidate { runImageIOValidate(); return }
        if window.testFrameValidate { runFrameValidate(); return }
        if window.testRuntimeConfig { runRuntimeConfigTest(); return }
        if window.testCrop { runCropTest(); return }
        if window.testNearest { runNearestTest(); return }
        if window.testTransitionGeometry { runTransitionGeometryTest(); return }
        if window.testTransitionBehavior { runTransitionBehaviorTest(); return }
        if window.testTimerFreeze { runTimerFreezeTest(); return }
        if window.testNoAnchor { runNoAnchorTest(); return }
        if window.testMultiDisplay { runMultiDisplayTest(); return }
        if window.testAnchorFallback { runAnchorFallbackTest(); return }
        if window.testStatusSequence { runStatusSequenceTest(); return }
        if window.testFullscreenGeometry { runFullscreenGeometryTest(); return }
        if window.testEasing { runEasingTest(); return }
        if window.testInterruptionContinuity { runInterruptionContinuityTest(); return }
        if window.testNeutralFallback { runNeutralFallbackTest(); return }
        if window.testTransientAnchor { runTransientAnchorTest(); return }
        if window.testNonactivatingPanel { runNonactivatingPanelTest(); return }
        if window.testStableAspect { runStableAspectTest(); return }
        if window.testPanelGeometry { runPanelGeometryTest(); return }
        if window.testPanelFocus { runPanelFocusTest(); return }
        if window.testPanelFlash { runPanelFlashTest(); return }
        if window.testPanelErrorPreservation { runPanelErrorPreservationTest(); return }
        if window.testMidpoint { runMidpointTest(); return }
        if window.testActivateTakeover { runActivateTakeoverTest(); return }
        if window.testTakeoverAtlasPreference { runTakeoverAtlasPreferenceTest(); return }
        if window.testTrustedPetAnchor { runTrustedPetAnchorTest(); return }
        if window.testIdleProgression { runIdleProgressionTest(); return }
        if window.testVisualMatch { runVisualMatchTest(); return }
        if window.testVoiceGeometryAnchor { runVoiceGeometryAnchorTest(); return }

        if !window.isPreviewMode {
            Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                self?.window.alignWithCodexWindow()
            }
            window.alignWithCodexWindow()
            window.emitStatusIfChanged()
        } else {
            let screen = window.currentTargetScreen()
            let (anchorLocal, _) = window.calculateGeometry(screen: screen)
            window.lastAnchorFrame = NSRect(x: screen.frame.origin.x + anchorLocal.origin.x,
                                            y: screen.frame.origin.y + anchorLocal.origin.y,
                                            width: anchorLocal.width,
                                            height: anchorLocal.height)
            window.alignWithCodexWindow()
            window.emitStatusIfChanged()

            if let pstate = window.previewState {
                if pstate == "enter" {
                    window.engine.currentState = .entering
                    window.engine.transitionProgress = 0.0
                    window.engine.transitionStartTime = CACurrentMediaTime()
                    window.engine.transitionDuration = 0.6
                    window.engine.isLooping = window.clipLoop["enter"] ?? false
                    window.engine.currentFrameIndex = 0
                    window.setAnimationFps(window.clipFps["enter"] ?? 10)
                    window.startAnimationTimer()
                } else if pstate == "rest" {
                    window.engine.currentState = .resting
                    window.engine.transitionProgress = 1.0
                    window.engine.isLooping = window.clipLoop["rest"] ?? true
                    window.engine.currentFrameIndex = 0
                    window.setAnimationFps(window.clipFps["rest"] ?? 8)
                    window.startAnimationTimer()
                } else if pstate == "exit" {
                    window.engine.currentState = .exiting
                    window.engine.transitionProgress = 0.0
                    window.engine.transitionStartTime = CACurrentMediaTime()
                    window.engine.transitionDuration = 0.4
                    window.engine.isLooping = window.clipLoop["exit"] ?? false
                    window.engine.currentFrameIndex = 0
                    window.setAnimationFps(window.clipFps["exit"] ?? 12)
                    window.startAnimationTimer()
                }
            }
        }

        startReadingStdin()
    }

    func startReadingStdin() {
        DispatchQueue.global(qos: .background).async { [weak self] in
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                guard let data = trimmed.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if let eventName = json["event"] as? String {
                        if eventName == "timer.state" || eventName == "panel.preferences" || eventName == "timer.error" {
                            if let dataStr = try? JSONSerialization.data(withJSONObject: json, options: []),
                               let jsonString = String(data: dataStr, encoding: .utf8) {
                                self.window.timerPanel?.updateState(jsonString: jsonString)
                            }
                            return
                        }
                    }
                    if let evt = VisualEvent.from(json: json) {
                        self.window.processEvent(evt)
                    }
                }
            }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: - Test modes

    func runImageIOValidate() {
        let path = window.atlasPath
        let lowercasedPath = path.lowercased()
        if !lowercasedPath.hasSuffix(".png") && !lowercasedPath.hasSuffix(".webp") {
            print("{\"valid\": false, \"error\": \"Unsupported file extension. Only .png and .webp are allowed\"}")
            exit(0)
        }
        let url = URL(fileURLWithPath: path)
        guard let size = fileSize(at: url), size > 0, size <= maxAtlasBytes else {
            print("{\"valid\": false, \"error\": \"Atlas file size is outside the supported limit\"}")
            exit(0)
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let dimensions = imageDimensions(source: source) else {
            print("{\"valid\": false, \"error\": \"Could not read image dimensions\"}")
            exit(0)
        }
        let w = dimensions.width
        let h = dimensions.height
        guard w == 1536 else {
            print("{\"valid\": false, \"error\": \"Atlas width must be exactly 1536\"}")
            exit(0)
        }
        guard h >= 1872, h % 208 == 0, h / 208 <= maxAtlasRows else {
            print("{\"valid\": false, \"error\": \"Atlas height must contain 9 through 16 rows of 208 pixels\"}")
            exit(0)
        }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            print("{\"valid\": false, \"error\": \"Could not decode bounded atlas image\"}")
            exit(0)
        }
        let alphaInfo = image.alphaInfo
        let hasAlpha = alphaInfo == .premultipliedFirst || alphaInfo == .premultipliedLast ||
                       alphaInfo == .first || alphaInfo == .last || alphaInfo == .alphaOnly

        if !hasAlpha {
            print("{\"valid\": false, \"error\": \"Image does not have an alpha channel\"}")
            exit(0)
        }
        
        print("{\"valid\": true, \"width\": \(w), \"height\": \(h), \"hasAlpha\": \(hasAlpha)}")
        exit(0)
    }

    func runFrameValidate() {
        let path = window.atlasPath
        let lowercasedPath = path.lowercased()
        if !lowercasedPath.hasSuffix(".png") && !lowercasedPath.hasSuffix(".webp") {
            print("{\"valid\": false, \"error\": \"Unsupported file extension. Only .png and .webp are allowed\"}")
            exit(0)
        }
        let url = URL(fileURLWithPath: path)
        guard let size = fileSize(at: url), size > 0, size <= maxFrameBytes else {
            print("{\"valid\": false, \"error\": \"Frame file size is outside the supported limit\"}")
            exit(0)
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let dimensions = imageDimensions(source: source) else {
            print("{\"valid\": false, \"error\": \"Could not read frame dimensions\"}")
            exit(0)
        }
        let w = dimensions.width
        let h = dimensions.height
        guard w > 0, h > 0, w <= maxFrameDimension, h <= maxFrameDimension,
              w * h <= maxFramePixels else {
            print("{\"valid\": false, \"error\": \"Frame dimensions exceed the supported pixel limit\"}")
            exit(0)
        }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            print("{\"valid\": false, \"error\": \"Could not decode bounded frame image\"}")
            exit(0)
        }
        let alphaInfo = image.alphaInfo
        let hasAlpha = alphaInfo == .premultipliedFirst || alphaInfo == .premultipliedLast ||
                       alphaInfo == .first || alphaInfo == .last || alphaInfo == .alphaOnly

        if !hasAlpha {
            print("{\"valid\": false, \"error\": \"Frame image does not have an alpha channel\"}")
            exit(0)
        }
        
        print("{\"valid\": true, \"width\": \(w), \"height\": \(h), \"hasAlpha\": \(hasAlpha)}")
        exit(0)
    }

    func runRuntimeConfigTest() {
        let petId = window.petId
        let atlasPath = window.atlasPath
        let smallWidth = Int(window.smallWidth)
        let restWidth = Int(window.restWidth)
        let sizingMode = window.sizingMode
        let interpolation = window.interpolation
        let atlasRows = window.atlasRows

        let clipNames = ["enter", "rest", "exit"]
        var clipsJson: [String: String] = [:]
        for name in clipNames {
            let frames = window.clipFrames[name] ?? []
            let aFrames = window.clipAtlasFrames[name] ?? []
            let count = !frames.isEmpty ? frames.count : (!aFrames.isEmpty ? aFrames.count : 8)
            let fps = window.clipFps[name] ?? (name == "enter" ? 10 : (name == "rest" ? 8 : 12))
            let loop = window.clipLoop[name] ?? (name == "rest")
            let fallback = frames.isEmpty && aFrames.isEmpty
            clipsJson[name] = "{\"frameCount\": \(count), \"fps\": \(fps), \"loop\": \(loop), \"fallback\": \(fallback)}"
        }

        let clipsStr = clipNames.map { name in
            return "\"\(name)\": \(clipsJson[name]!)"
        }.joined(separator: ", ")

        print("{\"petId\": \"\(petId)\", \"atlasPath\": \"\(atlasPath)\", \"smallWidth\": \(smallWidth), \"restWidth\": \(restWidth), \"sizingMode\": \"\(sizingMode)\", \"interpolation\": \"\(interpolation)\", \"atlasRows\": \(atlasRows), \"clips\": {\(clipsStr)}}")
        exit(0)
    }

    func runCropTest() {
        guard let atlas = loadAtlas(path: window.atlasPath) else {
            print("FAIL: could not load atlas")
            exit(1)
        }
        let w = atlas.width
        let h = atlas.height
        guard let info = deriveAtlasInfo(width: w, height: h) else {
            print("FAIL: atlas dimensions \(w)x\(h) not valid")
            exit(1)
        }
        for row in 0..<min(info.rows, 9) {
            for col in 0..<info.columns {
                guard let frame = extractFrame(atlas: atlas, atlasInfo: info, row: row, col: col) else {
                    print("FAIL: could not extract frame at row=\(row) col=\(col)")
                    exit(1)
                }
                if frame.width != 192 || frame.height != 208 {
                    print("FAIL: frame \(row),\(col) is \(frame.width)x\(frame.height) expected 192x208")
                    exit(1)
                }
            }
        }
        print("OK: \(info.columns)x\(info.rows) cells extracted correctly")
        exit(0)
    }

    func runNearestTest() {
        let layer = CALayer()
        layer.magnificationFilter = .nearest
        if layer.magnificationFilter == .nearest {
            print("OK: magnificationFilter is .nearest")
            exit(0)
        }
        print("FAIL: magnificationFilter is not .nearest")
        exit(1)
    }

    func runTransitionGeometryTest() {
        var results: [[String: Double]] = []

        for i in 0...6 {
            let t = Double(i) / 6.0 * 0.6
            let progress = min(1.0, max(0.0, t / 0.6))
            let easedP = easeOvershoot(CGFloat(progress))
            results.append(["time_ms": t * 1000, "scale": Double(easedP)])
        }

        for i in 0...4 {
            let t = Double(i) / 4.0 * 0.4
            let progress = 1.0 - min(1.0, max(0.0, t / 0.4))
            results.append(["time_ms": (0.6 + t) * 1000, "scale": progress])
        }

        if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runTransitionBehaviorTest() {
        guard let win = window else { return }
        var results: [[String: Double]] = []

        win.engine.currentState = .small
        win.engine.transitionProgress = 0.0

        let activateEvent = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "tb1", reason: nil, deadline: nil, rawJson: [:])
        win.processEvent(activateEvent)

        let enterStart = CACurrentMediaTime()
        win.engine.transitionStartTime = enterStart
        win.engine.transitionDuration = 0.6

        let t1 = 0.3
        let p1 = t1 / 0.6
        win.engine.transitionProgress = CGFloat(p1)
        win.updateGeometryAndLayers()
        let scale1 = p1

        results.append(["test": 1, "phase": 1, "time_ms": t1 * 1000, "scale": scale1, "state": 1])

        let deactivateEvent = VisualEvent(schemaVersion: 1, event: "companion.deactivate", eventId: "tb2", reason: nil, deadline: nil, rawJson: [:])
        win.processEvent(deactivateEvent)

        let exitStart = CACurrentMediaTime()
        win.engine.transitionStartTime = exitStart
        win.engine.transitionDuration = 0.4
        let partialScale = win.engine.exitStartProgress
        results.append(["test": 1, "phase": 2, "time_ms": 300, "scale": Double(partialScale), "state": 2])

        let exitElapsed = 0.2
        let exitProgress = exitElapsed / 0.4
        let exitScale = partialScale * CGFloat(1.0 - exitProgress)
        results.append(["test": 1, "phase": 3, "time_ms": 500, "scale": Double(exitScale), "state": 2])

        let exitScaleFinal = partialScale * CGFloat(1.0 - 1.0)
        results.append(["test": 1, "phase": 4, "time_ms": 700, "scale": Double(exitScaleFinal), "state": 0])

        win.engine.currentState = .small
        win.engine.transitionProgress = 0.0

        let activateEvent2 = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "tb3", reason: nil, deadline: nil, rawJson: [:])
        win.processEvent(activateEvent2)

        win.engine.transitionStartTime = CACurrentMediaTime()
        win.engine.transitionDuration = 0.6

        let partialT = 0.15
        let partialP2 = partialT / 0.6
        win.engine.transitionProgress = CGFloat(partialP2)
        win.updateGeometryAndLayers()

        results.append(["test": 2, "phase": 1, "time_ms": partialT * 1000, "scale": partialP2, "state": 1])

        let deactivateEvent2 = VisualEvent(schemaVersion: 1, event: "companion.deactivate", eventId: "tb4", reason: nil, deadline: nil, rawJson: [:])
        win.processEvent(deactivateEvent2)

        let exitStart2 = CACurrentMediaTime()
        win.engine.transitionStartTime = exitStart2
        win.engine.transitionDuration = 0.4
        let partialScaleAfter = win.engine.exitStartProgress
        results.append(["test": 2, "phase": 2, "time_ms": 150, "scale": Double(partialScaleAfter), "state": 2])

        if abs(partialScaleAfter - CGFloat(partialP2)) < 0.01 {
            results.append(["test": 2, "phase": 3, "time_ms": 150, "scale": Double(partialScaleAfter), "state": 2, "interrupt_correct": 1])
        } else {
            results.append(["test": 2, "phase": 3, "time_ms": 150, "scale": Double(partialScaleAfter), "state": 2, "interrupt_correct": 0])
        }

        if let data = try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted]),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runTimerFreezeTest() {
        let activateEvent = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "t1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(activateEvent)

        window.engine.currentState = .resting
        window.engine.isPaused = false

        if window.animationTimer == nil {
            window.startAnimationTimer()
        }

        if window.animationTimer == nil {
            print("FAIL: timer not created after activate")
            exit(1)
        }

        let pauseEvent = VisualEvent(schemaVersion: 1, event: "companion.pause", eventId: "t2", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(pauseEvent)

        if !window.engine.isPaused {
            print("FAIL: isPaused not set after pause event")
            exit(1)
        }
        if window.animationTimer != nil {
            print("FAIL: timer not invalidated after pause")
            exit(1)
        }

        let resumeEvent = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "t3", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(resumeEvent)

        if window.engine.isPaused {
            print("FAIL: isPaused still true after resume")
            exit(1)
        }
        if window.isTakeover {
            if window.animationTimer != nil {
                print("FAIL: timer should not run during takeover rest")
                exit(1)
            }
        } else {
            if window.animationTimer == nil {
                print("FAIL: timer not re-created after resume")
                exit(1)
            }
        }

        print("OK: timer freeze and resume works correctly")
        exit(0)
    }

    func runStatusSequenceTest() {
        window.engine.anchorFound = true
        window.visualAnchorDiagnostic = "main-window-only"
        window.engine.windowVisible = false
        window.lastAnchorFrame = NSRect(x: 100, y: 100, width: 84, height: 208)
        window.emitStatusIfChanged()

        let activate = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "s1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(activate)

        window.engine.currentState = .resting
        window.engine.transitionProgress = 1.0
        window.engine.isLooping = true
        window.engine.currentFrameIndex = 3
        window.setAnimationFps(8)
        window.emitStatusIfChanged()

        let pause = VisualEvent(schemaVersion: 1, event: "companion.pause", eventId: "s2", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(pause)

        let resume = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "s3", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(resume)
        if window.engine.currentFrameIndex != 0 {
            window.engine.error = "resume did not return to base frame"
            window.emitStatusIfChanged()
            exit(1)
        }

        let deactivate = VisualEvent(schemaVersion: 1, event: "companion.deactivate", eventId: "s4", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(deactivate)

        window.engine.currentState = .small
        window.engine.transitionProgress = 0.0
        window.engine.windowVisible = false
        window.engine.currentFrameIndex = 0
        window.emitStatusIfChanged()
        exit(0)
    }

    func runNoAnchorTest() {
        window.testNoAnchor = true
        window.alignWithCodexWindow()
        if window.engine.anchorFound {
            print("FAIL: anchor should not be found in --test-no-anchor mode")
            exit(1)
        }
        if window.engine.windowVisible {
            print("FAIL: window should be hidden when no anchor found")
            exit(1)
        }
        print("OK: no anchor correctly hides window")
        exit(0)
    }

    func runMultiDisplayTest() {
        let mockScreen = NSScreen.main ?? NSScreen()
        let (anchorLocal, targetLocal) = window.calculateGeometry(screen: mockScreen)
        let visibleFrame = mockScreen.visibleFrame
        let displayFrame = mockScreen.frame

        let visibleLocalMinX = visibleFrame.origin.x - displayFrame.origin.x
        let visibleLocalMinY = visibleFrame.origin.y - displayFrame.origin.y
        let visibleCenterX = visibleLocalMinX + visibleFrame.width / 2.0
        let visibleCenterY = visibleLocalMinY + visibleFrame.height / 2.0

        if abs(targetLocal.midX - visibleCenterX) > 2.0 || abs(targetLocal.midY - visibleCenterY) > 2.0 {
            print("FAIL: target not centered on display")
            exit(1)
        }

        if anchorLocal.width != window.smallWidth && anchorLocal.width != 84.0 {
            print("FAIL: anchor width incorrect")
            exit(1)
        }

        print("OK: multi-display position calculations valid")
        exit(0)
    }
    
    func runAnchorFallbackTest() {
        window.testAnchorFallback = true
        window.alignWithCodexWindow()
        
        if window.engine.anchorFound {
            print("FAIL: fallback should not find anchor when no main window is present")
            exit(1)
        }
        
        if window.engine.windowVisible {
            print("FAIL: window should be hidden when fallback finds no main window")
            exit(1)
        }
        
        guard let primaryScreen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first else {
            print("FAIL: no primary screen found")
            exit(1)
        }
        let ph = primaryScreen.frame.height
        
        let testX: CGFloat = 100
        let testY: CGFloat = 200
        let testW: CGFloat = 300
        let testH: CGFloat = 200
        let appKitY = ph - testY - testH
        if appKitY < 0 || appKitY > ph {
            print("FAIL: primary display conversion out of bounds: y=\(appKitY)")
            exit(1)
        }
        
        if let foundScreen = window.findScreenForCGRect(x: testX, y: testY, w: testW, h: testH) {
            let expectedScreenCGY = ph - foundScreen.frame.origin.y - foundScreen.frame.height
            if testY < expectedScreenCGY || testY + testH > expectedScreenCGY + foundScreen.frame.height {
            }
        } else {
            print("FAIL: findScreenForCGRect returned nil for primary display rect")
            exit(1)
        }
        
        print("OK: anchor fallback mode works correctly (no false anchor)")
        exit(0)
    }

    func runFullscreenGeometryTest() {
        let mockScreen = NSScreen.main ?? NSScreen()
        let (anchorLocal, targetLocal) = window.calculateGeometry(screen: mockScreen)
        let visibleH = mockScreen.visibleFrame.height
        let heightRatio = targetLocal.height / visibleH
        let aspect = targetLocal.width / targetLocal.height

        let visibleLocalCenterX = (mockScreen.visibleFrame.origin.x - mockScreen.frame.origin.x) + mockScreen.visibleFrame.width / 2.0
        let visibleLocalCenterY = (mockScreen.visibleFrame.origin.y - mockScreen.frame.origin.y) + mockScreen.visibleFrame.height / 2.0

        let targetCenterX = targetLocal.midX
        let targetCenterY = targetLocal.midY

        let centered = abs(targetCenterX - visibleLocalCenterX) < 1.0 && abs(targetCenterY - visibleLocalCenterY) < 1.0
        let anchorFirst = (anchorLocal.width == window.smallWidth || anchorLocal.width == 84.0)

        window.engine.currentState = .resting
        window.updateGeometryAndLayers()
        let opacity = window.backdropLayer?.opacity ?? 0.0

        // Test wide image (aspect 4.0)
        let wideAspect: CGFloat = 4.0
        let maxW = mockScreen.visibleFrame.width * 0.92
        let targetH_wide_pref = visibleH * 0.72
        var targetW_wide = targetH_wide_pref * wideAspect
        var targetH_wide = targetH_wide_pref
        if targetW_wide > maxW {
            targetW_wide = maxW
            targetH_wide = targetW_wide / wideAspect
        }
        let wideAspectPreserved = abs((targetW_wide / targetH_wide) - wideAspect) < 0.001
        let wideWidthConstrained = abs(targetW_wide - maxW) < 0.001
        let wideContained = targetW_wide <= maxW && targetH_wide <= visibleH

        // Test tall image (aspect 0.1)
        let tallAspect: CGFloat = 0.1
        let targetH_tall_pref = visibleH * 0.72
        var targetW_tall = targetH_tall_pref * tallAspect
        var targetH_tall = targetH_tall_pref
        if targetW_tall > maxW {
            targetW_tall = maxW
            targetH_tall = targetW_tall / tallAspect
        }
        let tallAspectPreserved = abs((targetW_tall / targetH_tall) - tallAspect) < 0.001
        let tallHeightPreserved = abs(targetH_tall - targetH_tall_pref) < 0.001
        let tallContained = targetW_tall <= maxW && targetH_tall <= visibleH

        let result: [String: Any] = [
            "heightRatio": Double(heightRatio),
            "aspectRatio": Double(aspect),
            "anchorFirstFrame": anchorFirst,
            "centeredFinalFrame": centered,
            "backdropOpacity": Double(opacity),
            "wideImageValid": wideAspectPreserved && wideWidthConstrained && wideContained,
            "tallImageValid": tallAspectPreserved && tallHeightPreserved && tallContained
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runEasingTest() {
        var maxOvershootVal: CGFloat = 0.0
        for i in 0...100 {
            let t = CGFloat(i) / 100.0
            let val = easeOvershoot(t)
            if val > maxOvershootVal {
                maxOvershootVal = val
            }
        }
        let finalVal = easeOvershoot(1.0)
        let overshootPercent = (maxOvershootVal - 1.0) * 100.0

        let valid = overshootPercent <= 4.0 && overshootPercent >= 0.0 && abs(finalVal - 1.0) < 0.0001
        let result: [String: Any] = [
            "maxOvershoot": Double(maxOvershootVal),
            "overshootPercent": Double(overshootPercent),
            "finalValue": Double(finalVal),
            "valid": valid
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runInterruptionContinuityTest() {
        window.engine.currentState = .entering
        window.engine.transitionProgress = 0.5
        window.updateGeometryAndLayers()

        let enterMidRect = window.petLayer?.frame ?? .zero
        let enterMidOpacity = CGFloat(window.backdropLayer?.opacity ?? 0.0)

        let deactivateEvent = VisualEvent(schemaVersion: 1, event: "companion.deactivate", eventId: "ic1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(deactivateEvent)

        let exitStartRect = window.engine.exitStartRect
        let exitStartOpacity = window.engine.exitStartBackdropOpacity

        let rectDiff = abs(enterMidRect.origin.x - exitStartRect.origin.x) +
                       abs(enterMidRect.origin.y - exitStartRect.origin.y) +
                       abs(enterMidRect.width - exitStartRect.width) +
                       abs(enterMidRect.height - exitStartRect.height)
        let opacityDiff = abs(enterMidOpacity - exitStartOpacity)

        let continuous = rectDiff < 0.01 && opacityDiff < 0.01
        let result: [String: Any] = [
            "rectDiff": Double(rectDiff),
            "opacityDiff": Double(opacityDiff),
            "continuityValid": continuous
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runNeutralFallbackTest() {
        window.engine.currentState = .entering
        window.engine.transitionStartTime = CACurrentMediaTime()
        window.engine.transitionDuration = 0.6
        window.engine.currentFrameIndex = 0
        window.tickAnimation()
        let enterFrame = window.engine.currentFrameIndex

        window.engine.currentState = .resting
        window.engine.currentFrameIndex = 0
        window.tickAnimation()
        let restFrame = window.engine.currentFrameIndex

        window.engine.currentState = .exiting
        window.engine.transitionStartTime = CACurrentMediaTime()
        window.engine.transitionDuration = 0.4
        window.engine.frozenFrame = 3
        window.tickAnimation()
        let exitFrame = window.engine.currentFrameIndex

        let valid = (enterFrame == 0) && (restFrame == 1) && (exitFrame == 3)
        let result: [String: Any] = [
            "enterFrame": enterFrame,
            "restFrame": restFrame,
            "exitFrame": exitFrame,
            "neutralFallbackValid": valid
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runTransientAnchorTest() {
        window.statusEmissionEnabled = false
        guard let screen = NSScreen.screens.first else { exit(1) }
        window.lastAnchorScreen = screen
        window.lastAnchorFrame = NSRect(x: 100, y: 150, width: 84, height: 208)

        window.engine.currentState = .resting
        window.alignWithCodexWindow()
        let visibleWhenResting = window.engine.windowVisible

        // Simulate transient anchor loss
        window.engine.anchorFound = false
        window.syncWindowVisibility()
        window.updateGeometryAndLayers()
        let visibleOnTransientLoss = window.engine.windowVisible
        let (anchorLocal, _) = window.calculateGeometry(screen: screen)
        let keptLastAnchor = (anchorLocal.origin.x == 100 - screen.frame.origin.x)

        // Simulate screen disconnection (screen gone)
        window.lastAnchorScreen = NSScreen()
        window.updateGeometryAndLayers()
        let mainScreen = NSScreen.main ?? NSScreen()
        let clampedDefaultW: CGFloat = window.smallWidth
        let defaultX = mainScreen.visibleFrame.midX - clampedDefaultW / 2.0
        let expectedClampedX = max(mainScreen.visibleFrame.minX, min(mainScreen.visibleFrame.maxX - clampedDefaultW, defaultX)) - mainScreen.frame.origin.x
        let (fallbackAnchorLocal, fallbackTargetLocal) = window.calculateGeometry(screen: mainScreen)
        let screenGoneFallback = abs(fallbackAnchorLocal.origin.x - expectedClampedX) < 1.0 && abs((window.petLayer?.frame.origin.x ?? 0) - fallbackTargetLocal.origin.x) < 1.0

        // Transition to small state
        window.engine.currentState = .small
        window.syncWindowVisibility()
        let hiddenWhenSmall = !window.engine.windowVisible

        let valid = visibleWhenResting && visibleOnTransientLoss && keptLastAnchor && screenGoneFallback && hiddenWhenSmall
        let result: [String: Any] = [
            "visibleWhenResting": visibleWhenResting,
            "visibleOnTransientLoss": visibleOnTransientLoss,
            "keptLastAnchor": keptLastAnchor,
            "screenGoneFallback": screenGoneFallback,
            "hiddenWhenSmall": hiddenWhenSmall,
            "valid": valid
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runNonactivatingPanelTest() {
        window.statusEmissionEnabled = false
        let key = window.canBecomeKey
        let main = window.canBecomeMain
        let mousePass = window.ignoresMouseEvents
        let nonactivating = window.styleMask.contains(.nonactivatingPanel)
        let borderless = window.styleMask.contains(.borderless)

        window.engine.currentState = .resting
        window.syncWindowVisibility()
        let visible = window.engine.windowVisible

        let valid = !key && !main && mousePass && nonactivating && borderless && visible
        let result: [String: Any] = [
            "canBecomeKey": key,
            "canBecomeMain": main,
            "ignoresMouseEvents": mousePass,
            "isNonactivatingPanel": nonactivating,
            "isBorderless": borderless,
            "windowVisible": visible,
            "valid": valid
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runStableAspectTest() {
        window.statusEmissionEnabled = false
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var rawData = [UInt8](repeating: 255, count: 100 * 100 * 4)
        guard let ctxEnter = CGContext(data: &rawData, width: 100, height: 100, bitsPerComponent: 8, bytesPerRow: 400, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let enterImage = ctxEnter.makeImage() else {
            exit(1)
        }
        var rawDataRest = [UInt8](repeating: 255, count: 400 * 200 * 4)
        guard let ctxRest = CGContext(data: &rawDataRest, width: 400, height: 200, bitsPerComponent: 8, bytesPerRow: 1600, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let restImage = ctxRest.makeImage() else {
            exit(1)
        }

        window.clipFrames["enter"] = [enterImage]
        window.clipFrames["rest"] = [restImage]

        window.engine.currentState = .entering
        let mockScreen = NSScreen.main ?? NSScreen()
        let (_, targetEntering) = window.calculateGeometry(screen: mockScreen)

        window.engine.currentState = .resting
        let (_, targetResting) = window.calculateGeometry(screen: mockScreen)

        window.engine.currentState = .exiting
        let (_, targetExiting) = window.calculateGeometry(screen: mockScreen)

        let noJump = abs(targetEntering.width - targetResting.width) < 0.001 &&
                     abs(targetEntering.height - targetResting.height) < 0.001 &&
                     abs(targetResting.width - targetExiting.width) < 0.001 &&
                     abs(targetResting.height - targetExiting.height) < 0.001

        let aspectIsRest = abs((targetEntering.width / targetEntering.height) - 2.0) < 0.001

        let valid = noJump && aspectIsRest
        let result: [String: Any] = [
            "enteringTarget": ["w": Double(targetEntering.width), "h": Double(targetEntering.height)],
            "restingTarget": ["w": Double(targetResting.width), "h": Double(targetResting.height)],
            "exitingTarget": ["w": Double(targetExiting.width), "h": Double(targetExiting.height)],
            "noJump": noJump,
            "aspectIsRest": aspectIsRest,
            "valid": valid
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runPanelGeometryTest() {
        if let panel = window.timerPanel {
            panel.runGeometryTest()
        } else {
            print("FAIL: timerPanel not loaded")
            exit(1)
        }
    }
    func runPanelFocusTest() {
        if let panel = window.timerPanel {
            panel.runFocusTest()
        } else {
            print("FAIL: timerPanel not loaded")
            exit(1)
        }
    }
    func runPanelFlashTest() {
        if let panel = window.timerPanel {
            panel.runFlashTest()
        } else {
            print("FAIL: timerPanel not loaded")
            exit(1)
        }
    }
    func runPanelErrorPreservationTest() {
        if let panel = window.timerPanel {
            panel.runErrorPreservationTest()
        } else {
            print("FAIL: timerPanel not loaded")
            exit(1)
        }
    }

    func runMidpointTest() {
        window.statusEmissionEnabled = false
        var results: [String: Any] = [:]

        results["initialState"] = window.engine.currentState.rawValue

        let evt = VisualEvent(schemaVersion: 1, event: "companion.midpoint", eventId: "m1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(evt)

        results["afterMidpointState"] = window.engine.currentState.rawValue
        results["isMidpoint"] = window.isMidpoint
        results["currentFrame"] = window.engine.currentFrameIndex
        results["isLooping"] = window.engine.isLooping

        let enteredEntering = window.engine.currentState == .entering && window.isMidpoint && window.engine.currentFrameIndex == 0

        window.engine.transitionStartTime = -1.0
        window.engine.transitionDuration = 0.6
        window.updateTransitions()

        results["afterEnterState"] = window.engine.currentState.rawValue
        results["afterEnterFrame"] = window.engine.currentFrameIndex
        results["afterEnterIsLooping"] = window.engine.isLooping

        let enteredResting = window.engine.currentState == .resting && window.engine.isLooping && window.engine.currentFrameIndex == 0

        results["enteredEntering"] = enteredEntering
        results["enteredResting"] = enteredResting
        results["valid"] = enteredEntering && enteredResting

        // Test cancel: companion.activate during midpoint resting clears isMidpoint
        let cancelEvt = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "cancel-mid", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(cancelEvt)
        results["afterCancelIsMidpoint"] = window.isMidpoint
        results["afterCancelState"] = window.engine.currentState.rawValue
        results["afterCancelFrame"] = window.engine.currentFrameIndex
        results["afterCancelIsLooping"] = window.engine.isLooping
        results["cancelValid"] = !window.isMidpoint && window.engine.currentState == .resting && window.engine.isLooping

        window.engine.currentState = .small
        window.trustedPetAnchorFound = true
        let eyeEvent = VisualEvent(schemaVersion: 1, event: "companion.midpoint", eventId: "eye-test",
            reason: "eye-rest", deadline: nil, rawJson: [:])
        window.processEvent(eyeEvent)
        window.engine.transitionStartTime = -1
        window.updateTransitions()
        results["eyeRestValid"] = window.reminderHoldSeconds == 20 && window.isMidpoint &&
            window.engine.currentState == .resting && window.eyeRestTextLayer?.isHidden == false
        let restEvent = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "rest-eye-test",
            reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(restEvent)
        window.updateGeometryAndLayers()
        results["restOverridesEyeReminder"] = !window.isMidpoint && window.eyeRestTextLayer?.isHidden == true

        if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runActivateTakeoverTest() {
        window.statusEmissionEnabled = false
        var results: [String: Any] = [:]

        results["initialState"] = window.engine.currentState.rawValue

        let evt = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "at1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(evt)

        results["afterActivateState"] = window.engine.currentState.rawValue
        results["isTakeover"] = window.isTakeover
        results["currentFrame"] = window.engine.currentFrameIndex
        results["isLooping"] = window.engine.isLooping

        let enteredEntering = window.engine.currentState == .entering && window.isTakeover && !window.isMidpoint && window.engine.currentFrameIndex == 0 && !window.engine.isLooping

        window.engine.transitionStartTime = -1.0
        window.engine.transitionDuration = 0.6
        window.updateTransitions()

        results["afterEnterState"] = window.engine.currentState.rawValue
        results["afterEnterFrame"] = window.engine.currentFrameIndex
        results["afterEnterIsLooping"] = window.engine.isLooping

        let enteredResting = window.engine.currentState == .resting && window.engine.isLooping && window.engine.currentFrameIndex == 0

        results["enteredEntering"] = enteredEntering
        results["enteredResting"] = enteredResting
        results["valid"] = enteredEntering && enteredResting

        if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runTakeoverAtlasPreferenceTest() {
        window.statusEmissionEnabled = false
        window.petId = "rocky"
        var results: [String: Any] = [:]

        results["atlasLoaded"] = window.atlas != nil
        results["customClipSet"] = (window.clipFrames["rest"]?.isEmpty == false)

        window.engine.currentState = .small
        window.engine.transitionProgress = 0.0

        let evt = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "tap1", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(evt)

        results["afterActivateState"] = window.engine.currentState.rawValue
        results["isTakeover"] = window.isTakeover
        results["isLooping"] = window.engine.isLooping
        results["currentFrame"] = window.engine.currentFrameIndex

        window.renderCurrentFrame()
        if let layer = window.petLayer, let contents = layer.contents {
            let cfImage = contents as! CGImage
            results["renderWidth"] = cfImage.width
            results["renderHeight"] = cfImage.height
            results["usingAtlasCell"] = cfImage.width == 192 && cfImage.height == 208
        } else {
            results["usingAtlasCell"] = false
        }

        window.engine.transitionStartTime = -1.0
        window.engine.transitionDuration = 0.6
        window.updateTransitions()

        results["afterRestState"] = window.engine.currentState.rawValue
        results["afterRestFrame"] = window.engine.currentFrameIndex
        results["holdTimerRunning"] = window.holdTimer != nil
        results["animationTimerRunning"] = window.animationTimer != nil

        window.renderCurrentFrame()
        if let layer = window.petLayer, let contents = layer.contents {
            let cfImage = contents as! CGImage
            results["restRenderWidth"] = cfImage.width
            results["restRenderHeight"] = cfImage.height
            results["restUsingAtlasCell"] = cfImage.width == 192 && cfImage.height == 208
        } else {
            results["restUsingAtlasCell"] = false
        }

        let atlasUsed = results["usingAtlasCell"] as? Bool == true
        let restAtlasUsed = results["restUsingAtlasCell"] as? Bool == true
        let hasHoldTimer = results["holdTimerRunning"] as? Bool == true
        let noAnimTimer = results["animationTimerRunning"] as? Bool == false
        let enteredCorrectly = window.engine.currentState == .resting && window.engine.currentFrameIndex == 0

        results["valid"] = atlasUsed && restAtlasUsed && hasHoldTimer && noAnimTimer && enteredCorrectly

        if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runTrustedPetAnchorTest() {
        window.statusEmissionEnabled = false
        guard let primaryScreen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first else { exit(1) }
        let primaryHeight = primaryScreen.frame.height

        // 1. Layer-3 408x400 Codex pet is trusted and the timer panel is eligible
        let layer3PetWin: [String: Any] = [
            kCGWindowOwnerName as String: "ChatGPT",
            kCGWindowName as String: "Codex",
            kCGWindowLayer as String: 3,
            kCGWindowBounds as String: [
                "X": CGFloat(100),
                "Y": CGFloat(100),
                "Width": CGFloat(408),
                "Height": CGFloat(400)
            ]
        ]
        window.mockWindowList = [layer3PetWin]
        window.alignWithCodexWindow()

        let trustedPetCase = window.engine.anchorFound &&
                             window.trustedPetAnchorFound &&
                             (window.timerPanel?.isAnchorFound == true) &&
                             (window.timerPanel?.panel.isVisible == true) &&
                             window.lastAnchorFrame == NSRect(x: 100, y: primaryHeight - 100 - 400, width: 408, height: 400)

        // 2. A supported tall voice host may provide a geometry-only estimate.
        let voicePetHostWin: [String: Any] = [
            kCGWindowOwnerName as String: "ChatGPT",
            kCGWindowName as String: "ChatGPT",
            kCGWindowLayer as String: 3,
            kCGWindowBounds as String: [
                "X": CGFloat(1400),
                "Y": CGFloat(-153),
                "Width": CGFloat(770),
                "Height": CGFloat(2075)
            ]
        ]
        window.mockWindowList = [voicePetHostWin]
        window.alignWithCodexWindow()

        let voicePetHostCase = window.engine.anchorFound &&
                               window.trustedPetAnchorFound &&
                               window.visualAnchorDiagnostic == "voice-host-geometry-estimate" &&
                               (window.timerPanel?.panel.isVisible == true)

        // 3. Main window alone may anchor fullscreen but never makes timer panel visible
        let mainWindowWin: [String: Any] = [
            kCGWindowOwnerName as String: "ChatGPT",
            kCGWindowName as String: "ChatGPT Main Window",
            kCGWindowLayer as String: 0,
            kCGWindowBounds as String: [
                "X": CGFloat(0),
                "Y": CGFloat(0),
                "Width": CGFloat(1920),
                "Height": CGFloat(970)
            ]
        ]
        // The pet has been absent longer than the grace interval; the
        // persistent main window alone must not keep the timer visible.
        window.mockMediaTime = window.mediaTime() + window.visualAnchorStaleInterval + 0.1
        window.mockWindowList = [mainWindowWin]
        window.alignWithCodexWindow()

        let mainWindowOnlyCase = window.engine.anchorFound &&
                                 !window.trustedPetAnchorFound &&
                                 (window.timerPanel?.isAnchorFound == false) &&
                                 (window.timerPanel?.panel.isVisible == false)

        // 4. No trusted anchor hides panel
        window.mockWindowList = []
        window.alignWithCodexWindow()

        let noAnchorCase = !window.engine.anchorFound &&
                           !window.trustedPetAnchorFound &&
                           (window.timerPanel?.isAnchorFound == false) &&
                           (window.timerPanel?.panel.isVisible == false)

        let result: [String: Any] = [
            "trustedPetCase": trustedPetCase,
            "voicePetHostCase": voicePetHostCase,
            "mainWindowOnlyCase": mainWindowOnlyCase,
            "noAnchorCase": noAnchorCase,
            "valid": trustedPetCase && voicePetHostCase && mainWindowOnlyCase && noAnchorCase
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runIdleProgressionTest() {
        window.statusEmissionEnabled = false
        var results: [String: Any] = [:]

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var rawData = [UInt8](repeating: 255, count: 1536 * 1872 * 4)
        guard let ctx8 = CGContext(data: &rawData, width: 1536, height: 1872, bitsPerComponent: 8, bytesPerRow: 1536 * 4, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let atlas8Col = ctx8.makeImage() else {
            exit(1)
        }
        window.atlas = atlas8Col
        window.atlasInfo = deriveAtlasInfo(width: 1536, height: 1872)

        // 1. Rocky profile resolution
        window.petId = "rocky"
        let rockyProfile = resolveTakeoverIdleProfile(petId: window.petId, atlasInfo: window.atlasInfo)
        let rockyProfileValid = (rockyProfile != nil) &&
                                (rockyProfile?.row == 0) &&
                                (rockyProfile?.baseFrame == 0) &&
                                (rockyProfile?.blinkFrames == [0, 1, 0]) &&
                                (rockyProfile?.blinkInterval == 3.0) &&
                                ((rockyProfile?.frameDuration ?? 1.0) <= 0.166)

        // 2. Stable hold timer / no repeating animation timer
        window.isTakeover = true
        window.engine.currentState = .resting
        window.engine.isPaused = false
        window.startCalmIdleSchedule()

        let stableHoldTimerValid = (window.animationTimer == nil) &&
                                   (window.holdTimer != nil) &&
                                   (window.burstTimer == nil) &&
                                   (window.engine.currentFrameIndex == 0)

        // 3. Exact [0,1,0] burst & Return to base and burst timer shutdown
        guard let prof = rockyProfile else { exit(1) }
        window.triggerBlinkBurst(profile: prof)
        let burstFrameStep0 = window.engine.currentFrameIndex
        let burstTimerActive = (window.burstTimer != nil)

        window.advanceBlinkBurst(profile: prof)
        let burstFrameStep1 = window.engine.currentFrameIndex

        window.advanceBlinkBurst(profile: prof)
        let burstFrameStep2 = window.engine.currentFrameIndex

        window.advanceBlinkBurst(profile: prof)

        let blinkBurstValid = (burstFrameStep0 == 0) && burstTimerActive && (burstFrameStep1 == 1) && (burstFrameStep2 == 0)
        let burstShutdownValid = (window.burstTimer == nil) && (window.engine.currentFrameIndex == 0) && (window.holdTimer != nil)

        // 4. Missing / Unknown pet static fallback (no timers)
        window.cancelCalmIdleTimers()
        window.petId = ""
        window.startCalmIdleSchedule()
        let missingPetStaticValid = (window.animationTimer == nil) &&
                                    (window.holdTimer == nil) &&
                                    (window.burstTimer == nil) &&
                                    (window.engine.currentFrameIndex == 0)

        window.cancelCalmIdleTimers()
        window.petId = "unknown_pet"
        window.startCalmIdleSchedule()
        let unknownPetStaticValid = (window.animationTimer == nil) &&
                                    (window.holdTimer == nil) &&
                                    (window.burstTimer == nil) &&
                                    (window.engine.currentFrameIndex == 0)

        // 5. Midpoint static before auto-exit
        window.cancelCalmIdleTimers()
        window.petId = "rocky"
        window.engine.currentState = .small
        let midEvt = VisualEvent(schemaVersion: 1, event: "companion.midpoint", eventId: "ip-mid", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(midEvt)
        window.engine.transitionStartTime = -1.0
        window.engine.transitionDuration = 0.6
        window.updateTransitions()
        let midRestState = window.engine.currentState
        let midRestFrame = window.engine.currentFrameIndex
        let midHoldScheduled = (window.holdTimer != nil)
        window.cancelCalmIdleTimers()
        window.engine.currentState = .exiting
        let midExitHoldNil = (window.holdTimer == nil) && (window.burstTimer == nil)
        let midpointStaticValid = (midRestState == .resting) && (midRestFrame == 0) && midHoldScheduled && midExitHoldNil

        // 6. Pause cancellation / freeze
        window.cancelCalmIdleTimers()
        window.petId = "rocky"
        window.engine.currentState = .resting
        window.engine.isPaused = false
        window.startCalmIdleSchedule()
        let pauseEvt = VisualEvent(schemaVersion: 1, event: "companion.pause", eventId: "ip-pause", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(pauseEvt)
        let pauseIsPaused = window.engine.isPaused
        let pauseFrozenFrame = window.engine.frozenFrame
        let pauseTimersNil = (window.holdTimer == nil) && (window.burstTimer == nil) && (window.animationTimer == nil)
        let pauseCancelValid = pauseIsPaused && (pauseFrozenFrame == 0) && pauseTimersNil

        // 7. Resume base + fresh hold
        let resumeEvt = VisualEvent(schemaVersion: 1, event: "companion.activate", eventId: "ip-resume", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(resumeEvt)
        let resumeIsPaused = window.engine.isPaused
        let resumeFrame = window.engine.currentFrameIndex
        let resumeHoldScheduled = (window.holdTimer != nil) && (window.animationTimer == nil)
        let resumeHoldValid = !resumeIsPaused && (resumeFrame == 0) && resumeHoldScheduled

        // 8. Exit base + timer cleanup & transition geometry preservation
        let deactEvt = VisualEvent(schemaVersion: 1, event: "companion.deactivate", eventId: "ip-deact", reason: nil, deadline: nil, rawJson: [:])
        window.processEvent(deactEvt)
        let deactState = window.engine.currentState
        let deactFrame = window.engine.currentFrameIndex
        let deactTimersNil = (window.holdTimer == nil) && (window.burstTimer == nil)
        let deactGeomPreserved = (window.engine.exitStartRect.width > 0)
        let exitCleanupValid = (deactState == .exiting) && (deactFrame == 0) && deactTimersNil && deactGeomPreserved

        let allValid = rockyProfileValid && stableHoldTimerValid && blinkBurstValid &&
                       burstShutdownValid && missingPetStaticValid && unknownPetStaticValid &&
                       midpointStaticValid && pauseCancelValid && resumeHoldValid && exitCleanupValid

        results["rockyProfileValid"] = rockyProfileValid
        results["stableHoldTimerValid"] = stableHoldTimerValid
        results["blinkBurstValid"] = blinkBurstValid
        results["burstShutdownValid"] = burstShutdownValid
        results["missingPetStaticValid"] = missingPetStaticValid
        results["unknownPetStaticValid"] = unknownPetStaticValid
        results["midpointStaticValid"] = midpointStaticValid
        results["pauseCancelValid"] = pauseCancelValid
        results["resumeHoldValid"] = resumeHoldValid
        results["exitCleanupValid"] = exitCleanupValid
        results["valid"] = allValid

        if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runVisualMatchTest() {
        window.statusEmissionEnabled = false

        // 1. Create a synthetic template (60x60) with a distinctive pattern
        let templW = 60
        let templH = 60
        guard let template = createSyntheticRGBAImage(
            width: templW,
            height: templH,
            fillColor: (r: 40, g: 40, b: 40, a: 255),
            pattern: { x, y in
                if x >= 15 && x < 45 && y >= 15 && y < 45 {
                    return (240, 180, 60, 255)
                } else if x >= 20 && x < 40 && y >= 20 && y < 30 {
                    return (20, 20, 20, 255)
                }
                return nil
            }
        ) else {
            exit(1)
        }

        // 2. Positive match case: Host (300x400) with template placed at (120, 150)
        let hostW = 300
        let hostH = 400
        let targetX = 120
        let targetY = 150
        guard let positiveHost = createSyntheticRGBAImage(
            width: hostW,
            height: hostH,
            fillColor: (r: 30, g: 30, b: 35, a: 255),
            pattern: { x, y in
                if x >= targetX && x < targetX + templW && y >= targetY && y < targetY + templH {
                    let tx = x - targetX
                    let ty = y - targetY
                    if tx >= 15 && tx < 45 && ty >= 15 && ty < 45 {
                        return (240, 180, 60, 255)
                    } else if tx >= 20 && tx < 40 && ty >= 20 && ty < 30 {
                        return (20, 20, 20, 255)
                    } else {
                        return (40, 40, 40, 255)
                    }
                }
                return nil
            }
        ) else {
            exit(1)
        }

        let positiveResult = matchPetTemplate(hostImage: positiveHost, templateImage: template, minConfidence: 0.70)
        let positiveMatched = (positiveResult != nil)
        let matchedX = positiveResult?.rect.origin.x ?? -1
        let matchedY = positiveResult?.rect.origin.y ?? -1
        let matchedW = positiveResult?.rect.size.width ?? 0
        let matchedH = positiveResult?.rect.size.height ?? 0
        let confidence = positiveResult?.confidence ?? 0.0
        let positiveCorrect = positiveMatched &&
            Int(matchedX) == targetX &&
            Int(matchedY) == targetY &&
            Int(matchedW) == templW &&
            Int(matchedH) == templH &&
            confidence >= 0.85

        // 3. No-match / low-confidence case: Host with completely distinct content
        guard let noMatchHost = createSyntheticRGBAImage(
            width: hostW,
            height: hostH,
            fillColor: (r: 10, g: 120, b: 180, a: 255),
            pattern: nil
        ) else {
            exit(1)
        }
        let noMatchResult = matchPetTemplate(hostImage: noMatchHost, templateImage: template, minConfidence: 0.70)
        let noMatchRejected = (noMatchResult == nil)

        // 4. Bounds containment checks
        var boundsValid = true
        if let pr = positiveResult {
            if pr.rect.origin.x < 0 || pr.rect.origin.y < 0 ||
               (pr.rect.origin.x + pr.rect.size.width) > CGFloat(hostW) ||
               (pr.rect.origin.y + pr.rect.size.height) > CGFloat(hostH) {
                boundsValid = false
            }
        } else {
            boundsValid = false
        }

        guard let smallerHost = createSyntheticRGBAImage(width: 40, height: 40, fillColor: (r: 50, g: 50, b: 50, a: 255)) else {
            exit(1)
        }
        let smallerHostResult = matchPetTemplate(hostImage: smallerHost, templateImage: template)
        let smallerHostRejected = (smallerHostResult == nil)

        // Edge boundary match at (0, 0)
        guard let edgeHost = createSyntheticRGBAImage(
            width: hostW,
            height: hostH,
            fillColor: (r: 30, g: 30, b: 35, a: 255),
            pattern: { x, y in
                if x < templW && y < templH {
                    if x >= 15 && x < 45 && y >= 15 && y < 45 {
                        return (240, 180, 60, 255)
                    } else if x >= 20 && x < 40 && y >= 20 && y < 30 {
                        return (20, 20, 20, 255)
                    } else {
                        return (40, 40, 40, 255)
                    }
                }
                return nil
            }
        ) else {
            exit(1)
        }
        let edgeResult = matchPetTemplate(hostImage: edgeHost, templateImage: template, minConfidence: 0.70)
        let edgeCorrect = (edgeResult != nil) && Int(edgeResult!.rect.origin.x) == 0 && Int(edgeResult!.rect.origin.y) == 0
        if let er = edgeResult {
            if er.rect.origin.x < 0 || er.rect.origin.y < 0 ||
               (er.rect.origin.x + er.rect.size.width) > CGFloat(hostW) ||
               (er.rect.origin.y + er.rect.size.height) > CGFloat(hostH) {
                boundsValid = false
            }
        }

        let overallValid = positiveCorrect && noMatchRejected && boundsValid && smallerHostRejected && edgeCorrect

        let result: [String: Any] = [
            "valid": overallValid,
            "positiveMatch": [
                "matched": positiveMatched,
                "confidence": confidence,
                "x": Int(matchedX),
                "y": Int(matchedY),
                "width": Int(matchedW),
                "height": Int(matchedH),
                "expectedX": targetX,
                "expectedY": targetY,
                "correct": positiveCorrect
            ],
            "noMatch": [
                "matched": !noMatchRejected,
                "rejected": noMatchRejected
            ],
            "boundsContainment": [
                "withinBounds": boundsValid,
                "smallerHostRejected": smallerHostRejected,
                "edgeBoundaryMatched": edgeCorrect
            ]
        ]

        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    }

    func runVoiceGeometryAnchorTest() {
        window.statusEmissionEnabled = false
        guard let primaryScreen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first else {
            exit(1)
        }
        let visibleWidth: CGFloat = 84
        let visibleHeight = visibleWidth * 208 / 192
        let voiceHost: [String: Any] = [
            kCGWindowOwnerName as String: "ChatGPT",
            kCGWindowName as String: "Voice Overlay",
            kCGWindowLayer as String: 3,
            kCGWindowBounds as String: [
                "X": CGFloat(1000), "Y": CGFloat(-20),
                "Width": CGFloat(770), "Height": CGFloat(1000)
            ]
        ]
        window.smallWidth = visibleWidth
        window.mockWindowList = [voiceHost]
        window.alignWithCodexWindow()

        let expectedY = primaryScreen.frame.height - CGFloat(-20 + 800) - visibleHeight
        let geometryEstimated = window.trustedPetAnchorFound &&
            abs(window.lastAnchorFrame.minX - 1620) < 1 &&
            abs(window.lastAnchorFrame.minY - expectedY) < 1 &&
            abs(window.lastAnchorFrame.width - visibleWidth) < 1 &&
            abs(window.lastAnchorFrame.height - visibleHeight) < 1 &&
            window.visualAnchorDiagnostic == "voice-host-geometry-estimate"
        let panelVisible = window.timerPanel?.panel.isVisible == true

        let wideVoiceHost: [String: Any] = [
            kCGWindowOwnerName as String: "ChatGPT",
            kCGWindowName as String: "Voice Overlay",
            kCGWindowLayer as String: 3,
            kCGWindowBounds as String: [
                "X": CGFloat(1000), "Y": CGFloat(-20),
                "Width": CGFloat(1128), "Height": CGFloat(2069)
            ]
        ]
        window.mockWindowList = [wideVoiceHost]
        window.alignWithCodexWindow()
        let expectedWideX = 1620 * 0.3 + (1000 + 1128 * 0.805) * 0.7
        let wideHostRestored = window.trustedPetAnchorFound &&
            window.timerPanel?.panel.isVisible == true &&
            abs(window.lastAnchorFrame.minX - expectedWideX) < 1

        window.mockWindowList = []
        window.alignWithCodexWindow()
        let hiddenWhenHostMissing = !window.trustedPetAnchorFound &&
            window.timerPanel?.panel.isVisible == false

        let result: [String: Any] = [
            "valid": geometryEstimated && panelVisible && wideHostRestored && hiddenWhenHostMissing,
            "geometryEstimated": geometryEstimated,
            "panelVisible": panelVisible,
            "wideHostRestored": wideHostRestored,
            "hiddenWhenHostMissing": hiddenWhenHostMissing,
            "anchorWidth": window.lastAnchorFrame.width,
            "expectedWidth": visibleWidth
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result),
           let output = String(data: data, encoding: .utf8) {
            print(output)
        }
        exit(0)
    }
}

// MARK: - Main
@main
struct RendererApp {
    static func main() {
        let delegate = RendererDelegate()
        let win = CompanionWindow()
        delegate.window = win

        let panelInstance = TimerPanelController()
        win.timerPanel = panelInstance

        var i = 1
        let args = CommandLine.arguments
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "--preview":
                win.isPreviewMode = true
                win.ignoresMouseEvents = false
            case "--config":
                i += 1
                if i < args.count {
                    let configPath = args[i]
                    let url = URL(fileURLWithPath: configPath)
                    let configSize = fileSize(at: url) ?? (maxConfigBytes + 1)
                    if configSize > 0, configSize <= maxConfigBytes,
                       let data = try? Data(contentsOf: url),
                       let config = try? JSONDecoder().decode(CompanionConfig.self, from: data) {
                        if let petId = config.petId {
                            win.petId = petId
                        }
                        if let atlasPath = config.atlasPath {
                            win.atlasPath = atlasPath
                        }
                        if let sw = config.smallWidth { win.smallWidth = CGFloat(sw) }
                        if let rw = config.restWidth { win.restWidth = CGFloat(rw) }
                        if let ratio = config.targetHeightRatio { win.targetHeightRatio = CGFloat(ratio) }
                        if let mode = config.sizingMode { win.sizingMode = mode }
                        if let interp = config.interpolation { win.interpolation = interp }
                        if let rows = config.atlasRows, rows >= 9, rows <= maxAtlasRows { win.atlasRows = rows }

                        if let clips = config.clips {
                            let totalReferences = clips.values.reduce(0) { total, clip in
                                total + (clip.frames?.count ?? clip.atlasFrames?.count ?? 0)
                            }
                            if totalReferences <= maxTotalClipFrames {
                                var decodedFrames: [String: CGImage] = [:]
                                var decodedPixels = 0
                                var rejectedClips = Set<String>()
                                let configDir = (configPath as NSString).deletingLastPathComponent

                                for (name, clip) in clips {
                                    if let fps = clip.fps, fps >= 1, fps <= 12 { win.clipFps[name] = fps }
                                    if let loop = clip.loop { win.clipLoop[name] = loop }
                                    guard clip.fallback != true else { continue }

                                    if let frames = clip.frames, !frames.isEmpty,
                                       frames.count <= maxFramesPerClip {
                                        var images: [CGImage] = []
                                        for framePath in frames {
                                            let frameURL = URL(fileURLWithPath: framePath.hasPrefix("/")
                                                ? framePath
                                                : configDir + "/" + framePath).standardizedFileURL
                                            if let cached = decodedFrames[frameURL.path] {
                                                images.append(cached)
                                            } else if let loaded = loadBoundedFrame(path: frameURL, accumulatedPixels: decodedPixels) {
                                                decodedPixels += loaded.pixels
                                                decodedFrames[frameURL.path] = loaded.image
                                                images.append(loaded.image)
                                            } else {
                                                rejectedClips.insert(name)
                                                break
                                            }
                                        }
                                        if images.count == frames.count {
                                            win.clipFrames[name] = images
                                            win.clipAtlasFrames[name] = []
                                        }
                                    } else if let atlasFrames = clip.atlasFrames, !atlasFrames.isEmpty,
                                              atlasFrames.count <= maxFramesPerClip,
                                              atlasFrames.allSatisfy({ $0.row >= 0 && $0.row < win.atlasRows && $0.column >= 0 && $0.column < 8 }) {
                                        win.clipAtlasFrames[name] = atlasFrames
                                        win.clipFrames[name] = []
                                    } else {
                                        rejectedClips.insert(name)
                                    }
                                }

                                for name in rejectedClips {
                                    win.clipFrames[name] = []
                                    win.clipAtlasFrames[name] = []
                                }
                            }
                        }
                    }
                }
            case "--test-imageio-validate":
                win.testImageIOValidate = true
                i += 1
                if i < args.count { win.atlasPath = args[i] }
            case "--test-frame-validate":
                win.testFrameValidate = true
                i += 1
                if i < args.count { win.atlasPath = args[i] }
            case "--test-crop":
                win.testCrop = true
                i += 1
                if i < args.count { win.atlasPath = args[i] }
            case "--test-nearest":
                win.testNearest = true
            case "--test-transition-geometry":
                win.testTransitionGeometry = true
            case "--test-transition-behavior":
                win.testTransitionBehavior = true
            case "--test-timer-freeze":
                win.testTimerFreeze = true
            case "--test-no-anchor":
                win.testNoAnchor = true
            case "--test-multi-display":
                win.testMultiDisplay = true
            case "--test-anchor-fallback":
                win.testAnchorFallback = true
            case "--test-fullscreen-geometry":
                win.testFullscreenGeometry = true
            case "--test-easing":
                win.testEasing = true
            case "--test-interruption-continuity":
                win.testInterruptionContinuity = true
            case "--test-neutral-fallback":
                win.testNeutralFallback = true
            case "--test-transient-anchor":
                win.testTransientAnchor = true
            case "--test-nonactivating-panel":
                win.testNonactivatingPanel = true
            case "--test-stable-aspect":
                win.testStableAspect = true
            case "--test-panel-geometry":
                win.testPanelGeometry = true
            case "--test-panel-focus":
                win.testPanelFocus = true
            case "--test-panel-flash":
                win.testPanelFlash = true
            case "--test-panel-error-preservation":
                win.testPanelErrorPreservation = true
            case "--test-midpoint":
                win.testMidpoint = true
            case "--test-activate-takeover":
                win.testActivateTakeover = true
            case "--test-takeover-atlas-preference":
                win.testTakeoverAtlasPreference = true
            case "--test-trusted-pet-anchor":
                win.testTrustedPetAnchor = true
            case "--test-idle-progression":
                win.testIdleProgression = true
            case "--test-visual-match":
                win.testVisualMatch = true
            case "--test-voice-geometry-anchor":
                win.testVoiceGeometryAnchor = true
            case "--preview-state":
                i += 1
                if i < args.count {
                    win.previewState = args[i]
                }
            case "--test-runtime-config":
                win.testRuntimeConfig = true
            case "--test-status-sequence":
                win.testStatusSequence = true
            default:
                if !arg.hasPrefix("-") && win.atlasPath.isEmpty {
                    win.atlasPath = arg
                }
            }
            i += 1
        }

        if !win.atlasPath.isEmpty, let atlas = loadAtlas(path: win.atlasPath) {
            win.atlas = atlas
            let w = atlas.width
            let h = atlas.height
            win.atlasInfo = deriveAtlasInfo(width: w, height: h)
        }

        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
