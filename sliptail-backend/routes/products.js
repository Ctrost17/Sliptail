// routes/products.js
const express = require("express"); 
const router = express.Router();
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth"); // no requireCreator
const { validate } = require("../middleware/validate");
const { productCreateFile, productCreateNoFile, productUpdate } = require("../validators/schemas");
const { standardLimiter } = require("../middleware/rateLimit");
const { recomputeCreatorActive } = require("../services/creatorStatus");
const jwt = require("jsonwebtoken"); // ⬅️ add JWT for cookie refresh

/* --------------------------- helpers & setup --------------------------- */

function linkify(product) {
  const id = String(product.id);
  const hasFile = product.filename != null && product.filename !== "";
  return {
    ...product,
    id,
    ...(hasFile
      ? {
          view_url: `/api/downloads/view/${id}`,
          download_url: `/api/downloads/file/${id}`,
        }
      : {}),
  };
}

function toProductDTO(row) {
  return {
    id: String(row.id),
    creatorId: String(row.user_id),
    title: row.title,
    description: row.description ?? null,
    price: typeof row.price === "number" ? row.price : Number(row.price) || 0,
    productType: row.product_type,
  };
}

// 📁 Ensure upload folder exists
const uploadDir = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 📦 Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, "raw-" + Date.now() + ext);
  },
});

const allowed = new Set([
  "application/pdf",
  "application/epub+zip",
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "text/plain",
]);

const upload = multer({
  storage,
  limits: { fileSize: 2500 * 1024 * 1024 }, // 2.5GB
  fileFilter: (req, file, cb) =>
    allowed.has(file.mimetype) ? cb(null, true) : cb(new Error("Unsupported file type")),
});

// Compare using ::text so it works for INT ids or UUID/text ids
const WHERE_ID_TEXT = "id::text = $1";
const WHERE_USERID_TEXT = "user_id::text = $1";

async function assertOwner(productIdRaw, userId) {
  const pid = String(productIdRaw || "").trim();
  const { rows } = await db.query(`SELECT user_id FROM products WHERE ${WHERE_ID_TEXT}`, [pid]);
  if (!rows[0]) return { error: "Product not found", code: 404 };
  if (String(rows[0].user_id) !== String(userId)) return { error: "You do not own this product", code: 403 };
  return { ok: true };
}

const isVideo = (mimeType) => mimeType.startsWith("video/");

// Optional best-effort Stripe sync (lazy)
let syncStripeForUser = null;
try {
  ({ syncStripeForUser } = require("../services/stripeConnect"));
} catch (_) {}

/* ---------------- DB introspection helpers (avoid schema mismatches) --------------- */

