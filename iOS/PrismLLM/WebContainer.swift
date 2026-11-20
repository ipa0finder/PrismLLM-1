import SwiftUI
import WebKit

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let bridge = Bridge()
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "native")
        let web = WKWebView(frame: .zero, configuration: cfg)
        bridge.web = web
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never   // lets CSS env(safe-area-inset-*) work
        web.scrollView.bounces = false
        let dir = Bundle.main.resourceURL!.appendingPathComponent("Web")
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        return web
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
