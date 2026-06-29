//
//  TideformApp.swift
//  Tideform · App layer (UI)
//
//  @main entry point. Mirrors the Expo `app/_layout.tsx` root router + auth guard:
//    1. Configure native Google sign-in (GoogleSignIn-iOS) from `env.googleClientId`.
//    2. Restore a persisted Zentos session on launch (GET /api/auth/me — see AuthModel).
//    3. Gate the route tree: unauthenticated -> LoginView, authenticated -> MyForms.
//
//  There is NO wallet extension on a phone (source-of-truth §12), so Google sign-in is
//  the whole on-ramp. The Lib layer (Sources/Tideform/Lib) supplies every backend call;
//  this layer is pure SwiftUI + view models over that surface.
//
//  Dependencies (added via SPM, see README): SuiKit (Lib only), GoogleSignIn + GoogleSignInSwift.
//

import SwiftUI
import GoogleSignIn

@main
struct TideformApp: App {

    /// Single source of session truth, injected into the whole tree.
    @StateObject private var auth = AuthModel()

    init() {
        // Configure GoogleSignIn from the iOS OAuth client id (Config.xcconfig -> Info.plist
        // -> env.googleClientId). The SKILL also reads GIDClientID directly from Info.plist;
        // setting it here keeps the client id in one place (`env`).
        // VERIFY: GoogleSignIn API — GIDConfiguration(clientID:) / GIDSignIn.sharedInstance on your pinned version.
        if !env.googleClientId.isEmpty {
            GIDSignIn.sharedInstance.configuration =
                GIDConfiguration(clientID: env.googleClientId)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                // OAuth callback comes back via the reversed-client-id URL scheme.
                .onOpenURL { url in
                    GIDSignIn.sharedInstance.handle(url)
                }
                // Rehydrate the persisted session exactly once on cold start.
                .task { await auth.restore() }
                .preferredColorScheme(.dark)
        }
    }
}

// MARK: - Root router + auth guard (mirrors app/_layout.tsx)

/// Navigation destinations carried by `NavigationStack`. Both flows (fill + inbox) hang
/// off a form id; reads are public so no extra auth is needed to open either.
enum Route: Hashable {
    case fill(formId: String)
    case inbox(formId: String)
}

struct RootView: View {
    @EnvironmentObject private var auth: AuthModel

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()

            switch auth.status {
            case .idle, .restoring:
                // Booting: resolving GET /api/auth/me before we know where to route.
                VStack(spacing: 12) {
                    ProgressView().tint(Palette.primary)
                    Text("Restoring session…")
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                }

            default:
                if auth.isAuthenticated {
                    NavigationStack {
                        MyFormsView()
                            .navigationDestination(for: Route.self) { route in
                                switch route {
                                case .fill(let formId):
                                    FormFillView(formId: formId)
                                case .inbox(let formId):
                                    InboxView(formId: formId)
                                }
                            }
                    }
                    .tint(Palette.primary)
                } else {
                    LoginView()
                }
            }
        }
    }
}

// MARK: - Shared theme (one palette reused by every view; mirrors the Expo `C` constants)

enum Palette {
    static let bg = Color(hex: 0x0B1221)
    static let surface = Color(hex: 0x121C32)
    static let surface2 = Color(hex: 0x0F1830)
    static let border = Color(hex: 0x26324B)
    static let text = Color(hex: 0xE7EEF8)
    static let muted = Color(hex: 0x94A3B8)
    static let primary = Color(hex: 0x2DD4BF)
    static let accent = Color(hex: 0x60A5FA)
    static let danger = Color(hex: 0xF87171)
    static let warn = Color(hex: 0xFBBF24)
    static let ok = Color(hex: 0x34D399)
    /// Text/icon color that sits on top of `primary` (the dark teal ink from the web app).
    static let onPrimary = Color(hex: 0x06291F)
}

extension Color {
    /// `Color(hex: 0x2DD4BF)` — convenience for the web palette above.
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha)
    }
}
