# Auth Models · Day 1 zkLogin vs Day 2 Zentos Custodial

> Companion to [`00-architecture-source-of-truth.md`](./00-architecture-source-of-truth.md)
> (§11 is the canonical table) and [`02-zentos-and-sponsorship.md`](./02-zentos-and-sponsorship.md)
> (how the custodial model actually works on a phone).
>
> Day 1 taught **zkLogin** — a non-custodial, on-device wallet from a Google login. Day 2
> teaches the **Zentos custodial backend** and how a mobile app is *just a native client*
> over it. This doc puts the two side by side **honestly**: it names what each one trades
> away, says plainly that the Day-2 model is **centralized by design**, and gives you a rule
> for picking between them on mobile.
>
> **Scope note:** this build is the **direct Zentos custodial logic, nothing more.** There is
> no self-hosted prover, no GPU prover, and no "decentralized zkLogin" assembly anywhere in
> this repo or these docs (doc 00 §11 says so explicitly). If you came looking for that, it is
> not here on purpose — the mobile port stays deliberately small.

---

## 0. The one question both models answer

Both models answer exactly one question:

> *"How does a user who has only a Google account get a Sui address and authorize
> transactions — on a phone, with no wallet extension?"*

They answer it with opposite priorities:

```
   Day 1 — zkLogin                     Day 2 — Zentos custodial  (this repo)
   non-custodial, on-device            server holds the key, sponsored
   ─────────────────────────           ──────────────────────────────────
   maximize SELF-CUSTODY               maximize SIMPLICITY + UX
   user holds the key                  no seed phrase · no extension
   on-chain ZK proof of the JWT        no gas · no popups
   cost: on-device prover/salt deps    cost: you trust a server with the key
                                              (bounded by key export)
```

There is no universal winner. There is a **right pick per app and per audience**, and §5 is
the decision guide. Everything before it explains *why* the two sit where they sit.

---

## 1. The canonical comparison (extends doc 00 §11)

| | **Day 1 — zkLogin** | **Day 2 — Zentos custodial** *(this repo)* |
|---|---|---|
| Custody | **Non-custodial.** User holds an ephemeral key; the address is derived from the Google JWT + salt + a ZK proof | **Custodial.** The server holds an `Ed25519` key, **AES-256-GCM encrypted** in Postgres, keyed by the Google `sub` |
| Address derivation | `f(google sub, aud, salt)` via the zkLogin circuit | deterministic per Google `sub` — same Google account → **same Sui address forever** (doc 00 §6.1) |
| Where the secret lives | the **ephemeral key on the device**; the salt comes from a salt service | the **custodial key on the server**, decrypted in memory only to sign |
| What authorizes a tx | an **on-chain ZK proof** that "I hold a Google JWT for this address," verified natively by Sui | the **server** signs with the custodial key (it owns the key) + a valid **session cookie** (doc 00 §6.2) |
| Gas on mobile | user pays (unless separately sponsored) | **sponsored — user pays 0 SUI** via the gas sponsor (doc 00 §6.2) |
| Popups on mobile | proof + sign round-trips | **none** — the backend dual-signs and executes (doc 00 §6.2) |
| Mobile fit | a prover round-trip has to happen for the device | **a thin native client over a few HTTP routes — the simplest possible mobile dApp** |
| Who can sign for the user | **nobody but the user** (no server holds a key) | **the server can**, between sign-in and key export — *that is the definition of custodial* |
| Escape hatch | n/a (already self-custodial) | **`POST /api/wallet/export` → Bech32 `suiprivkey1…`** — walk to self-custody any time (doc 00 §6.2) |
| Status | **built** (Day 1 repo) | **built & live** (this repo, `tidalform.xyz`) |
| Where | Day 1 repo | this repo |

> The two rows that students skip and shouldn't are **"Who can sign for the user"** and
> **"Escape hatch."** Together they *are* the trade: Day 2 lets a server sign for the user,
> and the export route is the bound on that trade. Read them out loud when you teach this.

