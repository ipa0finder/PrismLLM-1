import UIKit
import WebKit
import Security

/// JS <-> native bridge: haptics, Keychain secrets, file-backed docs, share sheet,
/// and a streaming fetch (URLSession) that avoids WebView CORS limits.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var web: WKWebView?
    private var tasks: [String: Task<Void, Never>] = [:]
    private let docs: URL = {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PrismLLM", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()

    private func nn(_ s: String?) -> Any { s.map { $0 as Any } ?? NSNull() }
    private func docURL(_ name: Any?) -> URL {
        let n = (name as? String ?? "x").replacingOccurrences(of: "/", with: "_")
        return docs.appendingPathComponent(n)
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let d = message.body as? [String: Any], let t = d["type"] as? String else {
            return replyHandler(nil, "bad message")
        }
        switch t {
        case "haptic": haptic(d["style"] as? String ?? "light"); replyHandler(true, nil)
        case "kv.get": replyHandler(nn(Keychain.get(d["k"] as? String ?? "")), nil)
        case "kv.set": Keychain.set(d["k"] as? String ?? "", d["v"] as? String ?? ""); replyHandler(true, nil)
        case "fs.read": replyHandler(nn(try? String(contentsOf: docURL(d["name"]), encoding: .utf8)), nil)
        case "fs.write":
            try? (d["v"] as? String ?? "").write(to: docURL(d["name"]), atomically: true, encoding: .utf8)
            replyHandler(true, nil)
        case "share": share(d["name"] as? String ?? "prismllm.json", d["text"] as? String ?? ""); replyHandler(true, nil)
        case "fetch": replyHandler(true, nil); start(d)
        case "abort": tasks[d["id"] as? String ?? ""]?.cancel(); replyHandler(true, nil)
        default: replyHandler(nil, "unknown type")
        }
    }

    private func haptic(_ s: String) {
        if s == "success" { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        else { UIImpactFeedbackGenerator(style: s == "medium" ? .medium : .light).impactOccurred() }
    }

    private func share(_ name: String, _ text: String) {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try? text.write(to: u, atomically: true, encoding: .utf8)
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        let vc = UIActivityViewController(activityItems: [u], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = root.view
        root.present(vc, animated: true)
    }

    private func emit(_ id: String, _ kind: String, _ data: Data) {
        web?.evaluateJavaScript("window.__nf('\(id)','\(kind)','\(data.base64EncodedString())')")
    }

    private func start(_ d: [String: Any]) {
        guard let id = d["id"] as? String, let s = d["url"] as? String, let url = URL(string: s) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = d["method"] as? String ?? "GET"
        req.timeoutInterval = 120
        (d["headers"] as? [String: String])?.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        if let b = d["body"] as? String { req.httpBody = Data(b.utf8) }
        tasks[id] = Task { [weak self] in
            do {
                let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                let http = resp as? HTTPURLResponse
                var hs: [String: String] = [:]
                http?.allHeaderFields.forEach { hs[String(describing: $0.key).lowercased()] = String(describing: $0.value) }
                let head = try JSONSerialization.data(withJSONObject: ["status": http?.statusCode ?? 0, "headers": hs])
                self?.emit(id, "head", head)
                var buf = Data()
                for try await b in bytes {
                    buf.append(b)
                    if b == 10 || buf.count > 4096 { self?.emit(id, "chunk", buf); buf.removeAll(keepingCapacity: true) }
                }
                if !buf.isEmpty { self?.emit(id, "chunk", buf) }
                self?.emit(id, "end", Data())
            } catch {
                self?.emit(id, "end", Data(error.localizedDescription.utf8))
            }
            self?.tasks[id] = nil
        }
    }
}

enum Keychain {
    private static func q(_ k: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "PrismLLM", kSecAttrAccount as String: k]
    }
    static func get(_ k: String) -> String? {
        var query = q(k)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var r: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &r) == errSecSuccess, let d = r as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func set(_ k: String, _ v: String) {
        SecItemDelete(q(k) as CFDictionary)
        var a = q(k)
        a[kSecValueData as String] = Data(v.utf8)
        a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(a as CFDictionary, nil)
    }
}
