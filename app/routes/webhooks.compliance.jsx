import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { topic, shop } = await authenticate.webhook(request);
    const body = await request.json();

    const message = `✅ Received ${topic} webhook from shop ${shop}`;
    console.info(message);
    process.stdout.write(message + "\n"); // ensures log flush in Render

    console.log("Webhook payload:", JSON.stringify(body, null, 2));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Failed compliance webhook:", err);
    process.stdout.write("❌ Failed compliance webhook\n");
    return new Response("Unauthorized", { status: 401 });
  }
};