async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasTable(table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1
     LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

/** Build a safe INSERT for products that:
 *  - coerces user_id via subselect to the real users.id type
 *  - includes only columns that exist
 *  - supports with/without filename
 *  - sets active=TRUE immediately if the column exists
 */
async function insertProduct({
  userIdText,
  title,
  description,
  product_type,
  price_cents,
  filename = null,
}) {
  const cols = ["user_id", "title", "description", "product_type", "price"];
  const vals = [
    `(SELECT id FROM users WHERE id::text = $1)`,
    "$2",
    "$3",
    "$4",
    "$5",
  ];
  const params = [userIdText, title, description || null, product_type, Number(price_cents) || 0];

  const haveFilename = filename != null;
  const productsHasFilename = await hasColumn("products", "filename");
  const productsHasActive = await hasColumn("products", "active");
  const productsHasCreated = await hasColumn("products", "created_at");
  const productsHasUpdated = await hasColumn("products", "updated_at");

  if (haveFilename && productsHasFilename) {
    cols.push("filename");
    vals.push("$" + params.push(filename));
  }
  if (productsHasActive) {
    cols.push("active");
    vals.push("TRUE");
  }
  if (productsHasCreated) {
    cols.push("created_at");
    vals.push("NOW()");
  }
  if (productsHasUpdated) {
    cols.push("updated_at");
    vals.push("NOW()");
  }

  const sql = `INSERT INTO products (${cols.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`;
  const { rows } = await db.query(sql, params);
  return rows[0];
}

/* -------------------- SAFE READINESS (never throws) -------------------- */

async function ensureCreationReadinessSafe(dbConn, userId, recomputeFn) {
  const out = { ok: false, missing: [], status: undefined, error: undefined };
  try {
    let status = await recomputeFn(dbConn, userId);

    if (status && !status.stripeConnected && typeof syncStripeForUser === "function") {
      try {
        await syncStripeForUser(dbConn, userId);
      } catch (e) {
        console.warn("lazy stripe sync failed:", e?.message || e);
      }
      try {
        status = await recomputeFn(dbConn, userId);
      } catch (_) {}
    }

    out.status = status || null;
    if (!status?.profileComplete) out.missing.push("Complete your profile");
    if (!status?.stripeConnected) out.missing.push("Connect your Stripe account");
    out.ok = out.missing.length === 0;
    return out;
  } catch (e) {
    out.error = e?.message || String(e);
    if (!out.missing.length) out.missing.push("Complete your profile", "Connect your Stripe account");
    return out;
  }
}

/* -------------------- creator activation helpers (auto) -------------------- */

      // Ensure a creator_profiles row exists (schema-aware)
      async function ensureCreatorProfileRow(userId) {
        const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at");
        const cols = ["user_id", "is_active"];
        const vals = ["$1", "FALSE"];
        if (hasUpdatedAt) {
          cols.push("updated_at");
          vals.push("NOW()");
        }
        await db.query(
        `INSERT INTO creator_profiles (${cols.join(", ")})
          SELECT ${vals.join(", ")}
          WHERE NOT EXISTS (
            SELECT 1 FROM creator_profiles WHERE user_id::text = $1
          )`,
          [String(userId)]
        );
      }

// Set creator_profiles.is_active based on “has ≥1 published product” (schema-aware)
async function setActiveFromPublished(userId) {
  const hasActive = await hasColumn("products", "active");
  let anyPub = false;

  if (hasActive) {
   const { rows } = await db.query(
      `SELECT EXISTS(
         SELECT 1 FROM products
          WHERE user_id::text=$1 AND active=TRUE
       ) AS any_pub`,
      [String(userId)]
    );
    anyPub = !!rows?.[0]?.any_pub;
  } else {
    // No "active" column -> treat “has any product” as published
    const { rows } = await db.query(
      `SELECT EXISTS(
         SELECT 1 FROM products WHERE user_id::text=$1
       ) AS any_pub`,
      [String(userId)]
    );
    anyPub = !!rows?.[0]?.any_pub;
  }

  await ensureCreatorProfileRow(userId);
  const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at");
  const sets = ["is_active = $2"];
  if (hasUpdatedAt) sets.push("updated_at = NOW()");

  await db.query(
   `UPDATE creator_profiles
        SET ${sets.join(", ")}
      WHERE user_id::text=$1`,
    [String(userId), anyPub]
  );

  return anyPub;
}

// ⬇️ Promote role to creator, refresh JWT cookie, and sync creator_profiles.is_active.
//    Errors are swallowed (don’t break the create flow).
async function promoteAndRefreshAuth(userId, res) {
  try {
    await db.query(
      `UPDATE users SET role='creator', updated_at=NOW()
       WHERE id=$1 AND (role IS NULL OR role <> 'creator')`,
      [userId]
    );

    // pull fresh user row
    const { rows } = await db.query(`SELECT id, email, role, email_verified_at FROM users WHERE id=$1 LIMIT 1`, [userId]);
    if (rows.length) {
      const u = rows[0];
      const token = jwt.sign(
        {
          id: u.id,
          email: u.email,
          role: u.role || "user",
          email_verified_at: u.email_verified_at,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );
      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV !== "development",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });
    }
  } catch (e) {
    console.warn("promote/refresh cookie failed:", e?.message || e);
  }

  try {
    await setActiveFromPublished(userId);
  } catch (e) {
    console.warn("setActiveFromPublished failed:", e?.message || e);
  }
}

function sanitizeRating(r) {
  const n = parseInt(String(r), 10);
  if (!Number.isFinite(n)) return null;
  return n >= 1 && n <= 5 ? n : null;
}

/* -------------------------------- routes -------------------------------- */

// GET /api/products -> list all products
router.get("/", async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT id, user_id, title, description, filename, product_type, price FROM products ORDER BY created_at DESC"
    );
    const items = result.rows.map((row) => ({
      id: String(row.id),
      creatorId: String(row.user_id),
      title: row.title,
      description: row.description ?? null,
      price: Number(row.price) ?? 0,
      productType: row.product_type,
    }));
    res.json(items);
  } catch (err) {
    next(err);
  }
});

