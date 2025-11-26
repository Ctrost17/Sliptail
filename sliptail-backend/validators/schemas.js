const { z } = require("zod"); 

// Reusable primitives
const id = z.coerce.number().int().positive();
const price = z.coerce.number().finite().min(0).max(1_000_000);

// NEW: absolute URL validator that allows Stripe's {CHECKOUT_SESSION_ID} placeholder
const urlWithCheckoutPlaceholder = z
  .string()
  .trim()
  .min(1)
  .refine((val) => {
    try {
      const test = val.replace("{CHECKOUT_SESSION_ID}", "cs_test_123");
      const u = new URL(test);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, { message: "Must be an absolute URL (http/https). You may include {CHECKOUT_SESSION_ID}." });

// AUTH
const authSignup = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(100),
    username: z.string().min(2).max(50).optional(),
  }),
});

const authLogin = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(100),
  }),
});

const sendVerifyEmail = z.object({ body: z.object({}) }); // no body fields

// PRODUCTS
const productCreateFile = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    product_type: z.enum(["purchase","membership","request"]),
    price: price.optional().nullable(),
  }),
});

const productCreateNoFile = productCreateFile; // same fields without multer file

const productUpdate = z.object({
  params: z.object({ id }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional().nullable(),
    product_type: z.enum(["purchase","membership","request"]).optional(),
    price: price.optional().nullable(),
  }),
});

// ORDERS / CHECKOUT
// UPDATED: accepts productId alias, optional action/quantity, and success/cancel URLs with placeholder
const checkoutSession = z.object({
  body: z.object({
    product_id: id.optional(),
    productId: id.optional(), // alias from some clients
    mode: z.enum(["payment","subscription"]),
    action: z.string().min(1).max(30).transform((s) => s.toLowerCase()).optional(),
    quantity: z.coerce.number().int().min(1).max(100).optional(),
    success_url: urlWithCheckoutPlaceholder.optional(), // was z.string().url()
    cancel_url: urlWithCheckoutPlaceholder.optional(),  // was z.string().url()
  })
  .transform((b) => ({
    ...b,
    // normalize alias -> canonical
    product_id: b.product_id ?? b.productId,
  }))
  .refine((b) => typeof b.product_id === "number" && Number.isFinite(b.product_id), {
    message: "product_id is required",
    path: ["product_id"],
  }),
});

// REQUESTS
const requestCreate = z.object({
  body: z.object({
    creator_id: id,
    product_id: id,
    message: z.string().max(5000).optional().nullable(),
  }),
});

const requestDecision = z.object({
  params: z.object({
    id: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    action: z.enum(["accept", "decline"]),
  }),
});

const requestDeliver = z.object({
  params: z.object({ id }),
});

// REVIEWS (example)
const reviewCreate = z.object({
  body: z.object({
    product_id: id,
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().max(2000).optional().nullable(),
  }),
});

module.exports = {
  authSignup,
  authLogin,
  sendVerifyEmail,
  productCreateFile,
  productCreateNoFile,
  productUpdate,
  checkoutSession,
  requestCreate,
  requestDecision,
  requestDeliver,
  reviewCreate,
};