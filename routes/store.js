/**
 * Owns: /api/store/* — Atlantist Asset Store marketplace API.
 * Does NOT own: file upload handler, Stripe webhook, frontend UI.
 */
const router = require('express').Router();
const { authMiddleware, optionalAuth } = require('./auth');
const {
  createAsset, getAssetById, getAssetBySlug, listStoreAssets, searchAssets,
  getMyAssets, getUploaderAssets, updateAsset, publishAsset,
  incrementAssetView, incrementAssetDownload, getAssetAnalytics, deleteAsset,
  createReview, getAssetReviews, deleteReview,
  createAcquisition, getAcquisition, getSellerTransactions,
  searchExternalAssets, listExternalAssetsByDistributor, searchExternalBySource,
  getCachedSearchResults, setCachedSearchResults,
  addToWishlist, getWishlist, removeFromWishlist,
  getAssetFilePath, getSellerPayoutSummary,
  getOrCreateCreatorPayout, recordStripeAcquisition, getMyLibrary,
  getCreatorStripeStatus,
} = require('../db/assets');
const { fetchAllAdapters, ALL_SOURCES } = require('../services/marketplace-adapters');

const R2_UPLOAD_URL = process.env.POLSIA_R2_UPLOAD_URL || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';
const R2_BASE_URL = process.env.POLSIA_R2_BASE_URL || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';
const { CANONICAL_ORIGIN: FRONTEND_URL } = require('../lib/canonical-url');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const PLATFORM_COMMISSION_PCT = 2; // 2% flat platform fee

