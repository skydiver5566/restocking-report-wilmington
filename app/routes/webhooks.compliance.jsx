import { authenticateWebhook } from "../shopify.server";

// Needed because Shopify sends a GET to verify the endpoint during install
export const loader = () => {
  return new Response("OK", { status: 200 });
};

// Handles Shopify POST compliance webhooks
export const action = async ({ request }) => {
  try {
    const { topic, shop } = await authenticateWebhook(request);
    console.log("Received compliance webhook:", topic, "from", shop);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Invalid webhook", { status: 400 });
  }
};
