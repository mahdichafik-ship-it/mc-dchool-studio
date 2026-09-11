import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./lib/webhookHandlers";

const app = express();

app.use(pinoHttp({ logger }));

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));

app.post(["/api/stripe/webhook", "/api/stripe/webhook/:uuid"], express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature || Array.isArray(signature)) {
    res.status(400).json({ error: "Missing Stripe signature" });
    return;
  }
  try {
    const managedWebhookUuid = Array.isArray(req.params.uuid) ? req.params.uuid[0] : req.params.uuid;
    await WebhookHandlers.processWebhook(req.body as Buffer, signature, managedWebhookUuid);
    res.json({ received: true });
  } catch (error) {
    logger.error({ err: error }, "Stripe webhook processing failed");
    res.status(400).json({ error: "Webhook could not be processed" });
  }
});

// Note: multer handles its own body parsing for multipart routes.
// JSON/urlencoded parsers must come after the Clerk proxy but before routes.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

const handleUnhandledRequestError: ErrorRequestHandler = (error, req, res, _next) => {
  logger.error({
    err: error,
    method: req.method,
    path: req.originalUrl,
  }, "Unhandled request error");
  res.status(500).json({
    error: "The server could not complete this request. Please retry.",
    code: "INTERNAL_SERVER_ERROR",
  });
};

app.use(handleUnhandledRequestError);

// Ensure uploads directory exists (files written here by the multer storage engine;
// served exclusively via the authenticated /api/.../photos/:id/file proxy endpoint)
const uploadsDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

export default app;
