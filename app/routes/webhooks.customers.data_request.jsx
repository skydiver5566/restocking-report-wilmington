import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  await authenticate.webhook(request);
  console.log("Received customers/data_request webhook");
    return new Response("OK", { status: 200 });
};
