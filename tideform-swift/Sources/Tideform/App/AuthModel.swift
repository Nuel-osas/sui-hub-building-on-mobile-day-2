//
//  AuthModel.swift
//  Tideform · App layer (UI)
//
//  The single source of session truth for the whole UI tree, mirroring the Expo
//  `lib/auth.ts` `useAuth` hook + store. Flow A (source-of-truth §9.A):
//
//    native Google sign-in (GoogleSignIn-iOS) -> Google ID-token JWT
//      -> zentos.signInWithGoogle(idToken:)  (POST /api/auth/google)
//      -> the Set-Cookie session is persisted by the shared cookie-aware URLSession
//         (`tideformURLSession` in ZentosClient.swift), so it survives relaunch.
//    On launch, `restore()` calls zentos.getMe() (GET /api/auth/me) to rehydrate.
//
//  There is NO wallet extension on a phone (source-of-truth §12) — Google sign-in is
//  the whole on-ramp. This object never touches keys or gas: signing + sponsorship are
//  backend-delegated (custodial), which is the entire point of the Day-2 model.
//
//  The UI layer only depends on `ZentosClient` (the Lib auth/sign surface); the Google
//  ID-token acquisition (GoogleSignIn-iOS) lives here because it is UI-presentational
//  (it needs a presenting view controller).
//

import Foundation
import SwiftUI
import GoogleSignIn
import UIKit

@MainActor
public final class AuthModel: ObservableObject {

    /// Mirrors the Expo `AuthStatus` union: idle | restoring | loading | authenticated
    /// | unauthenticated. `RootView` (TideformApp.swift) routes off `.idle`/`.restoring`
    /// (boot) vs. `isAuthenticated`.
    public enum Status: Equatable {
        case idle            // before launch restore has run
        case restoring       // GET /api/auth/me in flight
        case signingIn       // Google sign-in + POST /api/auth/google in flight
        case authenticated
        case unauthenticated
    }

    @Published public private(set) var status: Status = .idle
    @Published public private(set) var user: AuthUser?
    /// Last user-facing error (sign-in / restore). Cleared on each new attempt.
    @Published public var error: String?

    /// True only when we hold a live custodial session.
    public var isAuthenticated: Bool { status == .authenticated && user != nil }

    /// The Google sign-in button is only usable once an OAuth client id is configured
    /// (Config.xcconfig -> Info.plist -> env.googleClientId). Mirrors Expo `ready`.
    public var ready: Bool { !env.googleClientId.isEmpty }

    private let zentos: ZentosClient

    public init(zentos: ZentosClient = .shared) {
        self.zentos = zentos
    }

    // MARK: - Restore (launch) — GET /api/auth/me via the persisted cookie

    /// Rehydrate a persisted session exactly once on cold start. The HMAC session cookie
    /// set by `/api/auth/google` lives in `HTTPCookieStorage.shared` (disk-backed), so a
    /// plain `getMe()` "just works" on the next launch.
    public func restore() async {
        // Only restore from the initial boot state; don't clobber an in-progress sign-in.
        guard status == .idle else { return }
        status = .restoring
        error = nil
        do {
            let me = try await zentos.getMe()
            user = me
            status = .authenticated
        } catch ZentosError.notAuthenticated {
            user = nil
            status = .unauthenticated
        } catch {
            // Network hiccup on launch: land unauthenticated (the login screen can retry).
            user = nil
            status = .unauthenticated
            self.error = Self.describe(error)
        }
    }

    // MARK: - Sign in (Flow A) — Google ID token -> POST /api/auth/google

    public func signIn() async {
        guard ready else {
            error = "Set GOOGLE_CLIENT_ID in Config.xcconfig to enable Google sign-in (see README)."
            return
        }
        status = .signingIn
        error = nil
        do {
            let idToken = try await Self.fetchGoogleIdToken()
            let me = try await zentos.signInWithGoogle(idToken: idToken)
            user = me
            status = .authenticated
        } catch let e where Self.isUserCancellation(e) {
            // User backed out of the Google sheet — return to a clean state, no error.
            status = .unauthenticated
        } catch {
            self.error = Self.describe(error)
            status = .unauthenticated
        }
    }

    // MARK: - Sign out — POST /api/auth/logout (+ clears the local cookie)

    public func signOut() async {
        do {
            try await zentos.signOut()
        } catch {
            // Even if the network logout fails, drop the local session.
        }
        user = nil
        error = nil
        status = .unauthenticated
    }

    // MARK: - Native Google sign-in (UI-presentational)

    /// Canonical GoogleSignIn-iOS flow (swift-sui SKILL): present from the active window's
    /// root view controller, return the OpenID `idToken`. `GIDSignIn.configuration` is set
    /// once in `TideformApp.init` from `env.googleClientId`.
    ///
    /// VERIFY: GoogleSignIn API — `signIn(withPresenting:)` async variant + `result.user
    /// .idToken?.tokenString` are confirmed on GoogleSignIn-iOS 7.x; confirm on your pinned
    /// version. Default scopes (`openid email`) are all `/api/auth/google` needs.
    ///
    /// Audience gotcha (document it): the ID token's `aud` is your *iOS* OAuth client id, so
    /// the backend `/api/auth/google` verifier must accept it as an allowed audience.
    @MainActor
    private static func fetchGoogleIdToken() async throws -> String {
        guard
            let root = UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
                .first
        else {
            throw AuthError.noPresenter
        }

        let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: root)
        guard let idToken = result.user.idToken?.tokenString else {
            throw AuthError.noIdToken
        }
        return idToken
    }

    // MARK: - Error helpers

    /// GoogleSignIn reports a user-cancelled sheet as a `.canceled` error; treat it as a
    /// no-op rather than surfacing a scary message.
    /// VERIFY: GoogleSignIn API — cancel is domain "com.google.GIDSignIn", code -5 (.canceled).
    private static func isUserCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let ns = error as NSError
        return ns.domain == "com.google.GIDSignIn" && ns.code == -5
    }

    private static func describe(_ error: Error) -> String {
        if let z = error as? ZentosError { return z.description }
        return (error as NSError).localizedDescription
    }
}

/// Sign-in plumbing errors surfaced from the Google step.
public enum AuthError: Error, CustomStringConvertible {
    case noPresenter
    case noIdToken

    public var description: String {
        switch self {
        case .noPresenter: return "Couldn't find a window to present Google sign-in."
        case .noIdToken: return "Google sign-in returned no ID token."
        }
    }
}
