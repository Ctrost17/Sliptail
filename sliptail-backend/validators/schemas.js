const { z } = require("zod");

// Reusable primitives
const id = z.coerce.number().int().positive();
const price = z.coerce.number().finite().min(0).max(1_000_000);

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
const checkoutSession = z.object({
  body: z.object({
    product_id: id,
    mode: z.enum(["payment","subscription"]),
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
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
  params: z.object({ id }),
  body: z.object({ action: z.enum(["accept","decline"]) }),
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