---

## 2. Day 1 — zkLogin (non-custodial, on-device)

**The idea.** A user signs in with Google. Their Sui address is derived from the Google JWT
(`sub`, `aud`) plus a user-specific **salt**, and transactions are authorized by a
**zero-knowledge proof** that *"I hold a Google JWT for this address"* — verified **on-chain**
by Sui's native zkLogin support. The user's spending key is an **ephemeral key generated on
the device**; no server can sign for them.

**Why it is the gold standard.** Nobody — not Mysten, not the app, not a salt service — can
move the user's funds. Custody is genuinely the user's. This is what Day 1 built, and it is
the strongest custody story a Google-login wallet can offer.

**Why it is heavier on a phone.** Producing the ZK proof requires a **prover** that the device
round-trips to, and the **salt** must be fetched. Custody does not depend on those services,
but **liveness does** — if the prover or salt service is down, the user can't sign even though
they fully own their key. On mobile, that prover round-trip is the friction point (doc 00 §11:
*"prover round-trips on device"*).

**One-line takeaway:** *maximum self-custody, more on-device machinery and liveness
dependencies.*

---

## 3. Day 2 — Zentos custodial (server-held key, sponsored)

**The idea.** Covered in full in [doc 02](./02-zentos-and-sponsorship.md). The same Google
account always maps to the same Sui address. The key is minted and **held server-side**,
**AES-256-GCM encrypted** in Postgres keyed by the Google `sub` (doc 00 §6.1). The phone
builds an *intent* (a PTB's kind bytes) and POSTs it; the server decrypts the key in memory,
**dual-signs as the user (sender) and as a gas sponsor**, pays gas, and executes. The user
spends **0 SUI** and sees **0 popups** (doc 00 §6.2). The only thing the phone persists is a
session cookie (doc 02 §6) — never a key.

**Why it is the right Day-2 teaching choice.** It is the **simplest possible mobile dApp**: no
prover, no salt service, no wallet SDK, no key handling on the device at all. A phone is *just
a client* over a handful of HTTP routes (doc 00 §6). For a workshop whose whole point is
*"a mobile dApp is mostly a re-skin of the same web client"* (doc 01), this removes every
distraction except the one that matters — **where the trust boundary sits.**

### 3.1 Say it plainly: custodial = centralized by design

Do not soften this. Between sign-in and key export, **the server can sign for the user.** That
is not a bug or a temporary shortcut — it is the model. Zentos is a *custodial* wallet, which
means the operator holds the key, which means the operator is a trusted party. **Centralized
by design.**

And for **consumer onboarding, that is the right trade.** The thing standing between a normal
person and their first on-chain action is not decentralization purity — it is friction. The
custodial model deletes the four worst sources of that friction at once:

- **No seed phrase** to write down, lose, or get phished out of.
- **No browser extension / wallet app** to install — there is no wallet extension on a phone
  anyway (doc 00 §12), which is the whole reason this model exists on mobile.
- **No gas** — the sponsor pays, the user holds 0 SUI (doc 00 §6.2).
- **No popups** — the backend signs; the user just taps and it's done (doc 00 §6.2).

That is a sign-in-with-Google experience that happens to be on-chain. For the audience you are
trying to onboard, that beats a more-decentralized model they never finish setting up.

### 3.2 The bound on the trade: the export escape hatch

Custodial is centralized, but it is **bounded** — the user is never locked in:

```
POST {backendBaseUrl}/api/wallet/export     (cookie)
→ 200  a Bech32 self-custody private key:  "suiprivkey1…"
```

`/api/wallet/export` hands the user their actual key as a Bech32 `suiprivkey1…` string
(doc 00 §6.2). They can import it into any standard Sui wallet and **walk away from the
custodian whenever they want.** In the shipped mobile client this is one method on the Zentos
client:

```ts
// lib/api.ts — ZentosClient
/** Self-custody escape hatch — returns a Bech32 `suiprivkey1…` string. */
async exportKey(): Promise<{ privateKey: string }> {
  return this.postJson<{ privateKey: string }>('/api/wallet/export', {});
}
```

Three things together make the trade defensible — but **none of them erase it**:

1. **Export exists** — a real self-custody exit (`suiprivkey1…`), the most important one.
2. **The key is encrypted at rest** — AES-256-GCM, keyed per Google `sub` (doc 00 §6.1).
3. **A Move-target allowlist** — `/api/wallet/sign` only honors Tideform/Zentos package
   targets, so a leaked session can't drain the gas sponsor with arbitrary PTBs (doc 00 §6.2).

The honest sentence to leave in the room: *"The server can sign for you until you export — and
you can export at any time."* That is the entire custody story; don't dress it up, and don't
apologize for it either.

**One-line takeaway:** *maximum simplicity and consumer-grade UX, at the explicit, bounded cost
of trusting a server with the key (export is the exit).*

---

## 4. The dimension that actually separates them

Strip away gas, popups, provers, and SDKs, and one axis is left:

> **Who can sign for the user?**

| | Day 1 zkLogin | Day 2 Zentos custodial |
|---|---|---|
| Can the **user** sign? | yes (ephemeral key on device) | yes (via the backend, with the cookie) |
| Can the **operator** sign without the user? | **no** — no server holds a key | **yes** — until the user exports |
| What bounds the operator's power? | n/a | **key export** + AES-at-rest + Move-target allowlist |

Everything else — sponsorship, no popups, no seed phrase — is a UX layer that *either* model
could in principle adopt. The thing you genuinely choose between is **custody**: does a server
ever hold a key that can move the user's assets? Day 1 says never; Day 2 says yes-but-bounded.
Be precise about that one row and the rest of the conversation gets easy.

---

## 5. How to choose on mobile (decision guide)

| If you want… | Pick | Why |
|---|---|---|
| Maximum self-custody, an audience that values it, and you can tolerate prover/salt **liveness** dependencies on the device | **Day 1 zkLogin** | nobody can sign for the user — custody is genuinely theirs |
| The **simplest** mobile dApp, **one-tap gasless** UX, the fastest path to ship, and you accept trusting a server **with export as the escape hatch** | **Day 2 Zentos custodial** | a phone is *just a client* over a few HTTP routes (doc 01); no key, prover, or wallet SDK on the device |

A sharper way to decide:

- **Onboarding a mainstream consumer** who has never held crypto, on a phone, where the goal
  is "tap and it works"? → **Zentos custodial.** No seed phrase, no extension, no gas, no
  popups — and they can export later if they fall in love with self-custody.
- **Serving crypto-natives, high-value funds, or a "not your keys, not your coins" audience**?
  → **zkLogin.** The liveness cost of the prover is worth paying so that no operator can ever
  sign for the user.

For **this workshop's mobile port, Day 2 (Zentos custodial) is the default** — it lets the
class focus on the real lesson (the trust boundary and the gasless `/api/wallet/sign` seam,
doc 01–02) without prover or salt plumbing. The build is intentionally the **direct custodial
logic only**.

---

## 6. Leave-with summary

- **Day 1 zkLogin** = non-custodial, the user holds the key, an on-chain ZK proof of the Google
  JWT authorizes transactions; the cost is on-device prover/salt **liveness**. *Built.*
- **Day 2 Zentos** = custodial, the server holds an AES-256-GCM-encrypted key and **dual-signs
  as user + sponsor** for a **0-gas, 0-popup, no-seed-phrase, no-extension** experience;
  **centralized by design and the right trade for consumer onboarding**, bounded by
  `POST /api/wallet/export` → `suiprivkey1…`. *Built & live; the model this repo ships.*
- The one axis that actually separates them is **who can sign for the user** — Day 1: nobody
  but the user; Day 2: the server, until export.
- This mobile port is the **direct Zentos custodial logic, nothing more** — no self-hosted
  prover, no decentralized-zkLogin machinery (doc 00 §11).
