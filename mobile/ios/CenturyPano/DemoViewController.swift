import UIKit
import WebKit

struct DemoOrigin: Equatable {
    let host: String
    let port: Int

    init?(url: URL) {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(),
              !host.isEmpty, url.user == nil, url.password == nil,
              (1...65535).contains(url.port ?? 443) else { return nil }
        self.host = host
        self.port = url.port ?? 443
    }

    var javascriptOrigin: String {
        let address = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "https://\(address)" + (port == 443 ? "" : ":\(port)")
    }

    func matches(_ url: URL?) -> Bool {
        guard let url else { return false }
        return DemoOrigin(url: url) == self
    }

    func matches(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol.lowercased() == "https" && origin.host.lowercased() == host
            && (origin.port == 0 ? 443 : origin.port) == port
    }
}

final class DemoViewController: UIViewController, UITextFieldDelegate {
    private let urlField = UITextField()
    private let explanation = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "CenturyPano"
        view.backgroundColor = .systemBackground

        let heading = UILabel()
        heading.text = "Open your historical street view"
        heading.font = .preferredFont(forTextStyle: .title1)
        heading.adjustsFontForContentSizeCategory = true
        heading.numberOfLines = 0

        let description = UILabel()
        description.text = "Paste an HTTPS demo link. After the page loads, tap Enable walking to start ARKit. The camera is used only for on-device position and orientation tracking."
        description.font = .preferredFont(forTextStyle: .body)
        description.adjustsFontForContentSizeCategory = true
        description.numberOfLines = 0

        urlField.placeholder = "https://…/world/"
        urlField.borderStyle = .roundedRect
        urlField.keyboardType = .URL
        urlField.autocorrectionType = .no
        urlField.autocapitalizationType = .none
        urlField.textContentType = .URL
        urlField.returnKeyType = .go
        urlField.delegate = self
        urlField.accessibilityLabel = "HTTPS demo link"
        urlField.clearButtonMode = .whileEditing

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Open demo"
        configuration.cornerStyle = .medium
        let open = UIButton(configuration: configuration)
        open.addTarget(self, action: #selector(openDemo), for: .touchUpInside)

        explanation.font = .preferredFont(forTextStyle: .footnote)
        explanation.textColor = .secondaryLabel
        explanation.numberOfLines = 0
        explanation.text = "The app does not save links or access codes. Returning to this screen, switching apps, or navigating stops the camera. Tracking requires a physical device that supports ARKit; the simulator can only display the webpage."

        let stack = UIStackView(arrangedSubviews: [heading, description, urlField, open, explanation])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
            urlField.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            open.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)
        ])
    }

    @objc private func openDemo() {
        let text = (urlField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 8192, let url = URL(string: text),
              let origin = DemoOrigin(url: url) else {
            explanation.text = "Enter a valid HTTPS link. HTTP and addresses containing a username or password are not supported."
            explanation.textColor = .systemRed
            return
        }
        urlField.resignFirstResponder()
        // Do not retain the access fragment in this form or UserDefaults.
        urlField.text = nil
        navigationController?.pushViewController(MotionViewController(url: url, origin: origin), animated: true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        openDemo()
        return true
    }
}
