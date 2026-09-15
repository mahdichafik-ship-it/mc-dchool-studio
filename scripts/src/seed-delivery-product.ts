import { getUncachableStripeClient } from "./stripeClient";

const PRODUCT_NAME = "Volume Capture digital photo";

const stripe = await getUncachableStripeClient();
const products = await stripe.products.search({ query: `name:'${PRODUCT_NAME}' AND active:'true'` });
let product = products.data[0];
if (!product) {
  product = await stripe.products.create({
    name: PRODUCT_NAME,
    description: "One high-resolution digital photo from a private Volume Capture gallery.",
    metadata: { kind: "delivery_photo" },
  });
}

const prices = await stripe.prices.list({ product: product.id, active: true, type: "one_time", limit: 20 });
let price = prices.data.find((candidate) => candidate.metadata.kind === "delivery_photo");
if (!price) {
  price = await stripe.prices.create({
    product: product.id,
    unit_amount: 1000,
    currency: "usd",
    metadata: { kind: "delivery_photo" },
  });
}
console.log(JSON.stringify({ productId: product.id, priceId: price.id, unitAmount: price.unit_amount, currency: price.currency }));