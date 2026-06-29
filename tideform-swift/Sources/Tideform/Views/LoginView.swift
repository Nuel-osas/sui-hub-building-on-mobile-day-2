//
//  LoginView.swift
//  Tideform · Views (UI)
//
//  Flow A (source-of-truth §9.A): native Google sign-in → custodial Sui wallet. The
//  Swift mirror of the Expo `app/login.tsx`.
//
//  There is no wallet extension on a phone (source-of-truth §12), so sign-in is the whole
//  on-ramp. GoogleSignIn-iOS yields a Google ID token → `zentos.signInWithGoogle` →
//  `POST /api/auth/google` mints/loads a custodial Sui wallet and sets a session cookie.
//  Same Google account → same Sui address forever (§6.1).
//
//  The headline UX is framed here up front: no seed phrase, no gas, no popups — the Zentos
//  backend sponsors and dual-signs every transaction (§6.2). All sign-in logic lives in
//  `AuthModel`; this screen is presentation + a button.
//

import Foundation
import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var auth: AuthModel

    private struct SellingPoint: Identifiable {
        let id = UUID()
        let icon: String
        let title: String
        let body: String
    }

    private let points: [SellingPoint] = [
        .init(
            icon: "bolt.fill",
            title: "Gasless",
            body: "A sponsor wallet pays every fee. You never hold or spend SUI."),
        .init(
            icon: "hand.raised.slash.fill",
            title: "Popup-less",
            body: "No \"approve in wallet\" prompts. The backend co-signs custodially."),
        .init(
            icon: "key.fill",
            title: "No seed phrase",
            body: "Sign in with Google. Same account → same Sui address, forever."),
    ]

    private var busy: Bool { auth.status == .signingIn }

    var body: some View {
        VStack(spacing: 24) {
            // Brand
            VStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 20)
                        .fill(Palette.primary.opacity(0.14))
                        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Palette.primary.opacity(0.4)))
                        .frame(width: 72, height: 72)
                    Image(systemName: "water.waves")
                        .font(.system(size: 34, weight: .heavy))
                        .foregroundStyle(Palette.primary)
                }
                Text("Tideform")
                    .font(.system(size: 32, weight: .heavy))
                    .foregroundStyle(Palette.text)
                Text("Walrus-native forms on Sui. Collect submissions on-chain — gasless and popup-less.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 8)
            }
            .padding(.top, 24)

            // Selling points
            VStack(spacing: 14) {
                ForEach(points) { p in
                    HStack(spacing: 14) {
                        Image(systemName: p.icon)
                            .font(.title3)
                            .foregroundStyle(Palette.primary)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.title)
                                .font(.callout.weight(.bold))
                                .foregroundStyle(Palette.text)
                            Text(p.body)
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
                }
            }

            Spacer(minLength: 0)

            // Footer: error / client-id warning / button / legal
            VStack(spacing: 12) {
                if let error = auth.error, !error.isEmpty {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Palette.danger)
                        .multilineTextAlignment(.center)
                }

                if !auth.ready {
                    Text("Set GOOGLE_CLIENT_ID in Config.xcconfig to enable Google sign-in (see README).")
                        .font(.caption)
                        .foregroundStyle(Palette.warn)
                        .multilineTextAlignment(.center)
                }

                Button {
                    Task { await auth.signIn() }
                } label: {
                    Group {
                        if busy {
                            ProgressView().tint(Palette.onPrimary)
                        } else {
                            Text("Continue with Google")
                                .font(.headline)
                                .foregroundStyle(Palette.onPrimary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Palette.primary, in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .disabled(!auth.ready || busy)
                .opacity((!auth.ready || busy) ? 0.5 : 1)

                Text("Custodial wallet by Zentos · \(hostOf(env.backendBaseUrl))")
                    .font(.caption2)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { Palette.bg.ignoresSafeArea() }
    }

    private func hostOf(_ url: String) -> String {
        url
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
