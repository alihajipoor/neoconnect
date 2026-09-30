import Foundation
import StoreKit

/// Buying a plan through the App Store.
///
/// The commands themselves live in NeoxifyVpnPlugin.swift, for the
/// reason written up beside them: Tauri dispatches dynamically, so a
/// method nothing references statically is dropped from the binary if
/// it sits in an extension of its own. This file holds the work they
/// call into, which is referenced and therefore linked.
///
/// The shape of the flow matters more than any of the code. StoreKit
/// takes the money and hands back a signed transaction; the server
/// verifies that signature and grants the subscription; and only then
/// is the transaction *finished*. Finishing is StoreKit's record that
/// the purchase has been delivered, and doing it before the server has
/// agreed would lose the sale entirely if the network dropped in
/// between -- the customer would be charged, own nothing, and have no
/// receipt left to replay. So an unfinished transaction is the safety
/// net, and `unfinishedTransactions` exists to pick one up on the next
/// launch.
enum StoreKitPurchases {
    struct ProductInfo: Encodable {
        let id: String
        let displayName: String
        /// Apple's own localised price string, already carrying the
        /// customer's currency and the conventions of their storefront.
        /// This is what has to be shown -- our own USD figure would be
        /// the wrong number in the wrong currency for most of the world,
        /// and Apple requires its price to be the one displayed.
        let displayPrice: String
    }

    static func products(ids: [String]) async throws -> [ProductInfo] {
        let found = try await Product.products(for: ids)
        // Ordered by the ids we asked for rather than by whatever
        // StoreKit returns, so the purchase screen does not reshuffle
        // itself between launches.
        return ids.compactMap { id in
            guard let p = found.first(where: { $0.id == id }) else { return nil }
            return ProductInfo(id: p.id, displayName: p.displayName, displayPrice: p.displayPrice)
        }
    }

    enum PurchaseOutcome {
        /// The JWS to send to the server, and the transaction to finish
        /// once the server has granted the subscription.
        case bought(jws: String, transactionId: UInt64)
        /// The customer backed out. Not an error.
        case cancelled
        /// Apple is waiting on someone else -- Ask to Buy, or a payment
        /// method that needs action. The purchase may still complete
        /// later, which is what makes this different from cancelled.
        case pending
    }

    static func purchase(productId: String) async throws -> PurchaseOutcome {
        guard let product = try await Product.products(for: [productId]).first else {
            throw PurchaseError.unknownProduct
        }

        switch try await product.purchase() {
        case .success(let verification):
            switch verification {
            case .verified(let transaction):
                return .bought(
                    jws: verification.jwsRepresentation,
                    transactionId: transaction.id
                )
            case .unverified:
                // StoreKit could not verify Apple's own signature. The
                // server would refuse it anyway -- it checks the same
                // signature against a pinned root -- so there is nothing
                // to gain by sending it and a failure here is clearer.
                throw PurchaseError.unverified
            }
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            throw PurchaseError.unknownResult
        }
    }

    /// Purchases StoreKit still considers undelivered.
    ///
    /// Non-renewing subscriptions do not appear in `currentEntitlements`
    /// -- Apple treats them as consumed once finished and leaves the
    /// record-keeping to us, which our own accounts already do. So this
    /// is not "restore my purchases": it is specifically the recovery
    /// path for a purchase that was paid for but never granted, because
    /// the app was killed or the network failed between the two.
    static func unfinishedTransactions() async -> [String] {
        var jwsList: [String] = []
        for await result in Transaction.unfinished {
            if case .verified = result {
                jwsList.append(result.jwsRepresentation)
            }
        }
        return jwsList
    }

    static func finish(transactionId: UInt64) async {
        for await result in Transaction.unfinished {
            if case .verified(let transaction) = result, transaction.id == transactionId {
                await transaction.finish()
                return
            }
        }
    }

    /// Finishes every transaction the server has already granted.
    ///
    /// Used after the recovery sweep: the ids come back from our own
    /// API, so finishing them is safe by definition.
    static func finishAll() async {
        for await result in Transaction.unfinished {
            if case .verified(let transaction) = result {
                await transaction.finish()
            }
        }
    }

    enum PurchaseError: LocalizedError {
        case unknownProduct
        case unverified
        case unknownResult

        var errorDescription: String? {
            switch self {
            case .unknownProduct: return "iap-unknown-product"
            case .unverified: return "iap-unverified"
            case .unknownResult: return "iap-failed"
            }
        }
    }
}
