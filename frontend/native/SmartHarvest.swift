import AppKit
import UniformTypeIdentifiers
import WebKit

let symbols = [
    "square.grid.2x2", "chart.line.uptrend.xyaxis", "basket", "shippingbox", "leaf",
    "list.bullet.clipboard", "bubble.left", "arrow.triangle.2.circlepath", "calendar",
    "chevron.down", "chevron.left", "chevron.right", "arrow.up.right", "arrow.right", "plus",
    "exclamationmark.triangle", "checkmark.circle", "antenna.radiowaves.left.and.right",
    "person.crop.circle", "doc.text", "checkmark"
]

func symbolData(_ name: String) -> String? {
    let configuration = NSImage.SymbolConfiguration(pointSize: 34, weight: .medium)
    guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration),
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }

    let scale = 52 / max(image.size.width, image.size.height)
    let width = image.size.width * scale
    let height = image.size.height * scale
    let rect = NSRect(x: (64 - width) / 2, y: (64 - height) / 2, width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    return bitmap.representation(using: .png, properties: [:]).map {
        "data:image/png;base64," + $0.base64EncodedString()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow?
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        var images: [String: String] = [:]
        for name in symbols {
            images[name] = symbolData(name)
        }
        let configuration = WKWebViewConfiguration()
        if let bytes = try? JSONSerialization.data(withJSONObject: images),
            let json = String(data: bytes, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.smartHarvestSymbols = " + json,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }

        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.load(URLRequest(url: url))

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "SmartHarvest"
        window.contentMinSize = NSSize(width: 360, height: 480)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let destination = action.request.url
        let local = destination?.host == url.host && destination?.port == url.port && destination?.scheme == url.scheme
        guard local else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let window else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let window else {
            completionHandler(nil)
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let address = ProcessInfo.processInfo.environment["SMARTHARVEST_URL"] ?? "http://127.0.0.1:5173"
guard let localURL = URL(string: address), localURL.scheme == "http",
    localURL.host == "127.0.0.1", localURL.port != nil else {
    fputs("Set SMARTHARVEST_URL to the local Vite URL, e.g. http://127.0.0.1:5173.\n", stderr)
    exit(EXIT_FAILURE)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate(url: localURL)
app.delegate = delegate
app.run()
