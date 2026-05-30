/**
 * Owns: all DB queries for the Atlantist Asset Store.
 * Does NOT own: file upload/storage, HTTP routing, Stripe integration.
 */
const pool = require('./index');

// ─── Assets ──────────────────────────────────────────────────────────────────

async function createAsset(data) {
  const { uploader_id, title, description, category, file_type, file_path,
          file_size_bytes, preview_url, version, compatibility, tags,
          price_usd, is_paid, is_public, status, license, slug } = data;
  const res = await pool.query(
    `INSERT INTO assets (uploader_id, title, description, category, file_type, file_path,
                         file_size_bytes, preview_url, version, compatibility, tags,
                         price_usd, is_paid, is_public, status, license, slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [uploader_id, title, description || null, category, file_type, file_path,
     file_size_bytes || null, preview_url || null, version || '1.0.0',
     compatibility || null, tags || [], price_usd || 0,
     is_paid || false, is_public || false, status || 'draft',
     license || 'royalty-free', slug || null]
  );
  return res.rows[0];
}

async function getAssetById(id) {
  const res = await pool.query(`
    SELECT a.*, u.email AS uploader_email, u.name AS uploader_name
    FROM assets a
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE a.id = $1
  `, [id]);
  return res.rows[0] || null;
}

async function getAssetBySlug(slug) {
  const res = await pool.query(`
    SELECT a.*, u.email AS uploader_email, u.name AS uploader_name
    FROM assets a
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE a.slug = $1 AND a.status = 'published'
  `, [slug]);
  return res.rows[0] || null;
}

async function listStoreAssets({ category, tags, min_price, max_price,
                                 sort = 'newest', page = 1, limit = 20, uploader_id } = {}) {
  const offset = (page - 1) * limit;
  const conditions = ['a.is_public = true', "a.status = 'published'"];
  const params = [];
  let p = 1;

  if (category) { conditions.push(`a.category = $${p++}`); params.push(category); }
  if (tags && tags.length) {
    conditions.push(`a.tags && $${p++}`);
    params.push(tags);
  }
  if (min_price !== undefined) { conditions.push(`a.price_usd >= $${p++}`); params.push(min_price); }
  if (max_price !== undefined) { conditions.push(`a.price_usd <= $${p++}`); params.push(max_price); }
  if (uploader_id) { conditions.push(`a.uploader_id = $${p++}`); params.push(uploader_id); }

  const orderMap = {
    newest: 'a.created_at DESC',
    most_downloaded: 'a.download_count DESC',
    top_rated: 'a.rating_avg DESC NULLS LAST',
    price_low: 'a.price_usd ASC',
    price_high: 'a.price_usd DESC',
  };
  const orderBy = orderMap[sort] || 'a.created_at DESC';

  const where = conditions.join(' AND ');

  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM assets a WHERE ${where}`, params);
  const res = await pool.query(`
    SELECT a.*, u.email AS uploader_email, u.name AS uploader_name,
           COALESCE(a.rating_avg, 0) AS rating_avg
    FROM assets a
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT $${p++} OFFSET $${p++}
  `, [...params, limit, offset]);

  return { rows: res.rows, total: parseInt(countRes.rows[0].total, 10), page, limit };
}

async function searchAssets(query, { category, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  // WHY: $1 must appear in WHERE so Postgres can bind the parameter for both count + result queries
  const conditions = [
    'a.is_public = true',
    "a.status = 'published'",
    `(a.title ILIKE '%' || $1 || '%' OR a.description ILIKE '%' || $1 || '%' OR $1 = ANY(a.tags))`,
  ];
  const params = [query];
  let p = 2;
  if (category) { conditions.push(`a.category = $${p++}`); params.push(category); }
  const where = conditions.join(' AND ');
  const limitIdx = p++;
  const offsetIdx = p++;
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM assets a WHERE ${where}`, params);
  const res = await pool.query(`
    SELECT a.*, u.name AS uploader_name,
           COALESCE(a.rating_avg, 0) AS rating_avg
    FROM assets a
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE ${where}
    ORDER BY a.download_count DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, [...params, limit, offset]);
  return { rows: res.rows, total: parseInt(countRes.rows[0].total, 10), page, limit };
}