/* ------------------------ CREATE (with file) ------------------------ */
router.post(
  "/upload",
  requireAuth,
  standardLimiter,
  upload.single("file"),
  validate(productCreateFile),
  async (req, res) => {
    const inputPath = req.file.path;
    const mimeType = req.file.mimetype;

    const user_id = String(req.user.id || "").trim();
    const { title, description, product_type } = req.body;

    const priceRaw = req.body.price ?? req.body.price_cents ?? 0;
    const priceNum = Number(priceRaw);
    if (Number.isNaN(priceNum)) return res.status(400).json({ error: "Price must be a number" });

    if (!["purchase", "membership", "request"].includes(product_type)) {
      return res.status(400).json({ error: "Invalid product_type" });
    }

    const ready = await ensureCreationReadinessSafe(db, user_id, recomputeCreatorActive);
    if (!ready.ok) {
      return res.status(403).json({
        error: "Finish profile and connect Stripe before creating a product.",
        missing: ready.missing,
        ...(ready.error ? { detail: ready.error } : {}),
      });
    }

    const finalizeCreate = async (filename) => {
      try {
        const created = await insertProduct({
          userIdText: user_id,
          title,
          description,
          product_type,
          price_cents: priceNum,
          filename,
        });

        // ⬅️ do auth promotion + cookie + is_active sync BEFORE responding,
        //     so the navbar can flip instantly without a hard refresh.
        await promoteAndRefreshAuth(req.user.id, res);

        res.json({ success: true, product: linkify(created) });
      } catch (err) {
        console.error("DB insert error (upload):", err.message || err, err.detail || "");
        res.status(500).json({ error: "Database insert failed" });
      }
    };

    if (isVideo(mimeType)) {
      const outputFilename = `video-${Date.now()}.mp4`;
      const outputPath = path.join(uploadDir, outputFilename);

      ffmpeg(inputPath)
        .output(outputPath)
        .on("end", () => {
          try {
            fs.unlinkSync(inputPath);
          } catch {}
          finalizeCreate(outputFilename);
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err.message || err);
          res.status(500).json({ error: "Video conversion failed" });
        })
        .run();
    } else {
      const finalName = `file-${Date.now()}${path.extname(req.file.originalname)}`;
      const finalPath = path.join(uploadDir, finalName);
      fs.rename(inputPath, finalPath, (err) => {
        if (err) {
          console.error("Rename error:", err.message || err);
          return res.status(500).json({ error: "File save failed" });
        }
        finalizeCreate(finalName);
      });
    }
  }
);

/* ------------------------ CREATE (no file) ------------------------ */
router.post(
  "/new",
  requireAuth,
  standardLimiter,
  validate(productCreateNoFile),
  async (req, res) => {
    const user_id = String(req.user.id || "").trim();
    const { title, description, product_type } = req.body;

    const priceRaw = req.body.price ?? req.body.price_cents ?? 0;
    const priceNum = Number(priceRaw);
    if (Number.isNaN(priceNum)) return res.status(400).json({ error: "Price must be a number" });

    if (!["purchase", "membership", "request"].includes(product_type)) {
      return res.status(400).json({ error: "Invalid product_type" });
    }

    const ready = await ensureCreationReadinessSafe(db, user_id, recomputeCreatorActive);
    if (!ready.ok) {
      return res.status(403).json({
        error: "Finish profile and connect Stripe before creating a product.",
        missing: ready.missing,
        ...(ready.error ? { detail: ready.error } : {}),
      });
    }

    try {
      const created = await insertProduct({
        userIdText: user_id,
        title,
        description,
        product_type,
        price_cents: priceNum,
        filename: null,
      });

      // ⬅️ same: set role/cookie + is_active before responding
      await promoteAndRefreshAuth(req.user.id, res);

      res.status(201).json({ product: linkify(created) });
    } catch (err) {
      console.error("Create product error:", err.message || err, err.detail || "");
      res.status(500).json({ error: "Could not create product" });
    }
  }
);

