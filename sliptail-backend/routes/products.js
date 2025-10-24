// routes/products.js
const express = require("express"); 
const router = express.Router();
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const os = require("os");
const storage = require("../storage"); // S3 or local
const db = require("../db");
const { requireAuth } = require("../middleware/auth"); // no requireCreator
const { validate } = require("../middleware/validate");
const { productCreateFile, productCreateNoFile, productUpdate } = require("../validators/schemas");
const { standardLimiter } = require("../middleware/rateLimit");
const { recomputeCreatorActive } = require("../services/creatorStatus");
const jwt = require("jsonwebtoken"); // ⬅️ add JWT for cookie refresh
const FFMPEG_DISABLE = String(process.env.FFMPEG_DISABLE || "").trim() === "1";
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

// 📁 Ensure upload folder exists (local mode only)
const uploadDir = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 📦 Multer config — memory for S3, disk for local
const diskStore = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
   const ext = path.extname(file.originalname);
    cb(null, "raw-" + Date.now() + ext);
  },
});
const baseStore = storage.isS3 ? multer.memoryStorage() : diskStore;

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
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 
  "audio/mpeg",
  "audio/mp3"
]);

const upload = multer({
  storage: baseStore,
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

function s3KeyForProduct(userId, ext = ".bin") {
  const safeExt = ext && ext.trim() ? ext.toLowerCase() : ".bin";
  return `products/${userId}/${Date.now()}${safeExt}`;
}

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

// NEW: force-activate creator as soon as they have ≥1 active product
async function activateCreatorNow(userId) {
  const uid = String(userId);
  const hasActive = await hasColumn("products", "active");

  // Make sure the profile row exists
  await ensureCreatorProfileRow(uid);

  const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at");
  const sets = ["is_active = TRUE"];
  if (hasUpdatedAt) sets.push("updated_at = NOW()");

  // If products.active exists, require active=TRUE; otherwise, “has any product”
  await db.query(
    `
    UPDATE creator_profiles cp
       SET ${sets.join(", ")}
     WHERE cp.user_id::text = $1
       AND COALESCE(cp.is_active, FALSE) = FALSE
       AND EXISTS (
         SELECT 1
           FROM products p
          WHERE p.user_id::text = $1
            ${hasActive ? "AND p.active = TRUE" : ""}
       )
    `,
    [uid]
  );
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

  // Cancel all memberships tied to a specific product (best-effort, schema-aware)
  async function cancelMembershipsForProduct(productId) {
    try {
      // Ensure table and target column exist
      if (!(await hasTable("memberships"))) return;
      const hasCancelAt = await hasColumn("memberships", "cancel_at_period_end");
      const hasCanceledAt = await hasColumn("memberships", "canceled_at");
      if (!hasCancelAt) return; 

      let statusType = null;
      try {
        const { rows: st } = await db.query(
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name='memberships' AND column_name='status'
            LIMIT 1`
        );
        statusType = st[0]?.data_type || null;
      } catch (_) {}

      if (statusType && ["text", "character varying", "character"].includes(statusType)) {
        // Text status: mark as fully canceled now
        const sql = `UPDATE memberships
                        SET cancel_at_period_end = TRUE,
                            status = 'canceled'${hasCanceledAt ? ",\n                            canceled_at = NOW()" : ""}
                      WHERE product_id = $1
                        AND status IN ('active','trialing')`;
        await db.query(sql, [productId]);
        return;
      }

      if (statusType === "boolean") {
        // Boolean status: set status = FALSE and schedule canceled_at if column exists
        const sql = `UPDATE memberships
                        SET cancel_at_period_end = TRUE,
                            status = FALSE${hasCanceledAt ? ",\n                            canceled_at = NOW()" : ""}
                      WHERE product_id = $1
                        AND status IS TRUE`;
        await db.query(sql, [productId]);
        return;
      }

      // Unknown or missing status column — still set the flag for all memberships on this product
      const sql = `UPDATE memberships
                      SET cancel_at_period_end = TRUE${hasCanceledAt ? ",\n                          canceled_at = NOW()" : ""}
                    WHERE product_id = $1`;
      await db.query(sql, [productId]);
    } catch (e) {
      console.warn("cancelMembershipsForProduct failed:", e?.message || e);
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
      "SELECT id, user_id, title, description, filename, product_type, price FROM products WHERE active = TRUE ORDER BY created_at DESC"
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
        const user_id = String(req.user.id || "").trim(); // must come first
        const mimeType = req.file.mimetype;
        const ext = path.extname(req.file.originalname || "");
        const inputPath = storage.isS3 ? null : req.file.path;
        // (compute S3 keys later per-branch)

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

            // 1) make sure a profile row exists
            await ensureCreatorProfileRow(user_id).catch(() => {});

            // 2) flip is_active = TRUE immediately if at least one product exists (works with/without products.active)
            await db.query(
              `
              UPDATE creator_profiles cp
                SET is_active = TRUE,
                    ${await hasColumn("creator_profiles", "updated_at") ? "updated_at = NOW()" : "user_id = user_id"}
              WHERE cp.user_id::text = $1
                AND COALESCE(cp.is_active, FALSE) = FALSE
                AND EXISTS (SELECT 1 FROM products p WHERE p.user_id::text = $1)
              `,
              [String(user_id)]
            ).catch((e) => console.warn("force-activate creator failed:", e?.message || e));

            // 3) still run helper flows (redundant but safe)
            try { await activateCreatorNow(user_id); } catch (e) { console.warn("activateCreatorNow failed:", e?.message || e); }
            // do auth promotion + cookie + is_active BEFORE responding
            await promoteAndRefreshAuth(req.user.id, res);

            res.status(201).json({ success: true, product: linkify(created) });
      } catch (err) {
        console.error("DB insert error (upload):", err.message || err, err.detail || "");
        res.status(500).json({ error: "Database insert failed" });
      }
    };

    if (isVideo(mimeType)) {
      const outputFilename = `video-${Date.now()}.mp4`;
      const outputPath = storage.isS3
        ? path.join(os.tmpdir(), outputFilename)
        : path.join(uploadDir, outputFilename);

      // For S3 uploads, ffmpeg needs a real file path, so write a temp input file
      const tmpInPath = storage.isS3
        ? path.join(os.tmpdir(), `in-${Date.now()}${ext || ".bin"}`)
        : null;
      if (storage.isS3) {
        await fs.promises.writeFile(tmpInPath, req.file.buffer);
      }

      ffmpeg(storage.isS3 ? tmpInPath : inputPath)
        .output(outputPath)
        .on("end", async () => {
          try {
            // cleanup original input
            if (!storage.isS3) {
              try { fs.unlinkSync(inputPath); } catch {}
            } else {
              try { await fs.promises.unlink(tmpInPath).catch(() => {}); } catch {}
            }

            if (storage.isS3) {
              const key = s3KeyForProduct(user_id, ".mp4");
              try {
                await storage.uploadPrivate({
                  key,
                  contentType: "video/mp4",
                  body: outputPath,        // <<< pass the file path so storage.js streams/multipart-uploads
                });
                await fs.promises.unlink(outputPath).catch(() => {});
                return finalizeCreate(key); // store the S3 key in DB
              } catch (e) {
                console.error("S3 upload (video) failed:", e);
                return res.status(500).json({ error: "Video upload failed" });
              }
            } else {
              return finalizeCreate(outputFilename);
            }
          } catch (e) {
            console.error("video finalize error:", e);
            return res.status(500).json({ error: "Video processing failed" });
          }
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err.message || err);
          res.status(500).json({ error: "Video conversion failed" });
        })
        .run();
    } else {
      if (storage.isS3) {
        const key = s3KeyForProduct(user_id, ext || ".bin");
        try {
          await storage.uploadPrivate({
            key,
            contentType: mimeType || "application/octet-stream",
            body: req.file.buffer,
          });
          return finalizeCreate(key); // ✅ store S3 key in products.filename
        } catch (e) {
          console.error("S3 upload (non-video) failed:", e);
          return res.status(500).json({ error: "File upload failed" });
        }
      } else {
        const finalName = `file-${Date.now()}${path.extname(req.file.originalname)}`;
        const finalPath = path.join(uploadDir, finalName);
        fs.rename(inputPath, finalPath, (err) => {
        if (err) {
          console.error("Rename error:", err.message || err);
          return res.status(500).json({ error: "File save failed" });
        }
        return finalizeCreate(finalName);
      });
      }
    }
  }
);

/* ------------------------ CREATE (file already in S3 via presign) ------------------------ */
router.post(
  "/upload-from-s3",
  requireAuth,
  standardLimiter,
  async (req, res) => {
    const user_id = String(req.user.id || "").trim();

    const key = String(req.body.key || "").trim(); // S3 key from presign step
    const title = (req.body.title || "").toString();
    const description = (req.body.description || "").toString();
    const product_type = (req.body.product_type || req.body.productType || "").toString();
    const priceRaw = req.body.price ?? req.body.price_cents ?? 0;
    const priceNum = Number(priceRaw);

    if (!key) return res.status(400).json({ error: "S3 key required" });
    if (!title.trim()) return res.status(400).json({ error: "Title is required" });
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
        filename: key, // ✅ store the S3 key directly
      });

      // ensure profile + activate + refresh cookie (same flow you already use)
      await ensureCreatorProfileRow(user_id).catch(() => {});
      try { await activateCreatorNow(user_id); } catch (e) { console.warn("activateCreatorNow failed:", e?.message || e); }
      await promoteAndRefreshAuth(req.user.id, res);

      res.status(201).json({ success: true, product: linkify(created) });
    } catch (err) {
      console.error("DB insert error (upload-from-s3):", err?.message || err, err?.detail || "");
      res.status(500).json({ error: "Database insert failed" });
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

        // 1) ensure profile row
        await ensureCreatorProfileRow(user_id).catch(() => {});

        // 2) force-activate now that a product exists
        await db.query(
          `
          UPDATE creator_profiles cp
            SET is_active = TRUE,
                ${await hasColumn("creator_profiles", "updated_at") ? "updated_at = NOW()" : "user_id = user_id"}
          WHERE cp.user_id::text = $1
            AND COALESCE(cp.is_active, FALSE) = FALSE
            AND EXISTS (SELECT 1 FROM products p WHERE p.user_id::text = $1)
          `,
          [String(user_id)]
        ).catch((e) => console.warn("force-activate creator failed:", e?.message || e));

        try { await activateCreatorNow(user_id); } catch (e) { console.warn("activateCreatorNow failed:", e?.message || e); }
        // set role/cookie + is_active before responding
        await promoteAndRefreshAuth(req.user.id, res);

        res.status(201).json({ success: true, product: linkify(created) });
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
      `SELECT * FROM products WHERE ${WHERE_USERID_TEXT} AND active = TRUE ORDER BY created_at DESC`,
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

    const { rows: existing } = await db.query(
      "SELECT id FROM reviews WHERE buyer_id=$1 AND product_id=$2 LIMIT 1",
      [buyerId, productId]
    );

    if (existing.length) {
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
    const result = await db.query(`SELECT * FROM products WHERE ${WHERE_ID_TEXT} AND active = TRUE`, [rawId]);
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
      `SELECT id, user_id, filename, product_type, active FROM products WHERE ${WHERE_ID_TEXT}`,
      [rawId]
    );
    if (!pre.length) return res.status(404).json({ error: "Product not found" });
    const product = pre[0];
    const wasActive = product.active === true;
    const sets = ["active = FALSE"]; // soft-delete
    if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
    if (await hasColumn("products", "deleted_at")) sets.push("deleted_at = NOW()");

    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE ${WHERE_ID_TEXT} RETURNING *`,
      [rawId]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    const updated = rows[0];

    if (product.product_type === "membership") {
      await cancelMembershipsForProduct(product.id);
    }

    if (wasActive) {
      await setActiveFromPublished(req.user.id).catch((e) =>
        console.warn("soft delete -> setActiveFromPublished failed:", e?.message || e)
      );
    }

    return res.json({ success: true, product: linkify(updated), softDeleted: true });
  } catch (err) {
    console.error("Soft delete product error:", err.message || err);
    return res.status(500).json({ error: "Failed to delete product" });
  }
});
/* ------------------------------ UPDATE FILE ------------------------------ */
router.put(
  "/:id/file",
  requireAuth,
  // wrap Multer to return 400 on upload errors instead of falling into 404
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      next();
    });
  },
  async (req, res) => {
    const rawId = String(req.params.id || "").trim();
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // ownership check (keeps 403/404 distinct)
    const ownership = await assertOwner(rawId, req.user.id);
    if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

    // fetch product & ensure it exists and is a purchase
    const { rows: prodRows } = await db.query(
      `SELECT id, filename, product_type FROM products WHERE id::text = $1`,
      [rawId]
    );
    if (!prodRows.length) return res.status(404).json({ error: "Product not found" });
    if (prodRows[0].product_type !== "purchase") {
      return res.status(400).json({ error: "Only purchase products have a replaceable file" });
    }

    const oldName = prodRows[0].filename || null;

    const inputPath = storage.isS3 ? null : req.file.path;
    const mimeType = req.file.mimetype;

    const saveNewFilename = async (newName) => {
      try {
        const sets = ["filename = $1"];
        if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
        // IMPORTANT: filename is $1, id is $2
        const { rows } = await db.query(
          `UPDATE products SET ${sets.join(", ")} WHERE id::text = $2 RETURNING *`,
          [newName, rawId]
        );
        if (!rows.length) return res.status(404).json({ error: "Product not found" });

        // delete the old file best-effort
        if (oldName && oldName !== newName) {
          if (storage.isS3) {
            try { await storage.deletePrivate(oldName); } catch (e) { console.warn("s3 delete old:", e?.message || e); }
          } else {
          const oldPath = path.join(uploadDir, oldName.replace(/^\/?uploads\//, ""));
          if (fs.existsSync(oldPath)) {
            fs.unlink(oldPath, (e) => e && console.warn("unlink old file:", e.message));
          }
        }
      }
        return res.json({ success: true, product: linkify(rows[0]) });
      } catch (e) {
        console.error("File update DB error:", e);
        return res.status(500).json({ error: "Failed to update product file" });
      }
    };

      try {
        // videos -> transcode if ffmpeg available; otherwise store as-is
        if (!FFMPEG_DISABLE && mimeType.startsWith("video/")) {
          const outputFilename = `video-${Date.now()}.mp4`;
          const outputPath = storage.isS3
            ? path.join(os.tmpdir(), outputFilename)
            : path.join(uploadDir, outputFilename);

          // Prepare input for ffmpeg
          let inPath = inputPath;
          if (storage.isS3) {
            inPath = path.join(os.tmpdir(), `in-${Date.now()}${path.extname(req.file.originalname) || ".bin"}`);
            await fs.promises.writeFile(inPath, req.file.buffer);
          }

          ffmpeg(inPath)
            .output(outputPath)
            .on("end", async () => {
              try {
                if (storage.isS3) {
                  const key = s3KeyForProduct(req.user.id, ".mp4");
                  const data = await fs.promises.readFile(outputPath);
                  await storage.uploadPrivate({ key, contentType: "video/mp4", body: data });
                  await fs.promises.unlink(outputPath).catch(() => {});
                  await fs.promises.unlink(inPath).catch(() => {});
                  await saveNewFilename(key);
                } else {
                  try { fs.unlinkSync(inputPath); } catch {}
                  await saveNewFilename(outputFilename);
                }
              } catch (e) {
                console.error("replace video finalize error:", e);
                return res.status(500).json({ error: "Video processing failed" });
              }
            })
            .on("error", (err) => {
              console.error("FFmpeg error:", err?.message || err);
              // Fallback: store original file so the user isn’t blocked
              if (storage.isS3) {
                (async () => {
                  try {
                    const key = s3KeyForProduct(req.user.id, path.extname(req.file.originalname) || ".bin");
                    await storage.uploadPrivate({
                      key,
                      contentType: mimeType || "application/octet-stream",
                      body: req.file.buffer,
                    });
                    await saveNewFilename(key);
                  } catch (e2) {
                    console.error("Fallback S3 upload failed:", e2);
                    return res.status(500).json({ error: "Video conversion failed" });
                  }
                })();
              } else {
                const finalName = `file-${Date.now()}${path.extname(req.file.originalname)}`;
                const finalPath = path.join(uploadDir, finalName);
                fs.rename(inputPath, finalPath, (renameErr) => {
                  if (renameErr) {
                    console.error("Rename after ffmpeg fail:", renameErr);
                    return res.status(500).json({ error: "Video conversion failed" });
                  }
                  saveNewFilename(finalName);
                });
              }
            })
            .run();
        } else {
          // non-video
          if (storage.isS3) {
            const key = s3KeyForProduct(req.user.id, path.extname(req.file.originalname) || ".bin");
            try {
              await storage.uploadPrivate({
                key,
                contentType: mimeType || "application/octet-stream",
                body: req.file.buffer,
              });
              await saveNewFilename(key);
            } catch (e) {
              console.error("S3 upload (non-video replace) failed:", e);
              return res.status(500).json({ error: "File upload failed" });
            }
          } else {
            const finalName = `file-${Date.now()}${path.extname(req.file.originalname)}`;
            const finalPath = path.join(uploadDir, finalName);
            fs.rename(inputPath, finalPath, (err) => {
              if (err) {
                console.error("Rename error:", err.message || err);
                return res.status(500).json({ error: "File save failed" });
              }
              return saveNewFilename(finalName);
            });
          }
        }
      } catch (e) {
        console.error("Replace file unexpected error:", e);
        return res.status(500).json({ error: "Unexpected error while replacing file" });
      } 
  }
);

/* ------------------------------ UPDATE FILE (file already in S3 via presign) ------------------------------ */
router.put("/:id/file-from-s3", requireAuth, async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const key = String(req.body.key || "").trim(); // S3 key from presign step
  if (!key) return res.status(400).json({ error: "S3 key required" });

  // ownership check
  const ownership = await assertOwner(rawId, req.user.id);
  if (ownership.error) return res.status(ownership.code).json({ error: ownership.error });

  // product must exist and be a purchase
  const { rows: prodRows } = await db.query(
    `SELECT id, filename, product_type FROM products WHERE id::text = $1`,
    [rawId]
  );
  if (!prodRows.length) return res.status(404).json({ error: "Product not found" });
  if (prodRows[0].product_type !== "purchase") {
    return res.status(400).json({ error: "Only purchase products have a replaceable file" });
  }

  const oldName = prodRows[0].filename || null;

  try {
    const sets = ["filename = $1"];
    if (await hasColumn("products", "updated_at")) sets.push("updated_at = NOW()");
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE id::text = $2 RETURNING *`,
      [key, rawId]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });

    // best-effort delete of old file
    if (oldName && oldName !== key) {
      try { await storage.deletePrivate(oldName); } catch (e) { console.warn("delete old file:", e?.message || e); }
    }

    return res.json({ success: true, product: linkify(rows[0]) });
  } catch (e) {
    console.error("file-from-s3 DB error:", e);
    return res.status(500).json({ error: "Failed to update product file" });
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
