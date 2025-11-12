import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    await authenticate.webhook(request);
    const body = await request.json();
    console.log("Received compliance webhook:", body);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed compliance webhook:", err);
    return new Response("Unauthorized", { status: 401 });
  }
};
