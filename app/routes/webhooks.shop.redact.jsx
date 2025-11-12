import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  await authenticate.webhook(request);
  console.log("Received shop/redact webhook");
  return new Response("OK", { status: 200 });
};