function getStripe() {
  if (!STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

function getContentType(ext) {
  const map = {
    'dyn': 'application/octet-stream', 'gh': 'application/json', 'py': 'text/x-python',
    'ifc': 'model/ifc', 'obj': 'model/obj', 'gltf': 'model/gltf+json', 'glb': 'model/gltf-binary',
    'json': 'application/json', 'xml': 'application/xml', 'zip': 'application/zip',
    'rvt': 'application/octet-stream', 'skp': 'application/octet-stream',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    'pdf': 'application/pdf', 'mp4': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

async function generateR2SignedUrl(key) {
  // Atlantist R2 bucket is public — serve via public URL directly.
  // Phase 30b: no auth required for acquired assets, public URL is sufficient.
  // If bucket becomes private, swap this for S3 presigned URL generation via AWS SDK.
  const publicUrl = `${R2_BASE_URL}/${key}`;
  return publicUrl;
}

const CATEGORIES = ['Scripts', 'BIM Families', '3D Models', 'MEP Circuits', 'Materials', 'Templates', 'Plugins'];
const DISTRIBUTORS = ['BIMObject', 'Autodesk Exchange', 'Poliigon', 'TFHUB'];
const SORT_OPTIONS = ['newest', 'most_downloaded', 'top_rated', 'price_low', 'price_high'];

// ─── Store browse ─────────────────────────────────────────────────────────────

// GET /api/store — browse internal marketplace
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, tags, min_price, max_price, sort, page, q } = req.query;
    const result = await listStoreAssets({
      category: CATEGORIES.includes(category) ? category : undefined,
      tags: tags ? tags.split(',').filter(Boolean) : undefined,
      min_price: min_price !== undefined ? parseFloat(min_price) : undefined,
      max_price: max_price !== undefined ? parseFloat(max_price) : undefined,
      sort: SORT_OPTIONS.includes(sort) ? sort : 'newest',
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)),
    });
    res.json(result);
  } catch (err) {
    console.error('[store] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/search?q=&distributor=&category= — unified search (internal + external)
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, distributor, category, page } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const internal = q
      ? await searchAssets(q, { category: CATEGORIES.includes(category) ? category : undefined, page: p, limit })
      : await listStoreAssets({ category: CATEGORIES.includes(category) ? category : undefined, page: p, limit, sort: 'most_downloaded' });

    let external = [];
    if (!distributor || distributor === 'all' || distributor === 'external') {
      external = (await searchExternalAssets(q || '', {
        distributor: DISTRIBUTORS.includes(distributor) ? distributor : undefined,
        category: CATEGORIES.includes(category) ? category : undefined,
        page: p, limit,
      })).rows;
    }

    res.json({ internal: internal.rows || [], external, total: internal.total, page: p, limit });
  } catch (err) {
    console.error('[store] GET /search', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/external?distributor=&category= — external-only listing
router.get('/external', optionalAuth, async (req, res) => {
  try {
    const { distributor, category, q, page } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const result = await searchExternalAssets(q || '', {
      distributor: DISTRIBUTORS.includes(distributor) ? distributor : undefined,
      category: CATEGORIES.includes(category) ? category : undefined,
      page: p, limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)),
    });
    res.json(result);
  } catch (err) {
    console.error('[store] GET /external', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/categories — available categories + counts
router.get('/categories', async (_req, res) => {
  try {
    const result = await listStoreAssets({ sort: 'newest', limit: 1 });
    // Build category list from constants — counts computed separately if needed
    res.json(CATEGORIES.map(cat => ({ name: cat })));
  } catch (err) {
    console.error('[store] GET /categories', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/distributors — available external distributors
router.get('/distributors', async (_req, res) => {
  res.json(DISTRIBUTORS.map(d => ({ name: d })));
});

// ─── Asset detail ─────────────────────────────────────────────────────────────

// GET /api/store/asset/slug/:slug — slug-based asset lookup
router.get('/asset/slug/:slug', optionalAuth, async (req, res) => {
  try {
    const asset = await getAssetBySlug(req.params.slug);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.is_public || (req.user && req.user.id === asset.uploader_id)) {
      await incrementAssetView(asset.id);
      res.json(asset);
    } else {
      res.status(403).json({ error: 'Not authorized to view this asset' });
    }
  } catch (err) {
    console.error('[store] GET /asset/slug/:slug', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/asset/:id — single asset with preview
router.get('/asset/:id', optionalAuth, async (req, res) => {
  try {
    const asset = await getAssetById(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.is_public || (req.user && req.user.id === asset.uploader_id)) {
      await incrementAssetView(asset.id);
      res.json(asset);
    } else {
      res.status(403).json({ error: 'Not authorized to view this asset' });
    }
  } catch (err) {
    console.error('[store] GET /asset/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/asset/:id/reviews
router.get('/asset/:id/reviews', async (req, res) => {
  try {
    const reviews = await getAssetReviews(parseInt(req.params.id, 10));
    res.json(reviews);
  } catch (err) {
    console.error('[store] GET /asset/:id/reviews', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/asset/:id/reviews — submit a review
router.post('/asset/:id/reviews', authMiddleware, async (req, res) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    const asset = await getAssetById(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const { rating, body } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1–5' });
    }

    // Check buyer has acquired this asset
    const acquired = await getAcquisition(req.user.id, assetId);
    if (!acquired && req.user.id !== asset.uploader_id) {
      return res.status(403).json({ error: 'Purchase this asset before reviewing' });
    }

    const review = await createReview({ asset_id: assetId, reviewer_id: req.user.id, rating, body });
    res.status(201).json(review);
  } catch (err) {
    console.error('[store] POST /asset/:id/reviews', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload & manage (auth required) ──────────────────────────────────────────

// POST /api/store/assets — upload a new asset
router.post('/assets', authMiddleware, async (req, res) => {
  try {
    const { title, description, category, file_type, file_path,
            file_size_bytes, preview_url, version, compatibility, tags,
            price_usd, is_paid, is_public, license } = req.body;

    if (!title || !category || !file_type || !file_path) {
      return res.status(400).json({ error: 'title, category, file_type, and file_path are required' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }

    // Auto-generate slug: lowercase, hyphens, unique
    const baseSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    const asset = await createAsset({
      uploader_id: req.user.id,
      title, description, category, file_type, file_path,
      file_size_bytes: file_size_bytes ? parseInt(file_size_bytes, 10) : undefined,
      preview_url: preview_url || null,
      version: version || '1.0.0',
      compatibility: compatibility || null,
      tags: Array.isArray(tags) ? tags : (tags ? [tags] : []),
      price_usd: is_paid ? parseFloat(price_usd || '0') : 0,
      is_paid: is_paid || false,
      is_public: is_public || false,
      status: 'draft',
      license: license || 'royalty-free',
      slug,
    });
    res.status(201).json(asset);
  } catch (err) {
    console.error('[store] POST /assets', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/store/assets/:id — edit owned asset
router.patch('/assets/:id', authMiddleware, async (req, res) => {
  try {
    const asset = await getAssetById(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.uploader_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const updated = await updateAsset(asset.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[store] PATCH /assets/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/assets/:id/publish — publish (moderation queue bypass for Phase 30a)
router.post('/assets/:id/publish', authMiddleware, async (req, res) => {
  try {
    const asset = await getAssetById(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.uploader_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const published = await publishAsset(asset.id);
    res.json(published);
  } catch (err) {
    console.error('[store] POST /assets/:id/publish', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/assets/mine — list assets uploaded by current user
router.get('/assets/mine', authMiddleware, async (req, res) => {
  try {
    const assets = await getUploaderAssets(req.user.id);
    res.json(assets);
  } catch (err) {
    console.error('[store] GET /assets/mine', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/assets/my-acquisitions — list assets acquired by current user
router.get('/assets/my-acquisitions', authMiddleware, async (req, res) => {
  try {
    const assets = await getMyAssets(req.user.id);
    res.json(assets);
  } catch (err) {
    console.error('[store] GET /assets/my-acquisitions', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/assets/analytics — seller analytics dashboard
router.get('/assets/analytics', authMiddleware, async (req, res) => {
  try {
    const analytics = await getAssetAnalytics(req.user.id);
    const transactions = await getSellerTransactions(req.user.id);
    res.json({ ...analytics, transactions });
  } catch (err) {
    console.error('[store] GET /assets/analytics', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/assets/:id/acquire — free acquire OR init Stripe Checkout (2% commission)
router.post('/assets/:id/acquire', authMiddleware, async (req, res) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    const asset = await getAssetById(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const existing = await getAcquisition(req.user.id, assetId);
    if (existing) return res.status(409).json({ error: 'Already acquired', acquisition: existing });
    if (asset.uploader_id === req.user.id) return res.status(400).json({ error: 'Cannot acquire your own asset' });
    if (!asset.is_public || asset.status !== 'published') return res.status(400).json({ error: 'Asset is not available' });

    if (!asset.is_paid || parseFloat(asset.price_usd) === 0) {
      const acquisition = await createAcquisition({
        asset_id: assetId, buyer_id: req.user.id, seller_id: asset.uploader_id,
        amount_usd: 0, commission_pct: 0, net_usd: 0, status: 'acquired',
      });
      return res.json({ acquisition, is_free: true });
    }

    const listingPrice = parseFloat(asset.price_usd);
    const platformCommissionUsd = parseFloat((listingPrice * PLATFORM_COMMISSION_PCT / 100).toFixed(2));
    const creatorReceives = parseFloat((listingPrice - platformCommissionUsd).toFixed(2));

    // Itemized breakdown for buyer: asset + Stripe processing (2.9% + $0.30)
    const stripeFeeUsd = parseFloat((listingPrice * 0.029 + 0.30).toFixed(2));
    const buyerTotal = parseFloat((listingPrice + stripeFeeUsd).toFixed(2));

    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ error: 'Payment system not configured. Contact support@atlantist.cloud' });
    }

    // Get or create creator payout record to retrieve Stripe Connect account
    const creatorPayout = await getOrCreateCreatorPayout(asset.uploader_id);
    let applicationFeeAmount = Math.round(platformCommissionUsd * 100); // cents

    let paymentIntentParams = {
      amount: Math.round(buyerTotal * 100), // total charged to buyer (includes Stripe fees visible to buyer)
      currency: 'usd',
      metadata: {
        asset_id: assetId,
        buyer_id: req.user.id,
        seller_id: asset.uploader_id,
        listing_price_usd: listingPrice,
        platform_commission_usd: platformCommissionUsd,
        stripe_fee_usd: stripeFeeUsd,
        creator_payout_usd: creatorReceives,
        buyer_total_usd: buyerTotal,
      },
      description: `Atlantist Asset Store: ${asset.title}`,
    };

    if (creatorPayout?.stripe_connect_account_id && creatorPayout?.stripe_connect_onboarded) {
      // Use destination charges: creator receives their portion via Connect
      paymentIntentParams.application_fee_amount = applicationFeeAmount;
      paymentIntentParams.transfer_data = { destination: creatorPayout.stripe_connect_account_id };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      listing_price_usd: listingPrice,
      stripe_fee_usd: stripeFeeUsd,
      buyer_total_usd: buyerTotal,
      platform_commission_usd: platformCommissionUsd,
      creator_payout_usd: creatorReceives,
      asset_id: assetId,
      is_paid: true,
    });
  } catch (err) {
    console.error('[store] POST /assets/:id/acquire', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/store/assets/:id — delete owned asset
router.delete('/assets/:id', authMiddleware, async (req, res) => {
  try {
    const asset = await getAssetById(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.uploader_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const deleted = await deleteAsset(asset.id);
    res.json({ deleted: !!deleted });
  } catch (err) {
    console.error('[store] DELETE /assets/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────

// GET /api/store/wishlist
router.get('/wishlist', authMiddleware, async (req, res) => {
  try {
    const items = await getWishlist(req.user.id);
    res.json(items);
  } catch (err) {
    console.error('[store] GET /wishlist', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/wishlist — add item
router.post('/wishlist', authMiddleware, async (req, res) => {
  try {
    const { external_asset_id, internal_asset_id } = req.body;
    if (!external_asset_id && !internal_asset_id) {
      return res.status(400).json({ error: 'external_asset_id or internal_asset_id required' });
    }
    const item = await addToWishlist(req.user.id, { external_asset_id: external_asset_id ? parseInt(external_asset_id, 10) : null, internal_asset_id: internal_asset_id ? parseInt(internal_asset_id, 10) : null });
    res.status(201).json(item);
  } catch (err) {
    console.error('[store] POST /wishlist', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/store/wishlist/:id
router.delete('/wishlist/:id', authMiddleware, async (req, res) => {
  try {
    const removed = await removeFromWishlist(parseInt(req.params.id, 10), req.user.id);
    if (!removed) return res.status(404).json({ error: 'Wishlist item not found' });
    res.json({ removed: true });
  } catch (err) {
    console.error('[store] DELETE /wishlist/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── R2 Signed URL Download ───────────────────────────────────────────────────

// POST /api/store/assets/:id/download — record download + generate R2 signed URL
router.post('/assets/:id/download', authMiddleware, async (req, res) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    const asset = await getAssetById(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const acquired = await getAcquisition(req.user.id, assetId);
    const isOwner = req.user.id === asset.uploader_id;

    if (!acquired && !isOwner) {
      return res.status(403).json({ error: 'Acquire this asset before downloading' });
    }

    await incrementAssetDownload(assetId);

    // Generate R2 signed URL (1-hour expiry)
    const key = asset.file_path.replace(/^https?:\/\/[^/]+\//, '');
    const signedUrl = await generateR2SignedUrl(key);

    res.json({
      download_url: signedUrl,
      filename: `${asset.title.replace(/[/\\:*?"<>|\r?\n]/g, '_')}.${asset.file_type}`,
      asset_id: assetId,
      expires_in: 3600,
    });
  } catch (err) {
    console.error('[store] POST /assets/:id/download', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── R2 Upload Presigned URL ───────────────────────────────────────────────────

// GET /api/store/upload-url — generate R2 presigned PUT URL for direct browser upload
router.get('/upload-url', authMiddleware, async (req, res) => {
  try {
    const { filename, content_type } = req.query;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const ext = filename.split('.').pop().toLowerCase();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `assets/${req.user.id}/${Date.now()}_${safeFilename}`;

    const uploadUrl = `${R2_UPLOAD_URL}/${key}`;
    const contentType = content_type || getContentType(ext);

    res.json({
      upload_url: uploadUrl,
      file_key: key,
      public_url: `${R2_BASE_URL}/${key}`,
      content_type: contentType,
    });
  } catch (err) {
    console.error('[store] GET /upload-url', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Enhanced Seller Payout Dashboard ────────────────────────────────────────

// GET /api/store/assets/payout — detailed payout summary for seller dashboard
router.get('/assets/payout', authMiddleware, async (req, res) => {
  try {
    const summary = await getSellerPayoutSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    console.error('[store] GET /assets/payout', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stripe Connect — Creator Onboarding ────────────────────────────────────

// POST /api/store/connect/account-link — create Stripe Connect onboarding link
router.post('/connect/account-link', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment system not configured' });

    const creator = await getOrCreateCreatorPayout(req.user.id);

    let accountId = creator?.stripe_connect_account_id;
    let account;

    if (!accountId) {
      account = await stripe.accounts.create({
        type: 'express',
        email: req.user.email,
        metadata: { user_id: req.user.id, platform: 'atlantist_store' },
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      // Persist the account ID
      const { recordCreatorStripeId } = require('../db/assets');
      await recordCreatorStripeId(req.user.id, accountId);
    } else {
      account = await stripe.accounts.retrieve(accountId);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND_URL}/store/dashboard?connect=refresh`,
      return_url: `${FRONTEND_URL}/store/dashboard?connect=success`,
      type: 'account_onboarding',
    });

    res.json({
      url: accountLink.url,
      account_id: accountId,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
    });
  } catch (err) {
    console.error('[store] POST /connect/account-link', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/connect/status — check creator's Stripe Connect status
router.get('/connect/status', authMiddleware, async (req, res) => {
  try {
    const status = await getCreatorStripeStatus(req.user.id);
    res.json(status);
  } catch (err) {
    console.error('[store] GET /connect/status', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Buyer Library ───────────────────────────────────────────────────────────

// GET /api/store/library — list assets purchased by current user
router.get('/library', authMiddleware, async (req, res) => {
  try {
    const library = await getMyLibrary(req.user.id);
    res.json(library);
  } catch (err) {
    console.error('[store] GET /library', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Commission Info (public) ────────────────────────────────────────────────

// GET /api/store/commission-info — transparency data
router.get('/commission-info', async (_req, res) => {
  res.json({
    platform_commission_pct: PLATFORM_COMMISSION_PCT,
    stripe_processing_pct: 2.9,
    stripe_fixed_cents: 30,
    example: {
      listing_price_usd: 20,
      stripe_processing_usd: 0.88,
      buyer_pays_usd: 20.88,
      platform_commission_usd: 0.40,
      creator_receives_usd: 19.60,
    },
    smart_pricing_tiers: [
      { tier: 'free', min_price_usd: 0, max_price_usd: 0 },
      { tier: 'fixed', min_price_usd: 0.01, max_price_usd: null },
      { tier: 'smart', description: 'Self-correcting pricing for sub-$5 assets to prevent margin erosion from flat $0.30 Stripe fee' },
    ],
  });
});

// GET /api/store/config — frontend config (Stripe publishable key)
router.get('/config', async (_req, res) => {
  res.json({
    stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    platform_commission_pct: PLATFORM_COMMISSION_PCT,
    payment_enabled: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY),
  });
});

// ─── Federated Search (Phase 30B) ─────────────────────────────────────────────

const VALID_FORMATS = ['.rfa', '.ifc', '.skp', '.dyn', '.gh', '.stp', '.xml'];
const VALID_LICENSES = ['free', 'paid', 'cc0', 'royalty-free', 'custom'];
const VALID_DISCIPLINES = ['arch', 'struct', 'mep', 'landscape'];
const VALID_ASSET_TYPES = ['family', 'template', 'script', 'material', 'component'];

// Maps asset_type filter to internal categories
const ASSET_TYPE_CATEGORY_MAP = {
  family: 'BIM Families', template: 'Templates', script: 'Scripts',
  material: 'Materials', component: '3D Models',
};

// GET /api/store/federated-search — unified search across native + all 6 external sources
router.get('/federated-search', optionalAuth, async (req, res) => {
  const startMs = Date.now();
  const {
    q = '',
    asset_type,   // family|template|script|material|component
    format,       // .rfa|.ifc|.skp|.dyn|.gh
    discipline,   // arch|struct|mep|landscape
    license,      // free|paid
    source,       // native|external|all — default all
    page,
  } = req.query;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const limit = 12; // per source for external; 12 for native
  const queryStr = (q || '').trim().toLowerCase();

  const category = ASSET_TYPE_CATEGORY_MAP[asset_type] || undefined;
  const filterFormat = VALID_FORMATS.includes(format) ? format : undefined;
  const filterLicense = VALID_LICENSES.includes(license) ? license : undefined;
  const filterSource = source || 'all';

  // ── Cache key ──────────────────────────────────────────────────────────────
  const cacheKey = `federated:${queryStr}:${category || ''}:${filterFormat || ''}:${filterLicense || ''}:${filterSource}:${p}`;
  const cached = await getCachedSearchResults(cacheKey);
  if (cached) {
    return res.json({ ...cached, from_cache: true, elapsed_ms: Date.now() - startMs });
  }

  try {
    const results = { native: [], external: {}, sources_live: [], sources_db: [], elapsed_ms: 0 };

    // ── Native results ─────────────────────────────────────────────────────
    if (filterSource !== 'external') {
      const nativeRows = queryStr
        ? await searchAssets(queryStr, { category, page: p, limit })
        : await listStoreAssets({ category, page: p, limit, sort: 'most_downloaded' });
      results.native = (nativeRows.rows || []).map(a => ({
        id: a.id,
        source: 'Atlantist',
        is_native: true,
        name: a.title,
        description: a.description || '',
        thumbnail_url: a.preview_url || null,
        format: a.file_type ? `.${a.file_type}` : null,
        license: a.license || 'royalty-free',
        price: parseFloat(a.price_usd) || 0,
        price_label: parseFloat(a.price_usd) > 0 ? `$${parseFloat(a.price_usd).toFixed(2)}` : 'Free',
        slug: a.slug,
        internal_url: `/store/asset/${a.slug}`,
        external_url: null,
        tags: a.tags || [],
        category: a.category,
        rating_avg: a.rating_avg || null,
        download_count: a.download_count || 0,
      }));
    }

    // ── External: live adapter fetch ───────────────────────────────────────
    if (filterSource !== 'native' && queryStr) {
      const adapterResults = await fetchAllAdapters(queryStr, { limit });
      for (const { source: src, results: items, error } of adapterResults) {
        if (error) { console.warn(`[federated-search] adapter ${src} error:`, error); }
        if (items.length > 0) {
          results.sources_live.push(src);
          results.external[src] = items.map(item => ({ ...item, is_native: false }));
        }
      }
    }

    // ── External: DB-backed (pre-indexed) ─────────────────────────────────
    if (filterSource !== 'native') {
      const dbSourcesNeeded = ALL_SOURCES.filter(s => !results.sources_live.includes(s));
      for (const src of dbSourcesNeeded) {
        try {
          const { rows } = await searchExternalBySource(queryStr, {
            source: src, format: filterFormat, license: filterLicense, page: p, limit,
          });
          if (rows.length > 0) {
            results.sources_db.push(src);
            results.external[src] = (results.external[src] || []).concat(rows.map(r => ({
              id: r.id,
              source: r.distributor,
              is_native: false,
              name: r.name,
              description: r.description || '',
              thumbnail_url: r.preview_url || null,
              format: r.format || null,
              license: r.license || 'free',
              price: parseFloat(r.price_usd) || 0,
              price_label: (parseFloat(r.price_usd) > 0) ? `$${parseFloat(r.price_usd).toFixed(2)}` : 'Free',
              external_url: r.external_url,
              tags: r.tags || [],
              category: r.category,
            })));
          }
        } catch (dbErr) {
          console.warn(`[federated-search] db source ${src}:`, dbErr.message);
        }
      }
    }

    results.elapsed_ms = Date.now() - startMs;
    results.query = queryStr;
    results.page = p;
    results.sources_available = ALL_SOURCES;
    results.from_cache = false;

    // Cache for 24h (or 7d for empty results to avoid hammering)
    const ttl = Object.values(results.external).flat().length + results.native.length > 0 ? 24 : 1;
    await setCachedSearchResults(cacheKey, 'federated', results, ttl);

    res.json(results);
  } catch (err) {
    console.error('[store] GET /federated-search', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/store/sources — list all available sources with metadata
router.get('/sources', (_req, res) => {
  res.json(ALL_SOURCES.map(s => ({
    name: s,
    is_native: s === 'Atlantist',
    commission_note: s === 'Atlantist' ? '2% platform fee on paid transactions' : 'No commission — you transact directly on the original distributor\'s site',
  })));
});

module.exports = router;