// GET /api/products/user/:userId
router.get("/user/:userId", async (req, res) => {
  const userIdRaw = String(req.params.userId || "").trim();

  try {
    const result = await db.query(
      `SELECT * FROM products WHERE ${WHERE_USERID_TEXT} ORDER BY created_at DESC`,
      [userIdRaw]
    );
    res.json({ products: result.rows.map(linkify) });
  } catch (err) {
    console.error("Fetch error:", err.message || err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ------------------------- REVIEWS (schema-aware) ------------------------- */
// POST /api/products/:productId/reviews
// Creates or updates a review for the creator who owns this product.
// Upserts by (buyer_id, product_id). Accepts { rating(1..5), comment? }.
router.post("/:productId/reviews", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const productId = parseInt(req.params.productId, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product id" });

  const rating = sanitizeRating(req.body?.rating);
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : null;
  if (!rating) return res.status(400).json({ error: "rating must be an integer 1..5" });

  try {
    // 1) Product & owning creator
    const { rows: prodRows } = await db.query(
      "SELECT id, user_id AS creator_id FROM products WHERE id=$1 LIMIT 1",
      [productId]
    );
    if (!prodRows.length) return res.status(404).json({ error: "Product not found" });
    const creatorId = prodRows[0].creator_id;

    if (String(creatorId) === String(buyerId)) {
      return res.status(400).json({ error: "You cannot review yourself" });
    }

    // 2) Eligibility (schema-aware)
    let eligible = false;

    // (A) Paid/completed/succeeded purchase for this product
    if (await hasTable("orders")) {
      // pick buyer column
      const buyerCols = ["buyer_id", "user_id", "customer_id"];
      let buyerCol = null;
      for (const c of buyerCols) {
        if (await hasColumn("orders", c)) { buyerCol = c; break; }
      }
      if (buyerCol) {
        const statuses = ["paid", "completed", "succeeded", "success"];
        const paid = await db.query(
          `
          SELECT 1
            FROM orders o
           WHERE o.${buyerCol} = $1
             AND o.product_id  = $2
             AND o.status      = ANY($3::text[])
           LIMIT 1
          `,
          [buyerId, productId, statuses]
        );
        eligible = paid.rows.length > 0;
      }
    }

    // (B) Delivered request with this creator
    if (!eligible && await hasTable("custom_requests")) {
      const crBuyerCol = (await hasColumn("custom_requests", "buyer_id")) ? "buyer_id" : "user_id";
      const deliveredStatuses = ["delivered", "complete", "completed"];
      const delivered = await db.query(
        `
        SELECT 1
          FROM custom_requests cr
         WHERE cr.${crBuyerCol} = $1
           AND cr.creator_id    = $2
           AND cr.status        = ANY($3::text[])
         LIMIT 1
        `,
        [buyerId, creatorId, deliveredStatuses]
      );
      eligible = delivered.rows.length > 0;
    }

    // (C) Active/trialing membership with this creator (direct or via products)
    if (!eligible && await hasTable("memberships")) {
      const memBuyerCol = (await hasColumn("memberships", "buyer_id")) ? "m.buyer_id" : "m.user_id";
      const hasMemCreator = await hasColumn("memberships", "creator_id");
      const hasMemProduct = await hasColumn("memberships", "product_id");
      const memStatuses = ["active", "trialing"];

      if (hasMemCreator) {
        const q = await db.query(
          `
          SELECT 1
            FROM memberships m
           WHERE ${memBuyerCol} = $1
             AND m.creator_id   = $2
             AND m.status       = ANY($3::text[])
           LIMIT 1
          `,
          [buyerId, creatorId, memStatuses]
        );
        eligible = q.rows.length > 0;
      } else if (hasMemProduct) {
        const q = await db.query(
          `
          SELECT 1
            FROM memberships m
            JOIN products p ON p.id = m.product_id
           WHERE ${memBuyerCol} = $1
             AND p.user_id      = $2
             AND m.status       = ANY($3::text[])
           LIMIT 1
          `,
          [buyerId, creatorId, memStatuses]
        );
        eligible = q.rows.length > 0;
      }
    }

    if (!eligible) {
      return res.status(403).json({ error: "Not eligible to review this creator" });
    }

    // 3) Upsert review by (buyer_id, product_id)
    const { rows: existing } = await db.query(
      "SELECT id FROM reviews WHERE buyer_id=$1 AND product_id=$2 LIMIT 1",
      [buyerId, productId]
    );

    if (existing.length) {
      // only include updated_at if the column exists
      const haveUpdatedAt = await hasColumn("reviews", "updated_at");
      const sets = ["rating=$1", "comment=$2"];
      if (haveUpdatedAt) sets.push("updated_at=NOW()");
      const { rows } = await db.query(
        `UPDATE reviews
            SET ${sets.join(", ")}
          WHERE id=$3
          RETURNING id, creator_id, buyer_id, rating, comment, product_id, created_at${haveUpdatedAt ? ", updated_at" : ""}`,
        [rating, comment, existing[0].id]
      );
      return res.json({ review: rows[0], updated: true });
    }

    const { rows } = await db.query(
      `INSERT INTO reviews (product_id, creator_id, buyer_id, rating, comment, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING id, creator_id, buyer_id, rating, comment, product_id, created_at`,
      [productId, creatorId, buyerId, rating, comment]
    );
    return res.status(201).json({ review: rows[0], created: true });
  } catch (e) {
    console.error("products/:productId/reviews error:", e?.message || e, e?.detail || "");
    return res.status(500).json({ error: "Failed to submit review" });
  }
});

// GET /api/products/:id
router.get("/:id", async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  if (!rawId) return res.status(400).json({ error: "Invalid product id" });

  try {
    const result = await db.query(`SELECT * FROM products WHERE ${WHERE_ID_TEXT}`, [rawId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(linkify(result.rows[0]));
  } catch (err) {
    console.error("Product fetch error:", err.message || err);
    res.status(500).json({ error: "Error fetching product" });
  }
});

/* ------------------------------ DELETE ------------------------------ */
router.delete("/:id", requireAuth, async (req, res) => {
  const rawId = String(req.params.id || "").trim();

  const ownership = await assertOwner(rawId, req.user.id);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  try {
    const { rows: pre } = await db.query(
      `SELECT id, filename, active FROM products WHERE ${WHERE_ID_TEXT}`,
      [rawId]
    );
    if (!pre.length) return res.status(404).json({ error: "Product not found" });
    const oldName = pre[0].filename;
    const wasActive = pre[0].active === true;

    await db.query("BEGIN");
    const { rows } = await db.query(
      `DELETE FROM products WHERE ${WHERE_ID_TEXT} RETURNING *`,
      [rawId]
    );
    await db.query("COMMIT");

    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    const deleted = rows[0];

    if (oldName) {
      const fp = path.join(uploadDir, oldName);
      if (fs.existsSync(fp)) {
        try {
          fs.unlinkSync(fp);
        } catch (e) {
          console.warn("Could not delete file:", e.message);
        }
      }
    }

    if (wasActive) {
      await setActiveFromPublished(req.user.id).catch((e) =>
        console.warn("delete -> setActiveFromPublished failed:", e?.message || e)
      );
    }

    return res.json({ success: true, deleted });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("Delete product error:", err.message || err);
    return res.status(500).json({ error: "Failed to delete product" });
  }
});

/* ------------------------------ UPDATE META ------------------------------ */
router.put("/:id", requireAuth, standardLimiter, validate(productUpdate), async (req, res) => {
  const productId = parseInt(req.params.id, 10);

  let { title, description, product_type, price } = req.body;

  if (typeof title === "string") title = title.trim();
  else title = undefined;
  if (typeof description === "string") description = description.trim();
  else description = undefined;

  if (typeof product_type !== "string") product_type = undefined;
  else if (!["purchase", "membership", "request"].includes(product_type)) {
    return res.status(400).json({ error: "Invalid product_type" });
  }

  if (price !== undefined) {
    if (typeof price === "string") {
      if (price.trim() === "") {
        price = undefined;
      } else {
        const parsed = Number(price);
        if (!Number.isFinite(parsed)) return res.status(400).json({ error: "Price must be a number" });
        price = Math.trunc(parsed);
      }
    } else if (typeof price === "number") {
      if (!Number.isFinite(price)) return res.status(400).json({ error: "Price must be a number" });
      price = Math.trunc(price);
    } else {
      price = undefined;
    }
  }

  if (product_type) {
    const { rows: sold } = await db.query(
      "SELECT 1 FROM orders WHERE product_id=$1 AND status='paid' LIMIT 1",
      [productId]
    );
    if (sold.length) {
      return res.status(400).json({ error: "Cannot change product_type after sales exist" });
    }
  }

  const ownership = await assertOwner(productId, req.user.id);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  const sets = [];
  const vals = [];
  let i = 1;

  if (title !== undefined) {
    sets.push(`title = $${i++}`);
    vals.push(title);
  }
  if (description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(description || null);
  }
  if (product_type !== undefined) {
    sets.push(`product_type = $${i++}`);
    vals.push(product_type);
  }
  if (price !== undefined) {
    sets.push(`price = $${i++}`);
    vals.push(price);
  }

  if (sets.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");

  vals.push(productId);

  try {
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    return res.json({ success: true, product: linkify(rows[0]) });
  } catch (err) {
    const detail = err?.detail || err?.message || "Could not update product";
    console.error("Update product error:", err);
    return res.status(500).json({ error: detail });
  }
});

/* ------------------------------ UPDATE FILE ------------------------------ */
router.put("/:id/file", requireAuth, upload.single("file"), async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const ownership = await assertOwner(rawId, req.user.id);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  const { rows: prevRows } = await db.query(`SELECT filename FROM products WHERE ${WHERE_ID_TEXT}`, [rawId]);
  const oldName = prevRows[0]?.filename || null;

  const inputPath = req.file.path;
  const mimeType = req.file.mimetype;

  const saveNewFilename = async (newName) => {
    try {
      const sets = ["filename = $1"];
      if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
      const updated = await db.query(
        `UPDATE products SET ${sets.join(", ")} WHERE ${WHERE_ID_TEXT} RETURNING *`,
        [newName, rawId]
      );

      if (oldName && oldName !== newName) {
        const oldPath = path.join(uploadDir, oldName);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (e) {
            console.warn("Delete old file failed:", e.message);
          }
        }
      }

      res.json({ success: true, product: linkify(updated.rows[0]) });
    } catch (err) {
      console.error("File update DB error:", err.message || err);
      res.status(500).json({ error: "Failed to update product file" });
    }
  };

  if (mimeType.startsWith("video/")) {
    const outputFilename = `video-${Date.now()}.mp4`;
    const outputPath = path.join(uploadDir, outputFilename);
    ffmpeg(inputPath)
      .output(outputPath)
      .on("end", () => {
        try {
          fs.unlinkSync(inputPath);
        } catch {}
        saveNewFilename(outputFilename);
      })
      .on("error", () => res.status(500).json({ error: "Video conversion failed" }))
      .run();
  } else {
    const finalName = `file-${Date.now()}${path.extname(req.file.originalname)}`;
    const finalPath = path.join(uploadDir, finalName);
    fs.rename(inputPath, finalPath, (err) => {
      if (err) return res.status(500).json({ error: "File save failed" });
      saveNewFilename(finalName);
    });
  }
});

/* -------------------- publish/unpublish -------------------- */
// You can still manually publish/unpublish; new items default to active on create if column exists.

router.post("/:id/publish", requireAuth, async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const userId = req.user.id;

  const ownership = await assertOwner(rawId, userId);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  const ready = await ensureCreationReadinessSafe(db, userId, recomputeCreatorActive);
  if (!ready.ok) {
    return res.status(403).json({
      error: "Finish profile and connect Stripe before publishing.",
      missing: ready.missing,
      ...(ready.error ? { detail: ready.error } : {}),
    });
  }

  try {
    const sets = ["active = TRUE"];
    if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE ${WHERE_ID_TEXT} RETURNING *`,
      [rawId]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });

    // Promote & activate + refresh cookie
    await promoteAndRefreshAuth(userId, res);

    res.json({ success: true, product: linkify(rows[0]) });
  } catch (e) {
    console.error("Publish product error:", e.message || e);
    res.status(500).json({ error: "Failed to publish product" });
  }
});

router.post("/:id/unpublish", requireAuth, async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const userId = req.user.id;

  const ownership = await assertOwner(rawId, userId);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  try {
    const sets = ["active = FALSE"];
    if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE ${WHERE_ID_TEXT} RETURNING *`,
      [rawId]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });

    // Keep creator_profiles.is_active in sync
    await setActiveFromPublished(userId);

    res.json({ success: true, product: linkify(rows[0]) });
  } catch (e) {
    console.error("Unpublish product error:", e.message || e);
    res.status(500).json({ error: "Failed to unpublish product" });
  }
});

module.exports = router;
