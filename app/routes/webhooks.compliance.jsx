import crypto from "crypto";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // Verify HMAC manually for the automated test
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
    const body = await request.text();
    const secret = process.env.SHOPIFY_API_SECRET;

    const hash = crypto
      .createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("base64");

    if (hash !== hmacHeader) {
      console.error("❌ Invalid HMAC signature");
      return new Response("Unauthorized", { status: 401 });
    }

    // If valid, continue through the usual webhook authentication
    const { topic, shop } = await authenticate.webhook(
      new Request(request.url, { method: request.method, headers: request.headers, body })
    );

    console.log(`✅ Verified HMAC and received ${topic} webhook from ${shop}`);
    console.log("Payload:", body);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Failed to process webhook:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
};
