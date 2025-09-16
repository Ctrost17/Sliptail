const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { notifyPurchase } = require("../utils/notify");

const router = express.Router();

function linkify(product) {
  if (!product) return null;
  const id = product.id;
  return {
    ...product,
    view_url: `/api/downloads/view/${id}`,
    download_url: `/api/downloads/file/${id}`
  };
}

/**
 * POST /api/orders/create
 * Body: { product_id }
 * - uses JWT for buyer_id
 * - price is taken from DB (not from client)
 * - only allows 'purchase' products in this route (memberships/requests later)
 * - prevents buying your own product
 * - creates order with status='pending' (mark paid via /:id/mark-paid for now)
 */
router.post("/create", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const { product_id } = req.body;

  if (!product_id) return res.status(400).json({ error: "product_id is required" });

  try {
    // 1) fetch product & basic validation
    const { rows: prodRows } = await db.query(
      `SELECT id, user_id AS creator_id, price, product_type
         FROM products
        WHERE id = $1`,
      [product_id]
    );
    const product = prodRows[0];
    if (!product) return res.status(404).json({ error: "Product not found" });

    if (product.creator_id === buyerId) {
      return res.status(400).json({ error: "You cannot buy your own product" });
    }

    if (product.product_type !== "purchase") {
      return res.status(400).json({ error: "This endpoint is for one-time purchases only" });
    }

    // 2) amount from DB price (cents) – allow null/0 if free
    const amount = Number(product.price ?? 0);
    if (Number.isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: "Invalid product price" });
    }

    // 3) create order (pending). Later: Stripe PI/Checkout → webhook marks 'paid'
    const { rows: orderRows } = await db.query(
      `INSERT INTO orders (buyer_id, product_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())
       RETURNING *`,
      [buyerId, product_id, amount]
    );

    res.status(201).json({ success: true, order: orderRows[0] });
  } catch (err) {
    console.error("Order create error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

/**
 * GET /api/orders
 * (Alias of /mine kept for backwards compatibility with earlier frontend.)
 * Returns simplified list with consistent amount_cents field.
 */
router.get("/", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT o.id,
              COALESCE(o.amount_cents, (o.amount*100)::bigint, 0) AS amount_cents,
              o.status,
              o.created_at,
              o.product_id
         FROM orders o
        WHERE o.buyer_id = $1
        ORDER BY o.created_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (e) {
    console.error("Orders root list error:", e);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * POST /api/orders/:id/mark-paid
 * - TEMP helper to simulate payment success until Stripe is wired.
 * - Only the buyer who owns the order can mark it paid (for testing).
 */
router.post("/:id/mark-paid", requireAuth, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    const { rows: owned } = await db.query(
      `SELECT id FROM orders WHERE id=$1 AND buyer_id=$2`,
      [orderId, userId]
    );
    if (!owned.length) return res.status(403).json({ error: "Not your order" });

    const { rows } = await db.query(
      `UPDATE orders
          SET status='paid'
        WHERE id=$1
        RETURNING *`,
      [orderId]
    );
    res.json({ success: true, order: rows[0] });
    // send buyer receipt + creator sale notice
notifyPurchase({ orderId }).catch(console.error);
  } 
    catch (err) {
    console.error("Mark paid error:", err);
    res.status(500).json({ error: "Failed to mark order paid" });
  }
});

/**
 * GET /api/orders/mine
 * - Lists current user's orders with product info + secure links
 */
router.get("/mine", requireAuth, async (req, res) => {
  const userId = req.user.id;
  

  try {
    const { rows } = await db.query(
      `SELECT o.*, 
              json_build_object(
                'id', p.id,
                'user_id', p.user_id,
                'title', p.title,
                'description', p.description,
                'filename', p.filename,
                'product_type', p.product_type,
                'price', p.price,
                'created_at', p.created_at
              ) AS product,
              json_build_object(
                'user_id', c.user_id,
                'display_name', c.display_name,
                'bio', c.bio,
                'profile_image', c.profile_image
              ) AS creator_profile
         FROM orders o
         JOIN products p ON p.id = o.product_id
         JOIN creator_profiles c ON c.user_id = p.user_id
        WHERE o.buyer_id = $1
        ORDER BY o.created_at DESC`,
      [userId]
    );

    const withLinks = rows.map(r => ({
      ...r,
      product: linkify(r.product)
    }));    

    console.log("Fetched orders:", withLinks);
    

    res.json({ orders: withLinks });
  } catch (err) {
    console.error("Orders mine error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * GET /api/orders/:id
 * - Fetch a single order (only if you own it)
 */
router.get("/:id", requireAuth, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT o.*, 
              json_build_object(
                'id', p.id,
                'user_id', p.user_id,
                'title', p.title,
                'description', p.description,
                'filename', p.filename,
                'product_type', p.product_type,
                'price', p.price,
                'created_at', p.created_at
              ) AS product
         FROM orders o
         JOIN products p ON p.id = o.product_id
        WHERE o.id = $1 AND o.buyer_id = $2
        LIMIT 1`,
      [orderId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });

    const order = rows[0];
    order.product = linkify(order.product);
    res.json(order);
  } catch (err) {
    console.error("Get order error:", err);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

module.exports = router;