async function getMyAssets(userId) {
  const res = await pool.query(`
    SELECT a.*, aa.acquired_at,
           CASE WHEN aa.amount_usd > 0 THEN true ELSE false END AS was_paid,
           aa.stripe_payment_id
    FROM asset_acquisitions aa
    JOIN assets a ON aa.asset_id = a.id
    WHERE aa.buyer_id = $1
    ORDER BY aa.acquired_at DESC
  `, [userId]);
  return res.rows;
}

async function getUploaderAssets(userId) {
  const res = await pool.query(`
    SELECT a.*, u.name AS uploader_name
    FROM assets a
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE a.uploader_id = $1
    ORDER BY a.created_at DESC
  `, [userId]);
  return res.rows;
}

async function updateAsset(id, data) {
  const { title, description, tags, price_usd, is_paid, is_public, status,
          preview_url, version, compatibility } = data;
  const fields = [];
  const params = [];
  let p = 1;
  if (title !== undefined) { fields.push(`title = $${p++}`); params.push(title); }
  if (description !== undefined) { fields.push(`description = $${p++}`); params.push(description); }
  if (tags !== undefined) { fields.push(`tags = $${p++}`); params.push(tags); }
  if (price_usd !== undefined) { fields.push(`price_usd = $${p++}`); params.push(price_usd); }
  if (is_paid !== undefined) { fields.push(`is_paid = $${p++}`); params.push(is_paid); }
  if (is_public !== undefined) { fields.push(`is_public = $${p++}`); params.push(is_public); }
  if (status !== undefined) { fields.push(`status = $${p++}`); params.push(status); }
  if (preview_url !== undefined) { fields.push(`preview_url = $${p++}`); params.push(preview_url); }
  if (version !== undefined) { fields.push(`version = $${p++}`); params.push(version); }
  if (compatibility !== undefined) { fields.push(`compatibility = $${p++}`); params.push(compatibility); }
  if (!fields.length) return null;
  fields.push('updated_at = NOW()');
  params.push(id);
  const res = await pool.query(
    `UPDATE assets SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

async function publishAsset(id) {
  const res = await pool.query(
    `UPDATE assets SET status = 'published', is_public = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

async function incrementAssetView(id) {
  await pool.query(`UPDATE assets SET view_count = view_count + 1 WHERE id = $1`, [id]);
}

async function incrementAssetDownload(id) {
  const res = await pool.query(
    `UPDATE assets SET download_count = download_count + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0];
}

async function getAssetAnalytics(uploaderId) {
  const res = await pool.query(`
    SELECT
      COUNT(*) AS total_listings,
      SUM(download_count) AS total_downloads,
      SUM(total_revenue) AS total_revenue,
      SUM(view_count) AS total_views,
      AVG(rating_avg) FILTER (WHERE rating_avg > 0) AS avg_rating,
      SUM(review_count) AS total_reviews
    FROM assets
    WHERE uploader_id = $1 AND is_public = true
  `, [uploaderId]);
  return res.rows[0];
}

async function deleteAsset(id) {
  const res = await pool.query(`DELETE FROM assets WHERE id = $1 RETURNING *`, [id]);
  return res.rows[0] || null;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

async function createReview(data) {
  const { asset_id, reviewer_id, rating, body } = data;
  const res = await pool.query(
    `INSERT INTO asset_reviews (asset_id, reviewer_id, rating, body) VALUES ($1, $2, $3, $4) RETURNING *`,
    [asset_id, reviewer_id, rating, body || null]
  );
  // Update asset rating aggregate
  await pool.query(`
    UPDATE assets SET
      rating_avg = (SELECT AVG(rating)::DECIMAL(3,2) FROM asset_reviews WHERE asset_id = $1),
      review_count = (SELECT COUNT(*) FROM asset_reviews WHERE asset_id = $1),
      updated_at = NOW()
    WHERE id = $1
  `, [asset_id]);
  return res.rows[0];
}

async function getAssetReviews(assetId) {
  const res = await pool.query(`
    SELECT ar.*, u.name AS reviewer_name, u.email AS reviewer_email
    FROM asset_reviews ar
    LEFT JOIN users u ON ar.reviewer_id = u.id
    WHERE ar.asset_id = $1
    ORDER BY ar.created_at DESC
  `, [assetId]);
  return res.rows;
}

async function deleteReview(id) {
  const res = await pool.query(`DELETE FROM asset_reviews WHERE id = $1 RETURNING *`, [id]);
  return res.rows[0] || null;
}

// ─── Acquisitions ─────────────────────────────────────────────────────────────

async function createAcquisition(data) {
  const { asset_id, buyer_id, seller_id, amount_usd, commission_pct, net_usd,
          stripe_payment_id, status } = data;
  const commission_usd = parseFloat((amount_usd * (commission_pct / 100)).toFixed(2));
  const res = await pool.query(
    `INSERT INTO asset_acquisitions (asset_id, buyer_id, seller_id, amount_usd, commission_pct, commission_usd, net_usd, stripe_payment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [asset_id, buyer_id, seller_id, amount_usd, commission_pct || 10, commission_usd, net_usd || amount_usd, stripe_payment_id || null, status || 'acquired']
  );
  // Update asset revenue + download count
  await pool.query(`
    UPDATE assets SET
      download_count = download_count + 1,
      total_revenue = total_revenue + $2,
      updated_at = NOW()
    WHERE id = $1
  `, [asset_id, amount_usd]);
  return res.rows[0];
}

async function getAcquisition(buyerId, assetId) {
  const res = await pool.query(
    `SELECT * FROM asset_acquisitions WHERE buyer_id = $1 AND asset_id = $2`,
    [buyerId, assetId]
  );
  return res.rows[0] || null;
}

async function getSellerTransactions(sellerId) {
  const res = await pool.query(`
    SELECT aa.*, a.title AS asset_title, a.preview_url,
           u.name AS buyer_name, u.email AS buyer_email
    FROM asset_acquisitions aa
    JOIN assets a ON aa.asset_id = a.id
    LEFT JOIN users u ON aa.buyer_id = u.id
    WHERE a.uploader_id = $1
    ORDER BY aa.acquired_at DESC
  `, [sellerId]);
  return res.rows;
}

// ─── External Assets ───────────────────────────────────────────────────────────

async function searchExternalAssets(query, { distributor, category, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let p = 1;

  if (query) {
    conditions.push(`(name ILIKE '%' || $${p} || '%' OR description ILIKE '%' || $${p} || '%')`);
    params.push(query);
    p++;
  }
  if (distributor) { conditions.push(`distributor = $${p++}`); params.push(distributor); }
  if (category) { conditions.push(`category = $${p++}`); params.push(category); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Snapshot p before template-literal post-increments to avoid eval-order ambiguity
  const limitIdx = p++;
  const offsetIdx = p++;
  try {
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM external_assets ${where}`, params);
    const res = await pool.query(`
      SELECT * FROM external_assets ${where}
      ORDER BY indexed_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...params, limit, offset]);
    return { rows: res.rows, total: parseInt(countRes.rows[0].total, 10), page, limit };
  } catch (err) {
    // Graceful fallback — external asset search is non-critical
    console.warn('[assets] searchExternalAssets error:', err.message);
    return { rows: [], total: 0, page, limit };
  }
}

async function listExternalAssetsByDistributor(distributor, { limit = 20 } = {}) {
  const res = await pool.query(`
    SELECT * FROM external_assets WHERE distributor = $1 ORDER BY name LIMIT $2
  `, [distributor, limit]);
  return res.rows;
}

async function upsertExternalAsset(data) {
  const { distributor, external_id, name, description, category, tags, price_usd,
          preview_url, external_url, distributor_logo_url } = data;
  const res = await pool.query(`
    INSERT INTO external_assets (distributor, external_id, name, description, category, tags, price_usd, preview_url, external_url, distributor_logo_url, indexed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (distributor, external_id) DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description,
      category = EXCLUDED.category, tags = EXCLUDED.tags,
      price_usd = EXCLUDED.price_usd, preview_url = EXCLUDED.preview_url,
      external_url = EXCLUDED.external_url, distributor_logo_url = EXCLUDED.distributor_logo_url,
      indexed_at = NOW()
    RETURNING *
  `, [distributor, external_id, name, description || null, category, tags || [], price_usd || null, preview_url || null, external_url, distributor_logo_url || null]);
  return res.rows[0];
}

// ─── Wishlist ──────────────────────────────────────────────────────────────────

async function addToWishlist(userId, { external_asset_id, internal_asset_id }) {
  const res = await pool.query(
    `INSERT INTO asset_wishlist (user_id, external_asset_id, internal_asset_id) VALUES ($1, $2, $3) RETURNING *`,
    [userId, external_asset_id || null, internal_asset_id || null]
  );
  return res.rows[0];
}

async function getWishlist(userId) {
  const res = await pool.query(`
    SELECT
      aw.id, aw.created_at,
      ea.distributor, ea.external_id, ea.name AS asset_name, ea.description AS asset_description,
      ea.category, ea.price_usd, ea.preview_url, ea.external_url, ea.distributor_logo_url,
      a.title AS internal_title, a.preview_url AS internal_preview, a.category AS internal_category,
      a.price_usd AS internal_price, a.is_paid AS internal_is_paid
    FROM asset_wishlist aw
    LEFT JOIN external_assets ea ON aw.external_asset_id = ea.id
    LEFT JOIN assets a ON aw.internal_asset_id = a.id
    WHERE aw.user_id = $1
    ORDER BY aw.created_at DESC
  `, [userId]);
  return res.rows;
}

async function removeFromWishlist(id, userId) {
  const res = await pool.query(
    `DELETE FROM asset_wishlist WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  return res.rows[0] || null;
}

// ─── Signed URLs & R2 ─────────────────────────────────────────────────────────

async function getAssetFilePath(assetId) {
  const res = await pool.query(
    `SELECT file_path, file_type, title, uploader_id FROM assets WHERE id = $1`,
    [assetId]
  );
  return res.rows[0] || null;
}

// ─── Enhanced Seller Analytics ────────────────────────────────────────────────

async function getSellerPayoutSummary(uploaderId) {
  const [analytics, transactions, payoutRow] = await Promise.all([
    getAssetAnalytics(uploaderId),
    getSellerTransactions(uploaderId),
    pool.query(`SELECT * FROM creator_payouts WHERE creator_user_id = $1`, [uploaderId]),
  ]);

  const paidTxns = transactions.filter(t => parseFloat(t.amount_usd || 0) > 0);
  const freeTxns = transactions.filter(t => parseFloat(t.amount_usd || 0) === 0);

  const totalGross = paidTxns.reduce((s, t) => s + parseFloat(t.amount_usd || 0), 0);
  const totalCommission = paidTxns.reduce((s, t) => s + parseFloat(t.commission_usd || 0), 0);
  const totalNet = paidTxns.reduce((s, t) => s + parseFloat(t.net_usd || 0), 0);
  const cp = payoutRow.rows[0];
  const pendingPayout = cp ? parseFloat(cp.balance_usd || 0) : totalNet;

  return {
    total_listings: parseInt(analytics.total_listings || 0, 10),
    total_downloads: parseInt(analytics.total_downloads || 0, 10),
    total_views: parseInt(analytics.total_views || 0, 10),
    total_revenue: parseFloat(analytics.total_revenue || 0),
    gross_revenue: parseFloat(totalGross.toFixed(2)),
    platform_commission_usd: parseFloat(totalCommission.toFixed(2)),
    net_revenue: parseFloat(totalNet.toFixed(2)),
    pending_payout: parseFloat(pendingPayout.toFixed(2)),
    lifetime_payout: cp ? parseFloat(cp.lifetime_payout_usd || 0) : 0,
    stripe_connect_onboarded: cp?.stripe_connect_onboarded || false,
    stripe_connect_account_id: cp?.stripe_connect_account_id || null,
    paid_transaction_count: paidTxns.length,
    free_acquisition_count: freeTxns.length,
    avg_rating: parseFloat(analytics.avg_rating || 0),
    total_reviews: parseInt(analytics.total_reviews || 0, 10),
    recent_transactions: transactions.slice(0, 20).map(t => ({
      id: t.id,
      asset_title: t.asset_title,
      asset_preview: t.preview_url,
      buyer_name: t.buyer_name,
      buyer_email: t.buyer_email,
      amount_usd: parseFloat(t.amount_usd || 0),
      commission_usd: parseFloat(t.commission_usd || 0),
      net_usd: parseFloat(t.net_usd || 0),
      acquired_at: t.acquired_at,
      stripe_payment_id: t.stripe_payment_id,
      is_paid: parseFloat(t.amount_usd || 0) > 0,
    })),
  };
}

// ─── Creator Payouts & Stripe Connect ────────────────────────────────────────

async function getOrCreateCreatorPayout(userId) {
  const existing = await pool.query(`SELECT * FROM creator_payouts WHERE creator_user_id = $1`, [userId]);
  if (existing.rows[0]) return existing.rows[0];
  const res = await pool.query(
    `INSERT INTO creator_payouts (creator_user_id) VALUES ($1) RETURNING *`,
    [userId]
  );
  return res.rows[0];
}

async function recordCreatorStripeId(userId, stripeConnectAccountId) {
  await pool.query(
    `UPDATE creator_payouts SET stripe_connect_account_id = $2, updated_at = NOW() WHERE creator_user_id = $1`,
    [userId, stripeConnectAccountId]
  );
}

async function recordStripeAcquisition(data) {
  const { asset_id, buyer_id, seller_id, amount_usd, platform_commission_usd, stripe_fee_usd, creator_payout_usd, stripe_payment_id } = data;
  const commission_pct = 2;
  const net_usd = creator_payout_usd || 0;
  const res = await pool.query(
    `INSERT INTO asset_acquisitions (asset_id, buyer_id, seller_id, amount_usd, commission_pct, commission_usd, stripe_fee_usd, platform_commission_usd, net_usd, stripe_payment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'acquired') RETURNING *`,
    [asset_id, buyer_id, seller_id, amount_usd, commission_pct, platform_commission_usd, stripe_fee_usd, platform_commission_usd, net_usd, stripe_payment_id]
  );
  // Update asset revenue
  await pool.query(`
    UPDATE assets SET download_count = download_count + 1, total_revenue = total_revenue + $2, updated_at = NOW() WHERE id = $1
  `, [asset_id, amount_usd]);
  // Credit creator balance
  await pool.query(`
    INSERT INTO creator_payouts (creator_user_id, balance_usd, lifetime_revenue_usd)
    VALUES ($1, $2, $2)
    ON CONFLICT (creator_user_id) DO UPDATE SET
      balance_usd = creator_payouts.balance_usd + $2,
      lifetime_revenue_usd = creator_payouts.lifetime_revenue_usd + $2,
      updated_at = NOW()
  `, [seller_id, creator_payout_usd]);
  return res.rows[0];
}

async function getCreatorStripeStatus(userId) {
  const res = await pool.query(`SELECT stripe_connect_account_id, stripe_connect_onboarded, balance_usd, lifetime_revenue_usd, lifetime_payout_usd FROM creator_payouts WHERE creator_user_id = $1`, [userId]);
  return res.rows[0] || { stripe_connect_account_id: null, stripe_connect_onboarded: false, balance_usd: 0, lifetime_revenue_usd: 0, lifetime_payout_usd: 0 };
}

// ─── Buyer Library ───────────────────────────────────────────────────────────

async function getMyLibrary(userId) {
  const res = await pool.query(`
    SELECT aa.id AS acquisition_id, aa.acquired_at, aa.amount_usd, aa.stripe_payment_id,
           a.id AS asset_id, a.title, a.description, a.category, a.file_type, a.file_path,
           a.preview_url, a.version, a.compatibility, a.license,
           u.name AS creator_name, u.email AS creator_email,
           COALESCE(a.rating_avg, 0) AS rating_avg,
           a.review_count,
           CASE WHEN aa.amount_usd > 0 THEN true ELSE false END AS was_paid
    FROM asset_acquisitions aa
    JOIN assets a ON aa.asset_id = a.id
    LEFT JOIN users u ON a.uploader_id = u.id
    WHERE aa.buyer_id = $1
    ORDER BY aa.acquired_at DESC
  `, [userId]);
  return res.rows;
}

// ─── Marketplace Search Cache ──────────────────────────────────────────────────

async function getCachedSearchResults(cacheKey) {
  try {
    const res = await pool.query(
      `SELECT results, cached_at FROM marketplace_search_cache
       WHERE cache_key = $1 AND expires_at > NOW()`,
      [cacheKey]
    );
    if (!res.rows.length) return null;
    // Increment hit count asynchronously — do not await
    pool.query(`UPDATE marketplace_search_cache SET hit_count = hit_count + 1 WHERE cache_key = $1`, [cacheKey]).catch(() => {});
    return res.rows[0].results;
  } catch {
    return null;
  }
}

async function setCachedSearchResults(cacheKey, source, results, ttlHours = 24) {
  try {
    await pool.query(
      `INSERT INTO marketplace_search_cache (cache_key, source, results, result_count, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::INTERVAL)
       ON CONFLICT (cache_key) DO UPDATE SET
         results = EXCLUDED.results, result_count = EXCLUDED.result_count,
         cached_at = NOW(), expires_at = EXCLUDED.expires_at, hit_count = 0`,
      [cacheKey, source, JSON.stringify(results), results.length, ttlHours]
    );
  } catch (err) {
    console.warn('[db/assets] setCachedSearchResults:', err.message);
  }
}

async function searchExternalBySource(query, { source, format, license, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let p = 1;

  if (query) {
    conditions.push(`(name ILIKE '%' || $${p} || '%' OR description ILIKE '%' || $${p} || '%' OR $${p} = ANY(tags))`);
    params.push(query); p++;
  }
  if (source) { conditions.push(`distributor = $${p++}`); params.push(source); }
  if (format) { conditions.push(`format = $${p++}`); params.push(format); }
  if (license) { conditions.push(`license = $${p++}`); params.push(license); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM external_assets ${where}`, params);
  const res = await pool.query(
    `SELECT * FROM external_assets ${where} ORDER BY indexed_at DESC LIMIT $${p++} OFFSET $${p++}`,
    [...params, limit, offset]
  );
  return { rows: res.rows, total: parseInt(countRes.rows[0].total, 10) };
}

module.exports = {
  // Assets
  createAsset, getAssetById, getAssetBySlug, listStoreAssets, searchAssets,
  getMyAssets, getUploaderAssets, updateAsset, publishAsset,
  incrementAssetView, incrementAssetDownload, getAssetAnalytics, deleteAsset,
  // Reviews
  createReview, getAssetReviews, deleteReview,
  // Acquisitions
  createAcquisition, getAcquisition, getSellerTransactions,
  // External assets
  searchExternalAssets, listExternalAssetsByDistributor, upsertExternalAsset, searchExternalBySource,
  // Marketplace search cache
  getCachedSearchResults, setCachedSearchResults,
  // Wishlist
  addToWishlist, getWishlist, removeFromWishlist,
  // R2 & signed URLs
  getAssetFilePath,
  // Enhanced seller analytics
  getSellerPayoutSummary,
  // Creator payouts & Stripe Connect
  getOrCreateCreatorPayout, recordCreatorStripeId, recordStripeAcquisition, getCreatorStripeStatus,
  // Buyer library
  getMyLibrary,
};